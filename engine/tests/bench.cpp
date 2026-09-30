// Soak benchmark: the worst-case full chain (16 voices constantly retriggered
// and stolen, a song playing on top, speed 0.8x, EQ, reverb) for 10 minutes of
// audio, timing every process() call.
// Build and run: engine/test.sh bench [minutes]

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "../src/engine.hpp"

using namespace webrack;

static Engine g_engine;

int main(int argc, char** argv) {
    const double minutes = argc > 1 ? std::atof(argv[1]) : 10.0;
    constexpr float kRate = 48000.0f;
    const double budget_us = kBlockSize / kRate * 1e6;

    Engine& e = g_engine;
    e.init(kRate);
    std::srand(7);
    auto noise = [] { return static_cast<float>(std::rand() % 65536) / 65536.0f - 0.5f; };

    // 16 pads of 2 s noise, every pad on every step at 180 BPM.
    for (std::size_t p = 0; p < kNumPads; ++p) {
        e.pad_begin(p);
        std::generate_n(e.pad_data(p), 96000, noise);
        e.pad_commit(p, 96000);
        for (std::size_t s = 0; s < kNumSteps; ++s) e.set_step(p, s, true);
    }
    // 60 s song, restarted whenever it ends.
    constexpr std::size_t kSongFrames = 60 * 48000;
    std::int16_t* song = e.song_data();
    for (std::size_t i = 0; i < kSongFrames * 2; ++i) song[i] = static_cast<std::int16_t>(noise() * 20000);
    e.song_commit(kSongFrames);
    e.song_set_playing(true);

    e.set_bpm(180);
    e.set_speed(0.8f);
    e.set_eq_gain(0, 4);
    e.set_eq_gain(1, -2);
    e.set_eq_gain(2, 3);
    e.set_reverb(dsp::Reverb::Size, 0.85f);
    e.set_reverb(dsp::Reverb::Mix, 0.35f);
    e.set_playing(true);

    const auto blocks = static_cast<std::size_t>(minutes * 60 * kRate / kBlockSize);
    std::vector<double> us(blocks);
    std::size_t min_voices = kMaxVoices;
    for (std::size_t b = 0; b < blocks; ++b) {
        if (!e.status().song_playing) e.song_set_playing(true);
        const auto t0 = std::chrono::steady_clock::now();
        e.process();
        const auto t1 = std::chrono::steady_clock::now();
        us[b] = std::chrono::duration<double, std::micro>(t1 - t0).count();
        if (b > 1000) min_voices = std::min(min_voices, e.sounding_voices());
    }

    std::vector<double> sorted = us;
    std::sort(sorted.begin(), sorted.end());
    auto pct = [&](double p) { return sorted[static_cast<std::size_t>(p * (sorted.size() - 1))]; };
    const std::size_t over = static_cast<std::size_t>(std::count_if(us.begin(), us.end(), [&](double t) { return t > budget_us; }));

    std::printf("native full chain, %.1f min of audio (%zu blocks), >= %zu voices sounding\n", minutes, blocks, min_voices);
    std::printf("  p50   %7.1f us  (%4.1f%% of %.0f us budget)\n", pct(0.50), 100 * pct(0.50) / budget_us, budget_us);
    std::printf("  p99   %7.1f us  (%4.1f%%)\n", pct(0.99), 100 * pct(0.99) / budget_us);
    std::printf("  p99.9 %7.1f us  (%4.1f%%)\n", pct(0.999), 100 * pct(0.999) / budget_us);
    std::printf("  max   %7.1f us  (%4.1f%%)\n", sorted.back(), 100 * sorted.back() / budget_us);
    std::printf("  blocks over budget: %zu\n", over);
    return 0;
}
