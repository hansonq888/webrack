#include "engine.hpp"

#include <algorithm>
#include <cmath>

namespace webrack {

namespace {

// Transparent below the knee, then a smooth tanh curve toward ±1, so a
// pile-up of 16 voices saturates instead of hard-clipping.
inline float soft_clip(float x) {
    constexpr float kKnee = 0.8f;
    const float a = std::fabs(x);
    if (a <= kKnee) return x;
    const float y = kKnee + (1.0f - kKnee) * std::tanh((a - kKnee) / (1.0f - kKnee));
    return std::copysign(y, x);
}

}  // namespace

void Engine::init(float sample_rate) {
    sample_rate_ = sample_rate;
    now_ = 0;
    speed_ = 1.0f;
    sampler_.reset();
    sequencer_.init(sample_rate);
    song_.attach(song_storage_.data());
    song_.unload();
    eq_.init(sample_rate);
    reverb_.init(sample_rate);
    for (std::size_t p = 0; p < kNumPads; ++p) pads_[p] = {pad_storage_[p].data(), 0};
    status_ = {};
}

void Engine::pad_begin(std::size_t pad) {
    if (pad >= kNumPads) return;
    sampler_.kill_pad(static_cast<std::uint32_t>(pad));
    pads_[pad].length = 0;
}

void Engine::pad_commit(std::size_t pad, std::size_t frames) {
    if (pad >= kNumPads) return;
    pads_[pad].length = static_cast<std::uint32_t>(std::min(frames, kPadCapacityFrames));
}

void Engine::trigger(std::size_t pad, float gain) {
    if (pad >= kNumPads) return;
    sampler_.trigger(static_cast<std::uint32_t>(pad), gain, pads_[pad]);
}

void Engine::song_commit(std::size_t frames) {
    song_.set_length(static_cast<std::uint32_t>(std::min(frames, kSongCapacityFrames)));
}

void Engine::stop_all() {
    sequencer_.set_playing(false, now_);
    song_.set_playing(false);
    sampler_.release_all();
    flush_pending_ = true;
}

void Engine::set_speed(float speed) {
    speed_ = std::clamp(speed, 0.5f, 1.0f);
    sequencer_.set_speed(speed_, now_);
}

void Engine::render_sources(std::size_t begin, std::size_t end) {
    if (begin >= end) return;
    float* left = output_[0].data();
    float* right = output_[1].data();
    sampler_.render(pads_, speed_, left, right, begin, end);
    song_.render(speed_, left, right, begin, end);
}

void Engine::process() {
    float* left = output_[0].data();
    float* right = output_[1].data();
    std::fill(left, left + kBlockSize, 0.0f);
    std::fill(right, right + kBlockSize, 0.0f);

    // Split the block at each sequencer hit so it starts on its exact frame.
    std::array<Sequencer::Hit, Sequencer::kMaxHitsPerBlock> hits;
    const std::size_t num_hits = sequencer_.collect(now_, kBlockSize, hits);
    std::size_t cursor = 0;
    for (std::size_t h = 0; h < num_hits; ++h) {
        render_sources(cursor, hits[h].offset);
        cursor = hits[h].offset;
        for (std::size_t pad = 0; pad < kNumPads; ++pad)
            if (sequencer_.step_on(static_cast<std::uint32_t>(pad), hits[h].step)) trigger(pad);
    }
    render_sources(cursor, kBlockSize);

    eq_.process(left, right, kBlockSize);
    reverb_.process(left, right, kBlockSize);

    // A pending stop_all fades this whole block to zero, then empties the
    // reverb so nothing rings on.
    const float fade_step = flush_pending_ ? 1.0f / static_cast<float>(kBlockSize) : 0.0f;
    float peak_l = 0.0f, peak_r = 0.0f;
    for (std::size_t i = 0; i < kBlockSize; ++i) {
        const float gain = master_gain_ * (1.0f - fade_step * static_cast<float>(i + 1));
        left[i] = soft_clip(left[i] * gain);
        right[i] = soft_clip(right[i] * gain);
        peak_l = std::max(peak_l, std::fabs(left[i]));
        peak_r = std::max(peak_r, std::fabs(right[i]));
    }

    if (flush_pending_) {
        reverb_.clear();
        flush_pending_ = false;
    }

    now_ += static_cast<std::int64_t>(kBlockSize);
    status_.step = sequencer_.playing() ? sequencer_.current_step() : -1;
    status_.seq_playing = sequencer_.playing();
    status_.peak_left = peak_l;
    status_.peak_right = peak_r;
    status_.song_frame = static_cast<std::int32_t>(song_.position());
    status_.song_length = static_cast<std::int32_t>(song_.length());
    status_.song_playing = song_.playing();
    status_.voices = static_cast<std::int32_t>(sampler_.sounding_count());
}

}  // namespace webrack
