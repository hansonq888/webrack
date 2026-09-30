#pragma once

#include <cstddef>
#include <cstring>

namespace webrack::dsp {

// Four floats in one 128-bit register. The GCC/Clang vector extension compiles
// this to WebAssembly SIMD128 (v128 / f32x4) when built with -msimd128, and to
// NEON or SSE natively, so the native tests run the same SIMD code that ships.
using f32x4 = float __attribute__((vector_size(16)));

inline f32x4 splat(float x) { return f32x4{x, x, x, x}; }

// Unaligned load and store (v128.load / v128.store).
inline f32x4 load4(const float* p) {
    f32x4 v;
    std::memcpy(&v, p, sizeof v);
    return v;
}
inline void store4(float* p, f32x4 v) { std::memcpy(p, &v, sizeof v); }

// dst[i] += src[i] for n floats, four at a time.
inline void add_into(float* dst, const float* src, std::size_t n) {
    std::size_t i = 0;
    for (; i + 4 <= n; i += 4) store4(dst + i, load4(dst + i) + load4(src + i));
    for (; i < n; ++i) dst[i] += src[i];
}

}  // namespace webrack::dsp
