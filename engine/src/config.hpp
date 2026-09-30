#pragma once

#include <cstddef>

namespace webrack {

// Audio is processed in fixed 128-frame blocks, the Web Audio render quantum.
inline constexpr std::size_t kBlockSize = 128;
inline constexpr std::size_t kNumChannels = 2;

inline constexpr std::size_t kNumPads = 16;
// Patterns are 16, 32 or 64 steps (1, 2 or 4 bars of sixteenth notes).
inline constexpr std::size_t kMaxSteps = 64;
inline constexpr std::size_t kDefaultSteps = 16;
inline constexpr std::size_t kMaxVoices = 16;

// All sample memory is allocated statically, so wasm memory never grows.
// 10 s per pad at 48 kHz (mono float), 6 min of song at 48 kHz (stereo int16).
inline constexpr std::size_t kPadCapacityFrames = 480'000;
inline constexpr std::size_t kSongCapacityFrames = 17'280'000;

// DSP buffers (reverb, pre-delay) are sized for this; higher rates are clamped.
inline constexpr float kMaxSampleRate = 96'000.0f;

}  // namespace webrack
