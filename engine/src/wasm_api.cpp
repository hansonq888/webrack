// C ABI exported to the AudioWorklet. The worklet instantiates engine.wasm
// directly (no Emscripten JS glue), so every export here is a plain function
// taking and returning numbers; pointers are byte offsets into wasm memory.

#include "engine.hpp"

namespace {
webrack::Engine g_engine;
}

#define WR_EXPORT extern "C" __attribute__((used, visibility("default")))

using webrack::dsp::Reverb;

WR_EXPORT void wr_init(float sample_rate) { g_engine.init(sample_rate); }
WR_EXPORT void wr_process() { g_engine.process(); }
WR_EXPORT float* wr_output(int channel) { return g_engine.out(static_cast<std::size_t>(channel)); }
WR_EXPORT int wr_block_size() { return static_cast<int>(webrack::kBlockSize); }
WR_EXPORT const webrack::Status* wr_status() { return &g_engine.status(); }

WR_EXPORT float* wr_pad_data(int pad) { return g_engine.pad_data(static_cast<std::size_t>(pad)); }
WR_EXPORT int wr_pad_capacity() { return static_cast<int>(webrack::kPadCapacityFrames); }
WR_EXPORT void wr_pad_begin(int pad) { g_engine.pad_begin(static_cast<std::size_t>(pad)); }
WR_EXPORT void wr_pad_commit(int pad, int frames) {
    g_engine.pad_commit(static_cast<std::size_t>(pad), static_cast<std::size_t>(frames));
}
WR_EXPORT void wr_trigger(int pad, float gain) { g_engine.trigger(static_cast<std::size_t>(pad), gain); }

WR_EXPORT void wr_set_step(int pad, int step, int on) {
    g_engine.set_step(static_cast<std::size_t>(pad), static_cast<std::size_t>(step), on != 0);
}
WR_EXPORT void wr_clear_pattern() { g_engine.clear_pattern(); }
WR_EXPORT void wr_set_bpm(float bpm) { g_engine.set_bpm(bpm); }
WR_EXPORT void wr_set_playing(int playing) { g_engine.set_playing(playing != 0); }
WR_EXPORT void wr_stop_after_steps(int steps) { g_engine.stop_after_steps(steps); }

WR_EXPORT std::int16_t* wr_song_data() { return g_engine.song_data(); }
WR_EXPORT int wr_song_capacity() { return static_cast<int>(webrack::kSongCapacityFrames); }
WR_EXPORT void wr_song_begin() { g_engine.song_begin(); }
WR_EXPORT void wr_song_commit(int frames) { g_engine.song_commit(static_cast<std::size_t>(frames)); }
WR_EXPORT void wr_song_set_playing(int playing) { g_engine.song_set_playing(playing != 0); }
WR_EXPORT void wr_song_seek(int frame) { g_engine.song_seek(static_cast<std::size_t>(frame)); }

WR_EXPORT void wr_set_speed(float speed) { g_engine.set_speed(speed); }
WR_EXPORT void wr_set_eq_gain(int band, float db) { g_engine.set_eq_gain(static_cast<std::size_t>(band), db); }
WR_EXPORT void wr_set_reverb(int param, float value) {
    g_engine.set_reverb(static_cast<Reverb::Param>(param), value);
}
WR_EXPORT void wr_set_master_gain(float gain) { g_engine.set_master_gain(gain); }
