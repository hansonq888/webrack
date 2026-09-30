#pragma once

#include <cstdint>

namespace webrack::dsp {

// 4-point, 3rd-order Hermite interpolation. At integer positions it returns
// the sample exactly, so rate 1.0 playback is bit-identical to the source.
// `at(k)` must return 0 outside the sample.
template <typename At>
inline float hermite(At at, double pos) {
    const auto i = static_cast<std::int64_t>(pos);
    const float t = static_cast<float>(pos - static_cast<double>(i));
    const float xm1 = at(i - 1);
    const float x0 = at(i);
    const float x1 = at(i + 1);
    const float x2 = at(i + 2);
    const float c1 = 0.5f * (x1 - xm1);
    const float c2 = xm1 - 2.5f * x0 + 2.0f * x1 - 0.5f * x2;
    const float c3 = 0.5f * (x2 - xm1) + 1.5f * (x0 - x1);
    return ((c3 * t + c2) * t + c1) * t + x0;
}

}  // namespace webrack::dsp
