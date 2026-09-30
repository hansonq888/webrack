#pragma once

#include <cmath>
#include <numbers>

namespace webrack::dsp {

// Coefficients normalized by a0, from Robert Bristow-Johnson's
// "Cookbook formulae for audio EQ biquad filter coefficients".
struct BiquadCoeffs {
    float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;

    enum class Shape { LowShelf, Peak, HighShelf };

    static BiquadCoeffs make(Shape shape, float sample_rate, float freq_hz, float gain_db, float q) {
        const double A = std::pow(10.0, gain_db / 40.0);
        const double w0 = 2.0 * std::numbers::pi * freq_hz / sample_rate;
        const double cw = std::cos(w0);
        const double alpha = std::sin(w0) / (2.0 * q);
        double b0, b1, b2, a0, a1, a2;
        switch (shape) {
            case Shape::Peak:
                b0 = 1 + alpha * A;
                b1 = -2 * cw;
                b2 = 1 - alpha * A;
                a0 = 1 + alpha / A;
                a1 = -2 * cw;
                a2 = 1 - alpha / A;
                break;
            case Shape::LowShelf: {
                const double k = 2 * std::sqrt(A) * alpha;
                b0 = A * ((A + 1) - (A - 1) * cw + k);
                b1 = 2 * A * ((A - 1) - (A + 1) * cw);
                b2 = A * ((A + 1) - (A - 1) * cw - k);
                a0 = (A + 1) + (A - 1) * cw + k;
                a1 = -2 * ((A - 1) + (A + 1) * cw);
                a2 = (A + 1) + (A - 1) * cw - k;
                break;
            }
            case Shape::HighShelf:
            default: {
                const double k = 2 * std::sqrt(A) * alpha;
                b0 = A * ((A + 1) + (A - 1) * cw + k);
                b1 = -2 * A * ((A - 1) + (A + 1) * cw);
                b2 = A * ((A + 1) + (A - 1) * cw - k);
                a0 = (A + 1) - (A - 1) * cw + k;
                a1 = 2 * ((A - 1) - (A + 1) * cw);
                a2 = (A + 1) - (A - 1) * cw - k;
                break;
            }
        }
        return {static_cast<float>(b0 / a0), static_cast<float>(b1 / a0), static_cast<float>(b2 / a0),
                static_cast<float>(a1 / a0), static_cast<float>(a2 / a0)};
    }
};

// Transposed direct form II, one channel.
struct Biquad {
    float z1 = 0, z2 = 0;

    float process(const BiquadCoeffs& c, float x) {
        const float y = c.b0 * x + z1;
        z1 = c.b1 * x - c.a1 * y + z2;
        z2 = c.b2 * x - c.a2 * y;
        return y;
    }
};

}  // namespace webrack::dsp
