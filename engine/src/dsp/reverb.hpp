#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <numbers>

#include "../config.hpp"
#include "simd.hpp"

namespace webrack::dsp {

// Freeverb-style algorithmic reverb (Jezar at Dreampoint, public domain):
// 8 parallel lowpass-feedback combs into 4 series allpasses per channel, with
// the right channel's delays offset for stereo width. In front: a high-pass
// (lows stay dry, so 808s don't turn the tail to mud) and a pre-delay line.
// All buffers are fixed-size members; nothing allocates.
//
// Processing is block-wise: the input stage runs over the block, then each
// comb and allpass runs over the whole block in turn. Every delay line is
// far longer than 4 samples, so four consecutive reads never depend on each
// other's writes, and loads, stores and most of the math run 4 wide (SIMD).
// Per sample the arithmetic is the same as a sample-by-sample loop, so the
// output is identical.
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

    // Cuts the tail: the next block's wet signal fades to zero, then every
    // delay line is emptied. The dry signal passes untouched, so anything new
    // in that block (a fresh downbeat) keeps its attack.
    void flush() { flush_pending_ = true; }

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
        for (std::size_t done = 0; done < n; done += kBlockSize)
            process_block(left + done, right + done, std::min(kBlockSize, n - done));
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

    // Walks n frames of a circular buffer from `index` as contiguous runs (the
    // buffer wraps at most once per run), calling fn(offset, run), then
    // leaves `index` just past the last frame.
    template <typename Fn>
    static void for_each_run(std::size_t& index, std::size_t length, std::size_t n, Fn fn) {
        for (std::size_t offset = 0; offset < n;) {
            const std::size_t run = std::min(n - offset, length - index);
            fn(offset, run);
            offset += run;
            index += run;
            if (index == length) index = 0;
        }
    }

    void process_block(float* left, float* right, std::size_t n) {
        // 1. Input: mono, one-pole high-pass, pre-delay. A recursion, so scalar.
        for (std::size_t i = 0; i < n; ++i) {
            const float mono = (left[i] + right[i]) * kInputGain;
            hp_state_ = hp_coeff_ * (hp_state_ + mono - hp_prev_);
            hp_prev_ = mono;
            predelay_[predelay_write_] = hp_state_;
            std::size_t read = predelay_write_ + kPreDelayCapacity - predelay_frames_;
            if (read >= kPreDelayCapacity) read -= kPreDelayCapacity;
            in_[i] = predelay_[read] + kAntiDenormal;
            if (++predelay_write_ == kPreDelayCapacity) predelay_write_ = 0;
        }

        // 2. The tank: parallel combs summed, then allpasses in series.
        for (std::size_t ch = 0; ch < 2; ++ch) {
            float* wet = wet_[ch].data();
            std::fill(wet, wet + n, 0.0f);
            for (auto& c : combs_[ch]) c.process(in_.data(), wet, n, feedback_, damp_);
            for (auto& a : allpasses_[ch]) a.process(wet, n);
        }

        // 3. Mix, gliding toward the target mix across the block.
        const float mix_step = (mix_target_ - mix_) / static_cast<float>(n);
        for (std::size_t i = 0; i < n; ++i) {
            mix_ += mix_step;
            const float angle = mix_ * (std::numbers::pi_v<float> * 0.5f);
            const float dry_gain = mix_ == 0.0f ? 1.0f : std::cos(angle);
            float wet_gain = mix_ == 0.0f ? 0.0f : std::sin(angle);
            if (flush_pending_) wet_gain *= 1.0f - static_cast<float>(i + 1) / static_cast<float>(n);
            left[i] = left[i] * dry_gain + wet_[0][i] * kWetGain * wet_gain;
            right[i] = right[i] * dry_gain + wet_[1][i] * kWetGain * wet_gain;
        }
        mix_ = mix_target_;
        if (flush_pending_) {
            clear();
            flush_pending_ = false;
        }
    }
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
        // Adds this comb's output for n frames of `in` into `acc`.
        void process(const float* in, float* acc, std::size_t n, float feedback, float damp) {
            for_each_run(index, length, n, [&](std::size_t offset, std::size_t run) {
                float* b = buf.data() + index;
                const float* x = in + offset;
                float* y = acc + offset;
                std::size_t k = 0;
                for (; k + 4 <= run; k += 4) {
                    const f32x4 out = load4(b + k);
                    // The damping low-pass is a recursion: serial through the lanes.
                    f32x4 damped = out * (1.0f - damp);
                    for (int lane = 0; lane < 4; ++lane) damped[lane] = store = damped[lane] + store * damp;
                    store4(b + k, load4(x + k) + damped * feedback);
                    store4(y + k, load4(y + k) + out);
                }
                for (; k < run; ++k) {
                    const float out = b[k];
                    store = out * (1.0f - damp) + store * damp;
                    b[k] = x[k] + store * feedback;
                    y[k] += out;
                }
            });
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
        // In place over n frames.
        void process(float* io, std::size_t n) {
            for_each_run(index, length, n, [&](std::size_t offset, std::size_t run) {
                float* b = buf.data() + index;
                float* x = io + offset;
                std::size_t k = 0;
                for (; k + 4 <= run; k += 4) {
                    const f32x4 delayed = load4(b + k);
                    const f32x4 in = load4(x + k);
                    store4(b + k, in + delayed * 0.5f);
                    store4(x + k, delayed - in);
                }
                for (; k < run; ++k) {
                    const float delayed = b[k];
                    const float in = x[k];
                    b[k] = in + delayed * 0.5f;
                    x[k] = delayed - in;
                }
            });
        }
    };

    std::array<std::array<Comb, kCombs>, 2> combs_{};
    std::array<std::array<Allpass, kAllpasses>, 2> allpasses_{};
    std::array<float, kPreDelayCapacity> predelay_{};
    std::array<float, kBlockSize> in_{};                         // the tank's input, one block
    std::array<std::array<float, kBlockSize>, 2> wet_{};         // the tank's output per channel
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
    bool flush_pending_ = false;
};

}  // namespace webrack::dsp
