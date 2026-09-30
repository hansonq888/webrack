#pragma once

#include <array>
#include <cmath>
#include <cstddef>

#include "biquad.hpp"

namespace webrack::dsp {

// Master 3-band EQ: low shelf, mid peak, high shelf. Gains glide toward their
// targets once per block (coefficients recomputed only while moving), which
// keeps sweeps click-free. With every band at exactly 0 dB it is bypassed,
// so a flat EQ is bit-transparent.
class ThreeBandEq {
public:
    static constexpr std::size_t kBands = 3;
    static constexpr float kMaxGainDb = 12.0f;

    void init(float sample_rate) {
        sample_rate_ = sample_rate;
        for (std::size_t b = 0; b < kBands; ++b) {
            current_db_[b] = target_db_[b] = 0.0f;
            update_coeffs(b);
        }
        for (auto& ch : state_) ch = {};
    }

    void set_gain_db(std::size_t band, float db) {
        if (band >= kBands) return;
        target_db_[band] = std::fmax(-kMaxGainDb, std::fmin(kMaxGainDb, db));
    }

    void process(float* left, float* right, std::size_t n) {
        glide();
        if (bypassed()) return;
        float* channels[2] = {left, right};
        for (std::size_t ch = 0; ch < 2; ++ch) {
            float* x = channels[ch];
            auto& s = state_[ch];
            for (std::size_t i = 0; i < n; ++i) {
                float y = x[i];
                for (std::size_t b = 0; b < kBands; ++b) y = s[b].process(coeffs_[b], y);
                x[i] = y;
            }
        }
    }

private:
    static constexpr float kFreqHz[kBands] = {150.0f, 1000.0f, 6000.0f};
    static constexpr float kQ[kBands] = {0.707f, 0.9f, 0.707f};

    bool bypassed() const {
        for (std::size_t b = 0; b < kBands; ++b)
            if (current_db_[b] != 0.0f) return false;
        return true;
    }

    void glide() {
        for (std::size_t b = 0; b < kBands; ++b) {
            const float diff = target_db_[b] - current_db_[b];
            if (diff == 0.0f) continue;
            // Settles in ~100 ms at 48 kHz; snaps once close enough.
            current_db_[b] = std::fabs(diff) < 0.01f ? target_db_[b] : current_db_[b] + 0.15f * diff;
            update_coeffs(b);
        }
    }

    void update_coeffs(std::size_t b) {
        using Shape = BiquadCoeffs::Shape;
        constexpr Shape kShapes[kBands] = {Shape::LowShelf, Shape::Peak, Shape::HighShelf};
        coeffs_[b] = BiquadCoeffs::make(kShapes[b], sample_rate_, kFreqHz[b], current_db_[b], kQ[b]);
    }

    float sample_rate_ = 48000.0f;
    std::array<float, kBands> target_db_{};
    std::array<float, kBands> current_db_{};
    std::array<BiquadCoeffs, kBands> coeffs_{};
    std::array<std::array<Biquad, kBands>, 2> state_{};
};

}  // namespace webrack::dsp
