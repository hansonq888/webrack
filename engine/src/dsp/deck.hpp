#pragma once

#include <cmath>
#include <cstddef>
#include <numbers>

namespace webrack::dsp {

// "Deck" effects on the master bus: tape-style drive, a DJ filter, and stereo
// width. Each has a neutral setting at which it is skipped entirely, so the
// signal passes bit-for-bit untouched.

// Soft saturation: y = tanh(g x) / g, which is unity for quiet signals and
// rounds off peaks more as the drive rises. drive 0 = bypass.
class Drive {
public:
    void set(float drive) { drive_ = std::fmax(0.0f, std::fmin(1.0f, drive)); }

    void process(float* left, float* right, std::size_t n) const {
        if (drive_ == 0.0f) return;
        const float g = 1.0f + 7.0f * drive_;
        const float inv = 1.0f / g;
        for (std::size_t i = 0; i < n; ++i) {
            left[i] = std::tanh(g * left[i]) * inv;
            right[i] = std::tanh(g * right[i]) * inv;
        }
    }

private:
    float drive_ = 0.0f;
};

// DJ filter: one bipolar knob. Below 0 it is a low-pass sweeping down from
// 20 kHz to 150 Hz; above 0 a high-pass sweeping up from 20 Hz to 3 kHz; at 0
// it is off. A zero-delay-feedback state-variable filter (Andy Simper,
// Cytomic) stays stable and click-free while the cutoff moves every sample,
// which a biquad does not.
class DjFilter {
public:
    void init(float sample_rate) {
        sample_rate_ = sample_rate;
        target_ = position_ = 0.0f;
        reset();
    }

    void set(float position) { target_ = std::fmax(-1.0f, std::fmin(1.0f, position)); }

    void process(float* left, float* right, std::size_t n) {
        if (target_ == 0.0f && position_ == 0.0f) return;
        if (position_ == 0.0f) reset();  // re-entering from off: start clean
        if (target_ == position_) {
            // Knob at rest: one set of coefficients for the whole block.
            const Coeffs c = coeffs(position_);
            for (std::size_t i = 0; i < n; ++i) {
                left[i] = tick(state_[0], c, left[i]);
                right[i] = tick(state_[1], c, right[i]);
            }
            return;
        }
        // Moving: glide the cutoff across the block, sample by sample.
        const float step = (target_ - position_) / static_cast<float>(n);
        for (std::size_t i = 0; i < n; ++i) {
            position_ += step;
            const Coeffs c = coeffs(position_);
            left[i] = tick(state_[0], c, left[i]);
            right[i] = tick(state_[1], c, right[i]);
        }
        position_ = target_;
    }

private:
    struct State {
        float ic1 = 0.0f, ic2 = 0.0f;
    };
    struct Coeffs {
        float a1, a2, a3, k;
        bool highpass;
    };

    static constexpr float kQ = 0.9f;

    void reset() { state_[0] = state_[1] = {}; }

    Coeffs coeffs(float position) const {
        // Exponential sweeps so the knob feels even across the range.
        const bool highpass = position > 0.0f;
        const float amount = std::fabs(position);
        const float cutoff = highpass ? 20.0f * std::pow(150.0f, amount)         // 20 Hz → 3 kHz
                                      : 20000.0f * std::pow(150.0f / 20000.0f, amount);  // 20 kHz → 150 Hz
        const float g = std::tan(std::numbers::pi_v<float> * std::fmin(cutoff, 0.45f * sample_rate_) / sample_rate_);
        const float k = 1.0f / kQ;
        const float a1 = 1.0f / (1.0f + g * (g + k));
        return {a1, g * a1, g * g * a1, k, highpass};
    }

    static float tick(State& s, const Coeffs& c, float v0) {
        const float v3 = v0 - s.ic2;
        const float v1 = c.a1 * s.ic1 + c.a2 * v3;
        const float v2 = s.ic2 + c.a2 * s.ic1 + c.a3 * v3;
        s.ic1 = 2.0f * v1 - s.ic1;
        s.ic2 = 2.0f * v2 - s.ic2;
        return c.highpass ? v0 - c.k * v1 - v2 : v2;
    }

    float sample_rate_ = 48000.0f;
    float target_ = 0.0f;
    float position_ = 0.0f;
    State state_[2];
};

// Stereo width by mid/side: 0 = mono, 1 = as recorded (bypass), up to 1.5.
class Width {
public:
    void set(float width) { width_ = std::fmax(0.0f, std::fmin(1.5f, width)); }

    void process(float* left, float* right, std::size_t n) const {
        if (width_ == 1.0f) return;
        for (std::size_t i = 0; i < n; ++i) {
            const float mid = 0.5f * (left[i] + right[i]);
            const float side = 0.5f * (left[i] - right[i]) * width_;
            left[i] = mid + side;
            right[i] = mid - side;
        }
    }

private:
    float width_ = 1.0f;
};

}  // namespace webrack::dsp
