#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "config.hpp"
#include "dsp/interp.hpp"
#include "dsp/simd.hpp"

namespace webrack {

// A pad's audio: mono float frames at the engine's sample rate.
struct PadSample {
    const float* data = nullptr;
    std::uint32_t length = 0;  // 0 = empty pad
};

// One-shot sample voices. Each pad chokes itself: a new hit on a pad fades out
// that pad's previous voice, so fast repeats stutter instead of piling up
// (different pads still layer). At most kMaxVoices sound at once; a hit beyond
// that steals the oldest voice. Choked and stolen voices fade out over ~1.3 ms
// instead of being cut (no click); spare slots hold them while they fade.
class Sampler {
public:
    void reset() {
        for (auto& v : voices_) v = {};
        clock_ = 0;
    }

    void trigger(std::uint32_t pad, float gain, const PadSample& sample) {
        if (sample.length == 0) return;
        for (auto& v : voices_)
            if (v.active && v.pad == pad && v.fade_step == 0.0f) v.fade_step = kFadeStep;
        if (sounding_count() >= kMaxVoices) {
            if (Voice* oldest = oldest_sounding()) oldest->fade_step = kFadeStep;
        }
        Voice* v = free_slot();
        *v = Voice{};
        v->active = true;
        v->pad = pad;
        v->gain = gain;
        v->age = ++clock_;
    }

    // Fades out every sounding voice (~1.3 ms, no click).
    void release_all() {
        for (auto& v : voices_)
            if (v.active && v.fade_step == 0.0f) v.fade_step = kFadeStep;
    }

    // Immediately silences every voice on a pad (before its data is replaced).
    void kill_pad(std::uint32_t pad) {
        for (auto& v : voices_)
            if (v.active && v.pad == pad) v.active = false;
    }

    // Adds voices into left/right over [begin, end) at playback `rate`. Voices
    // are mono, so they sum into one buffer that is then added to both sides.
    void render(const std::array<PadSample, kNumPads>& pads, double rate, float* left, float* right,
                std::size_t begin, std::size_t end) {
        const std::size_t n = end - begin;
        std::array<float, kBlockSize> mono{};
        bool any = false;
        for (auto& v : voices_) {
            if (!v.active) continue;
            any = true;
            render_voice(v, pads[v.pad], rate, mono.data(), n);
        }
        if (!any) return;
        dsp::add_into(left + begin, mono.data(), n);
        dsp::add_into(right + begin, mono.data(), n);
    }

    std::size_t sounding_count() const {
        std::size_t n = 0;
        for (const auto& v : voices_) n += v.active && v.fade_step == 0.0f;
        return n;
    }

private:
    static constexpr std::size_t kSlots = kMaxVoices + 8;
    static constexpr float kFadeStep = 1.0f / 64.0f;

    struct Voice {
        bool active = false;
        std::uint32_t pad = 0;
        std::uint32_t age = 0;
        double pos = 0.0;
        float gain = 1.0f;
        float fade = 1.0f;
        float fade_step = 0.0f;
    };

    // One voice into `out` for n frames.
    //
    // Fast path (SIMD): a voice that isn't fading and whose reads over the
    // whole span stay inside the sample, so there are no bounds checks and no
    // chance of it ending mid-span. Four output frames at a time: the four
    // read positions are gathered into vector lanes, and the Hermite
    // polynomial runs as f32x4 math. Positions still advance one frame at a
    // time in double, exactly as the scalar path does, so both paths produce
    // the same numbers.
    //
    // Everything else (fades, the first and last few frames of a sample) takes
    // the scalar path.
    static void render_voice(Voice& v, const PadSample& s, double rate, float* out, std::size_t n) {
        std::size_t i = 0;
        const double last_pos = v.pos + rate * static_cast<double>(n > 0 ? n - 1 : 0);
        const bool fast = v.fade_step == 0.0f && v.pos >= 1.0 &&
                          static_cast<std::int64_t>(last_pos) + 2 < static_cast<std::int64_t>(s.length);
        if (fast) {
            const float* d = s.data;
            const dsp::f32x4 gain = dsp::splat(v.gain * v.fade);
            for (; i + 4 <= n; i += 4) {
                dsp::f32x4 xm1, x0, x1, x2, t;
                for (int k = 0; k < 4; ++k) {
                    const auto j = static_cast<std::int64_t>(v.pos);
                    t[k] = static_cast<float>(v.pos - static_cast<double>(j));
                    xm1[k] = d[j - 1];
                    x0[k] = d[j];
                    x1[k] = d[j + 1];
                    x2[k] = d[j + 2];
                    v.pos += rate;
                }
                dsp::store4(&out[i], dsp::load4(&out[i]) + dsp::hermite_poly(xm1, x0, x1, x2, t) * gain);
            }
        }
        const auto at = [&s](std::int64_t k) {
            return k >= 0 && k < static_cast<std::int64_t>(s.length) ? s.data[k] : 0.0f;
        };
        for (; i < n; ++i) {
            out[i] += dsp::hermite(at, v.pos) * v.gain * v.fade;
            v.pos += rate;
            if (v.fade_step != 0.0f) v.fade -= v.fade_step;
            if (v.pos >= s.length || v.fade <= 0.0f) {
                v.active = false;
                break;
            }
        }
    }

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
