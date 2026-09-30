#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "config.hpp"
#include "dsp/interp.hpp"

namespace webrack {

// A pad's audio: mono float frames at the engine's sample rate.
struct PadSample {
    const float* data = nullptr;
    std::uint32_t length = 0;  // 0 = empty pad
};

// One-shot sample voices. At most kMaxVoices sound at once; a new hit beyond
// that steals the oldest voice, which fades out over ~1.3 ms instead of being
// cut (no click). Spare slots hold those fading voices.
class Sampler {
public:
    void reset() {
        for (auto& v : voices_) v = {};
        clock_ = 0;
    }

    void trigger(std::uint32_t pad, float gain, const PadSample& sample) {
        if (sample.length == 0) return;
        if (sounding_count() >= kMaxVoices) {
            if (Voice* oldest = oldest_sounding()) oldest->fade_step = kStealFadeStep;
        }
        Voice* v = free_slot();
        *v = Voice{};
        v->active = true;
        v->pad = pad;
        v->gain = gain;
        v->age = ++clock_;
    }

    // Immediately silences every voice on a pad (before its data is replaced).
    void kill_pad(std::uint32_t pad) {
        for (auto& v : voices_)
            if (v.active && v.pad == pad) v.active = false;
    }

    // Adds voices into left/right over [begin, end) at playback `rate`.
    void render(const std::array<PadSample, kNumPads>& pads, double rate, float* left, float* right,
                std::size_t begin, std::size_t end) {
        for (auto& v : voices_) {
            if (!v.active) continue;
            const PadSample& s = pads[v.pad];
            const auto at = [&s](std::int64_t k) {
                return k >= 0 && k < static_cast<std::int64_t>(s.length) ? s.data[k] : 0.0f;
            };
            for (std::size_t i = begin; i < end; ++i) {
                const float x = dsp::hermite(at, v.pos) * v.gain * v.fade;
                left[i] += x;
                right[i] += x;
                v.pos += rate;
                if (v.fade_step != 0.0f) v.fade -= v.fade_step;
                if (v.pos >= s.length || v.fade <= 0.0f) {
                    v.active = false;
                    break;
                }
            }
        }
    }

    std::size_t sounding_count() const {
        std::size_t n = 0;
        for (const auto& v : voices_) n += v.active && v.fade_step == 0.0f;
        return n;
    }

private:
    static constexpr std::size_t kSlots = kMaxVoices + 8;
    static constexpr float kStealFadeStep = 1.0f / 64.0f;

    struct Voice {
        bool active = false;
        std::uint32_t pad = 0;
        std::uint32_t age = 0;
        double pos = 0.0;
        float gain = 1.0f;
        float fade = 1.0f;
        float fade_step = 0.0f;
    };

    Voice* oldest_sounding() {
        Voice* oldest = nullptr;
        for (auto& v : voices_)
            if (v.active && v.fade_step == 0.0f && (!oldest || v.age < oldest->age)) oldest = &v;
        return oldest;
    }

    // An inactive slot, or failing that (every spare is mid-fade) the quietest
    // fading voice.
    Voice* free_slot() {
        Voice* quietest = &voices_[0];
        for (auto& v : voices_) {
            if (!v.active) return &v;
            if (v.fade_step != 0.0f && v.fade < quietest->fade) quietest = &v;
        }
        return quietest;
    }

    std::array<Voice, kSlots> voices_{};
    std::uint32_t clock_ = 0;
};

}  // namespace webrack
