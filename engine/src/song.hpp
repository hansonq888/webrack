#pragma once

#include <cstddef>
#include <cstdint>

#include "dsp/interp.hpp"

namespace webrack {

// Plays a stereo song (interleaved int16) at a variable rate: varispeed, so
// pitch follows speed like a record slowed down.
class SongPlayer {
public:
    void attach(const std::int16_t* data) { data_ = data; }

    void set_length(std::uint32_t frames) {
        length_ = frames;
        pos_ = 0.0;
        playing_ = false;
    }
    void unload() { set_length(0); }
    void set_playing(bool playing) { playing_ = playing && length_ > 0; }
    void seek(std::uint32_t frame) { pos_ = frame < length_ ? frame : 0; }

    bool playing() const { return playing_; }
    std::uint32_t position() const { return static_cast<std::uint32_t>(pos_); }
    std::uint32_t length() const { return length_; }

    // Adds into left/right over [begin, end).
    void render(double rate, float* left, float* right, std::size_t begin, std::size_t end) {
        if (!playing_) return;
        const auto len = static_cast<std::int64_t>(length_);
        constexpr float kScale = 1.0f / 32768.0f;
        const auto at_l = [&](std::int64_t k) { return k >= 0 && k < len ? data_[2 * k] * kScale : 0.0f; };
        const auto at_r = [&](std::int64_t k) { return k >= 0 && k < len ? data_[2 * k + 1] * kScale : 0.0f; };
        for (std::size_t i = begin; i < end; ++i) {
            left[i] += dsp::hermite(at_l, pos_);
            right[i] += dsp::hermite(at_r, pos_);
            pos_ += rate;
            if (pos_ >= static_cast<double>(length_)) {
                playing_ = false;
                pos_ = 0.0;
                return;
            }
        }
    }

private:
    const std::int16_t* data_ = nullptr;
    std::uint32_t length_ = 0;
    double pos_ = 0.0;
    bool playing_ = false;
};

}  // namespace webrack
