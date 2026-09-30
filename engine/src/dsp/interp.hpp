#pragma once

#include <cstdint>

namespace webrack::dsp {

// 4-point, 3rd-order Hermite polynomial through xm1, x0, x1, x2, evaluated at
// fraction t in [0, 1) between x0 and x1. Generic over the value type, so the
// same math serves one sample (float) or four at once (f32x4).
template <typename T>
inline T hermite_poly(T xm1, T x0, T x1, T x2, T t) {
    const T c1 = 0.5f * (x1 - xm1);
    const T c2 = xm1 - 2.5f * x0 + 2.0f * x1 - 0.5f * x2;
    const T c3 = 0.5f * (x2 - xm1) + 1.5f * (x0 - x1);
    return ((c3 * t + c2) * t + c1) * t + x0;
}

// Hermite interpolation of a sample at fractional position `pos`. At integer
// positions it returns the sample exactly, so rate 1.0 playback is
// bit-identical to the source. `at(k)` must return 0 outside the sample.
template <typename At>
inline float hermite(At at, double pos) {
    const auto i = static_cast<std::int64_t>(pos);
    const float t = static_cast<float>(pos - static_cast<double>(i));
    return hermite_poly(at(i - 1), at(i), at(i + 1), at(i + 2), t);
}

}  // namespace webrack::dsp
