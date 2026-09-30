#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "config.hpp"
#include "dsp/eq.hpp"
#include "dsp/reverb.hpp"
#include "sampler.hpp"
#include "sequencer.hpp"
#include "song.hpp"

namespace webrack {

// Snapshot the UI reads after every block (playhead, meters).
struct Status {
    std::int32_t step = -1;
    std::int32_t seq_playing = 0;
    float peak_left = 0.0f;
    float peak_right = 0.0f;
    std::int32_t song_frame = 0;
    std::int32_t song_length = 0;
    std::int32_t song_playing = 0;
    std::int32_t voices = 0;
};

// The whole engine. Signal chain:
//   pads (sampler, sequencer) + song → speed → EQ → reverb → master → out
// Everything is a fixed-size member and the engine is a single static object,
// so nothing on the audio path allocates, locks, or calls into the host.
class Engine {
public:
    void init(float sample_rate);

    // Renders one kBlockSize block into out(0) and out(1).
    void process();
    float* out(std::size_t channel) { return output_[channel].data(); }
    const Status& status() const { return status_; }
    std::int64_t frame() const { return now_; }

    // Pads. To replace a pad's audio: pad_begin (silences it), write up to
    // kPadCapacityFrames into pad_data, then pad_commit with the length.
    float* pad_data(std::size_t pad) { return pad_storage_[pad].data(); }
    void pad_begin(std::size_t pad);
    void pad_commit(std::size_t pad, std::size_t frames);
    void trigger(std::size_t pad, float gain = 1.0f);

    // Sequencer.
    void set_step(std::size_t pad, std::size_t step, bool on) {
        sequencer_.set_step(static_cast<std::uint32_t>(pad), static_cast<std::uint32_t>(step), on);
    }
    void clear_pattern() { sequencer_.clear(); }
    void set_bpm(float bpm) { sequencer_.set_bpm(bpm, now_); }
    void set_playing(bool playing) { sequencer_.set_playing(playing, now_); }
    void stop_after_steps(std::int64_t steps) { sequencer_.stop_after(steps); }

    // Silence everything, e.g. before recording from the mic: stops the
    // sequencer and song, fades out every voice, and flushes the reverb tail
    // after fading the next block to zero. Output is silent from the block after.
    void stop_all();
    void set_pattern_length(std::size_t steps) { sequencer_.set_length(static_cast<std::uint32_t>(steps)); }

    // Song. Same begin / write / commit protocol as pads, interleaved stereo.
    std::int16_t* song_data() { return song_storage_.data(); }
    void song_begin() { song_.unload(); }
    void song_commit(std::size_t frames);
    void song_set_playing(bool playing) { song_.set_playing(playing); }
    void song_seek(std::size_t frame) { song_.seek(static_cast<std::uint32_t>(frame)); }

    // Vibe: speed (0.5–1.0, tape-style), EQ, reverb.
    void set_speed(float speed);
    void set_eq_gain(std::size_t band, float db) { eq_.set_gain_db(band, db); }
    void set_reverb(dsp::Reverb::Param param, float value) { reverb_.set(param, value); }
    void set_master_gain(float gain) { master_gain_ = gain; }

    std::size_t sounding_voices() const { return sampler_.sounding_count(); }

private:
    void render_sources(std::size_t begin, std::size_t end);

    float sample_rate_ = 48000.0f;
    std::int64_t now_ = 0;
    float speed_ = 1.0f;
    float master_gain_ = 0.8f;
    bool flush_pending_ = false;

    Sampler sampler_;
    Sequencer sequencer_;
    SongPlayer song_;
    dsp::ThreeBandEq eq_;
    dsp::Reverb reverb_;
    Status status_;

    std::array<PadSample, kNumPads> pads_{};
    std::array<std::array<float, kBlockSize>, kNumChannels> output_{};
    std::array<std::array<float, kPadCapacityFrames>, kNumPads> pad_storage_{};
    std::array<std::int16_t, kSongCapacityFrames * 2> song_storage_{};
};

}  // namespace webrack
