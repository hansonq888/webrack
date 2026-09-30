#pragma once

#include <array>
#include <cmath>
#include <cstddef>
#include <numbers>

#include "../config.hpp"

namespace webrack::dsp {

// Freeverb-style algorithmic reverb (Jezar at Dreampoint, public domain):
// 8 parallel lowpass-feedback combs into 4 series allpasses per channel, with
// the right channel's delays offset for stereo width. In front: a high-pass
// (lows stay dry, so 808s don't turn the tail to mud) and a pre-delay line.
// All buffers are fixed-size members; nothing allocates.
class Reverb {
public:
    enum Param { Size = 0, Damping = 1, PreDelayMs = 2, Mix = 3 };

    void init(float sample_rate) {
        const float sr = std::fmin(sample_rate, kMaxSampleRate);
        const float scale = sr / 44100.0f;
        for (std::size_t ch = 0; ch < 2; ++ch) {
            const std::size_t spread = ch == 0 ? 0 : kStereoSpread;
            for (std::size_t i = 0; i < kCombs; ++i) combs_[ch][i].init(scaled(kCombTuning[i] + spread, scale));
            for (std::size_t i = 0; i < kAllpasses; ++i)
                allpasses_[ch][i].init(scaled(kAllpassTuning[i] + spread, scale));
        }
        sample_rate_ = sr;
        hp_coeff_ = std::exp(-2.0f * std::numbers::pi_v<float> * kInputHighPassHz / sr);
        hp_state_ = 0.0f;
        hp_prev_ = 0.0f;
        predelay_.fill(0.0f);
        predelay_write_ = 0;
        set(Size, 0.7f);
        set(Damping, 0.5f);
        set(PreDelayMs, 20.0f);
        set(Mix, 0.0f);
        mix_ = mix_target_;
    }

    // Empties every delay line (the tail stops). The caller fades the output
    // first so this doesn't click.
    void clear() {
        for (auto& channel : combs_)
            for (auto& c : channel) c.init(c.length);
        for (auto& channel : allpasses_)
            for (auto& a : channel) a.init(a.length);
        predelay_.fill(0.0f);
        hp_state_ = hp_prev_ = 0.0f;
    }

    void set(Param param, float value) {
        switch (param) {
            case Size: feedback_ = 0.7f + 0.28f * clamp01(value); break;
            case Damping: damp_ = 0.4f * clamp01(value); break;
            case PreDelayMs: {
                const float ms = std::fmax(0.0f, std::fmin(kMaxPreDelayMs, value));
                predelay_frames_ = static_cast<std::size_t>(ms * 0.001f * sample_rate_);
                break;
            }
            case Mix: mix_target_ = clamp01(value); break;
        }
    }

    // In place. Equal-power dry/wet: at mix 0 the output is exactly the input.
    void process(float* left, float* right, std::size_t n) {
        const float mix_step = (mix_target_ - mix_) / static_cast<float>(n);
        for (std::size_t i = 0; i < n; ++i) {
            // High-pass (one-pole) and pre-delay the mono input.
            const float mono = (left[i] + right[i]) * kInputGain;
            hp_state_ = hp_coeff_ * (hp_state_ + mono - hp_prev_);
            hp_prev_ = mono;
            predelay_[predelay_write_] = hp_state_;
            std::size_t read = predelay_write_ + kPreDelayCapacity - predelay_frames_;
            if (read >= kPreDelayCapacity) read -= kPreDelayCapacity;
            const float in = predelay_[read] + kAntiDenormal;
            if (++predelay_write_ == kPreDelayCapacity) predelay_write_ = 0;

            float wet[2];
            for (std::size_t ch = 0; ch < 2; ++ch) {
                float acc = 0.0f;
                for (auto& c : combs_[ch]) acc += c.process(in, feedback_, damp_);
                for (auto& a : allpasses_[ch]) acc = a.process(acc);
                wet[ch] = acc * kWetGain;
            }

            mix_ += mix_step;
            const float angle = mix_ * (std::numbers::pi_v<float> * 0.5f);
            const float dry_gain = mix_ == 0.0f ? 1.0f : std::cos(angle);
            const float wet_gain = mix_ == 0.0f ? 0.0f : std::sin(angle);
            left[i] = left[i] * dry_gain + wet[0] * wet_gain;
            right[i] = right[i] * dry_gain + wet[1] * wet_gain;
        }
        mix_ = mix_target_;
    }

private:
    static constexpr std::size_t kCombs = 8;
    static constexpr std::size_t kAllpasses = 4;
    static constexpr std::size_t kCombTuning[kCombs] = {1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617};
    static constexpr std::size_t kAllpassTuning[kAllpasses] = {556, 441, 341, 225};
    static constexpr std::size_t kStereoSpread = 23;
    static constexpr std::size_t kCombCapacity = 4096;     // > (1617 + 23) * 96k / 44.1k
    static constexpr std::size_t kAllpassCapacity = 2048;  // > (556 + 23) * 96k / 44.1k
    static constexpr float kMaxPreDelayMs = 200.0f;
    static constexpr std::size_t kPreDelayCapacity = 20'000;  // > 200 ms at 96 kHz
    static constexpr float kInputGain = 0.015f;
    static constexpr float kInputHighPassHz = 220.0f;
    // Freeverb scales wet by 3 but its wet control tops out at 1/3; our mix goes to 1.
    static constexpr float kWetGain = 1.0f;
    static constexpr float kAntiDenormal = 1e-18f;

    static float clamp01(float v) { return std::fmax(0.0f, std::fmin(1.0f, v)); }
    static std::size_t scaled(std::size_t tuning, float scale) {
        return static_cast<std::size_t>(static_cast<float>(tuning) * scale);
    }

    struct Comb {
        std::array<float, kCombCapacity> buf{};
        std::size_t length = 1, index = 0;
        float store = 0.0f;

        void init(std::size_t len) {
            length = len;
            index = 0;
            store = 0.0f;
            buf.fill(0.0f);
        }
        float process(float in, float feedback, float damp) {
            const float out = buf[index];
            store = out * (1.0f - damp) + store * damp;
            buf[index] = in + store * feedback;
            if (++index == length) index = 0;
            return out;
        }
    };

    struct Allpass {
        std::array<float, kAllpassCapacity> buf{};
        std::size_t length = 1, index = 0;

        void init(std::size_t len) {
            length = len;
            index = 0;
            buf.fill(0.0f);
        }
        float process(float in) {
            const float delayed = buf[index];
            buf[index] = in + delayed * 0.5f;
            if (++index == length) index = 0;
            return delayed - in;
        }
    };

    std::array<std::array<Comb, kCombs>, 2> combs_{};
    std::array<std::array<Allpass, kAllpasses>, 2> allpasses_{};
    std::array<float, kPreDelayCapacity> predelay_{};
    std::size_t predelay_write_ = 0;
    std::size_t predelay_frames_ = 0;
    float sample_rate_ = 48000.0f;
    float hp_coeff_ = 0.97f;
    float hp_state_ = 0.0f;
    float hp_prev_ = 0.0f;
    float feedback_ = 0.84f;
    float damp_ = 0.2f;
    float mix_ = 0.0f;
    float mix_target_ = 0.0f;
};

}  // namespace webrack::dsp
