#pragma once

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>

#include "config.hpp"

namespace webrack {

// 16-step, 16-pad pattern sequencer, clocked in samples by the engine.
//
// Step k fires at frame anchor_frame + round((k - anchor_step) * step_frames),
// computed from integers each time rather than accumulated, so hits never
// drift: at a fixed tempo every hit lands on the exact sample. A tempo or
// speed change re-anchors on the pending step, scaling the time left to it.
class Sequencer {
public:
    struct Hit {
        std::uint32_t offset;  // frame within the block
        std::uint32_t step;    // 0..15
    };
    static constexpr std::size_t kMaxHitsPerBlock = 4;

    void init(float sample_rate) {
        sample_rate_ = sample_rate;
        playing_ = false;
        current_step_ = -1;
        pattern_.fill(0);
        update_step_frames();
    }

    void set_step(std::uint32_t pad, std::uint32_t step, bool on) {
        if (pad >= kNumPads || step >= kNumSteps) return;
        const auto bit = static_cast<std::uint16_t>(1u << step);
        pattern_[pad] = on ? (pattern_[pad] | bit) : (pattern_[pad] & ~bit);
    }
    void clear() { pattern_.fill(0); }
    bool step_on(std::uint32_t pad, std::uint32_t step) const { return (pattern_[pad] >> step) & 1u; }

    void set_bpm(float bpm, std::int64_t now) {
        bpm_ = std::fmax(kMinBpm, std::fmin(kMaxBpm, bpm));
        retime(now);
    }
    void set_speed(float speed, std::int64_t now) {
        speed_ = speed;
        retime(now);
    }

    // Starts from step 0 at `now`, or stops. Clears any step limit.
    void set_playing(bool playing, std::int64_t now) {
        playing_ = playing;
        stop_after_ = -1;
        current_step_ = -1;
        anchor_frame_ = now;
        anchor_step_ = 0;
        next_step_ = 0;
    }
    // Stops by itself once `steps` steps have played (for exporting N loops).
    void stop_after(std::int64_t steps) { stop_after_ = steps; }
    bool playing() const { return playing_; }
    std::int32_t current_step() const { return current_step_; }
    double step_frames() const { return step_frames_; }

    // Hits falling in [now, now + frames), in order.
    std::size_t collect(std::int64_t now, std::size_t frames, std::array<Hit, kMaxHitsPerBlock>& out) {
        std::size_t n = 0;
        if (!playing_) return 0;
        const std::int64_t end = now + static_cast<std::int64_t>(frames);
        for (std::int64_t t = frame_of(next_step_); t < end && n < out.size(); t = frame_of(next_step_)) {
            if (stop_after_ >= 0 && next_step_ >= stop_after_) {
                playing_ = false;
                break;
            }
            const auto step = static_cast<std::uint32_t>(next_step_ % kNumSteps);
            out[n++] = {static_cast<std::uint32_t>(t < now ? 0 : t - now), step};
            current_step_ = static_cast<std::int32_t>(step);
            ++next_step_;
        }
        return n;
    }

private:
    static constexpr float kMinBpm = 60.0f;
    static constexpr float kMaxBpm = 180.0f;

    std::int64_t frame_of(std::int64_t step) const {
        return anchor_frame_ + std::llround(static_cast<double>(step - anchor_step_) * step_frames_);
    }

    void update_step_frames() {
        // Sixteenth notes; slower speed stretches time like a tape slowing down.
        step_frames_ = static_cast<double>(sample_rate_) * 60.0 / bpm_ / 4.0 / speed_;
    }

    void retime(std::int64_t now) {
        if (!playing_) {
            update_step_frames();
            return;
        }
        const double left = static_cast<double>(frame_of(next_step_) - now);
        const double old_frames = step_frames_;
        update_step_frames();
        anchor_frame_ = now + std::llround(std::fmax(0.0, left) * step_frames_ / old_frames);
        anchor_step_ = next_step_;
    }

    std::array<std::uint16_t, kNumPads> pattern_{};
    float sample_rate_ = 48000.0f;
    float bpm_ = 90.0f;
    float speed_ = 1.0f;
    double step_frames_ = 8000.0;
    bool playing_ = false;
    std::int64_t anchor_frame_ = 0;
    std::int64_t anchor_step_ = 0;
    std::int64_t next_step_ = 0;
    std::int64_t stop_after_ = -1;
    std::int32_t current_step_ = -1;
};

}  // namespace webrack
