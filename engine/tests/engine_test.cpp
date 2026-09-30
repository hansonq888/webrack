// Native tests for the engine (same C++ as the wasm build).
// Build and run: engine/test.sh

#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <vector>

#include "../src/engine.hpp"

using namespace webrack;

// Counts every heap allocation, to prove process() never allocates.
static std::atomic<long> g_allocations{0};
void* operator new(std::size_t n) {
    ++g_allocations;
    if (void* p = std::malloc(n)) return p;
    throw std::bad_alloc();
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }

static int g_failures = 0;
#define CHECK(cond, ...)                                     \
    do {                                                     \
        if (!(cond)) {                                       \
            ++g_failures;                                    \
            std::printf("  FAIL %s:%d: ", __FILE__, __LINE__); \
            std::printf(__VA_ARGS__);                        \
            std::printf("\n");                               \
        }                                                    \
    } while (0)

static Engine g_engine;  // ~100 MB of static sample storage

static constexpr float kRate = 48000.0f;

static void load_pad(Engine& e, std::size_t pad, const std::vector<float>& frames) {
    e.pad_begin(pad);
    std::copy(frames.begin(), frames.end(), e.pad_data(pad));
    e.pad_commit(pad, frames.size());
}

// Renders `blocks` blocks of the left channel.
static std::vector<float> render(Engine& e, std::size_t blocks) {
    std::vector<float> out;
    out.reserve(blocks * kBlockSize);
    for (std::size_t b = 0; b < blocks; ++b) {
        e.process();
        out.insert(out.end(), e.out(0), e.out(0) + kBlockSize);
    }
    return out;
}

// Every sequencer hit must land on exactly round(k * step_frames), for tempos
// whose step length isn't a whole number of frames, at 1.0x and slowed.
static void test_sequencer_is_sample_accurate() {
    std::printf("sequencer timing jitter\n");
    for (float bpm : {97.0f, 120.0f, 173.0f}) {
        for (float speed : {1.0f, 0.8f, 0.5f}) {
            Engine& e = g_engine;
            e.init(kRate);
            load_pad(e, 0, {1.0f});  // a single-sample impulse
            for (std::size_t s = 0; s < kDefaultSteps; ++s) e.set_step(0, s, true);
            e.set_bpm(bpm);
            e.set_speed(speed);
            e.set_playing(true);

            const auto out = render(e, static_cast<std::size_t>(20 * kRate / kBlockSize));
            const double step_frames = kRate * 60.0 / bpm / 4.0 / speed;
            std::size_t hits = 0, misplaced = 0;
            // At speeds below 1.0 the impulse is interpolated over a couple of
            // samples, so count onsets (first non-zero sample after silence).
            for (std::size_t i = 0; i < out.size(); ++i) {
                if (out[i] == 0.0f || (i > 0 && out[i - 1] != 0.0f)) continue;
                const auto expected = static_cast<std::size_t>(std::llround(static_cast<double>(hits) * step_frames));
                if (i != expected) ++misplaced;
                ++hits;
            }
            std::size_t expected_hits = 0;
            while (static_cast<std::size_t>(std::llround(static_cast<double>(expected_hits) * step_frames)) < out.size())
                ++expected_hits;
            CHECK(misplaced == 0, "bpm %.0f speed %.1f: %zu of %zu hits off their sample", bpm, speed, misplaced, hits);
            CHECK(hits == expected_hits, "bpm %.0f speed %.1f: %zu hits, expected %zu", bpm, speed, hits, expected_hits);
        }
    }
}

// Mix at 0% must be bit-identical to the dry signal.
static void test_reverb_mix_zero_is_bypass() {
    std::printf("reverb mix 0 == bypass\n");
    Engine& e = g_engine;
    e.init(kRate);
    std::vector<float> noise(24000);
    std::srand(1);
    for (auto& x : noise) x = (static_cast<float>(std::rand() % 65536) / 65536.0f - 0.5f);  // within ±0.5
    load_pad(e, 0, noise);
    e.set_reverb(dsp::Reverb::Size, 0.9f);
    e.set_reverb(dsp::Reverb::Mix, 0.0f);
    e.set_master_gain(1.0f);
    e.trigger(0);
    const auto out = render(e, noise.size() / kBlockSize);
    std::size_t diffs = 0;
    for (std::size_t i = 0; i < out.size(); ++i) diffs += out[i] != noise[i];
    CHECK(diffs == 0, "%zu samples differ from dry", diffs);
}

static void test_polyphony_and_stealing() {
    std::printf("polyphony: 16 pads layer, a 17th voice steals\n");
    Engine& e = g_engine;
    e.init(kRate);
    for (std::size_t p = 0; p < kNumPads; ++p) load_pad(e, p, std::vector<float>(48000, 0.01f));
    for (std::size_t p = 0; p < kNumPads; ++p) e.trigger(p);
    e.process();
    CHECK(e.sounding_voices() == 16, "expected 16 voices, got %zu", e.sounding_voices());
    e.trigger(0);  // chokes pad 0's own voice rather than stealing another pad's
    CHECK(e.sounding_voices() == 16, "after a 17th hit expected 16 sounding, got %zu", e.sounding_voices());
    e.process();  // the choked voice fades out within this block
    CHECK(e.sounding_voices() == 16, "after the fade expected 16 voices, got %zu", e.sounding_voices());
}

// A repeat hit on the same pad cuts the previous one (with a short fade)
// instead of layering on top of it.
static void test_retrigger_chokes_same_pad() {
    std::printf("retriggering a pad chokes its previous hit\n");
    Engine& e = g_engine;
    e.init(kRate);
    e.set_master_gain(1.0f);
    load_pad(e, 0, std::vector<float>(48000, 0.25f));
    e.trigger(0);
    e.process();
    e.trigger(0);
    e.process();
    CHECK(e.sounding_voices() == 1, "expected 1 voice after a retrigger, got %zu", e.sounding_voices());
    // Once the fade is over, the output is one voice's level, not two stacked.
    e.process();
    const float level = e.out(0)[kBlockSize - 1];
    CHECK(std::fabs(level - 0.25f) < 1e-6f, "retriggered level %f, expected a single voice at 0.25", level);
}

// Longer patterns: only the last step is set, so it must fire once per loop.
static void test_longer_patterns() {
    std::printf("32- and 64-step patterns\n");
    for (std::size_t length : {32u, 64u}) {
        Engine& e = g_engine;
        e.init(kRate);
        load_pad(e, 0, {1.0f});
        e.set_pattern_length(length);
        e.set_step(0, length - 1, true);
        e.set_bpm(120);  // 6000 frames per step at 48 kHz
        e.set_playing(true);
        const auto out = render(e, 2 * length * 6000 / kBlockSize + 1);
        std::vector<std::size_t> hits;
        for (std::size_t i = 0; i < out.size(); ++i)
            if (out[i] != 0.0f) hits.push_back(i);
        const std::size_t first = (length - 1) * 6000;
        CHECK(hits.size() == 2 && hits[0] == first && hits[1] == first + length * 6000,
              "%zu steps: expected hits at %zu and %zu, got %zu hits (first at %zu)", length, first,
              first + length * 6000, hits.size(), hits.empty() ? std::size_t{0} : hits[0]);
    }
}

// Stop-all (used before mic recording): one faded block, then true silence,
// including the reverb tail.
static void test_stop_all_silences_everything() {
    std::printf("stop_all silences voices, song, sequencer and reverb tail\n");
    Engine& e = g_engine;
    e.init(kRate);
    load_pad(e, 0, std::vector<float>(96000, 0.3f));
    for (std::size_t s = 0; s < kDefaultSteps; ++s) e.set_step(0, s, true);
    e.set_reverb(dsp::Reverb::Size, 0.95f);
    e.set_reverb(dsp::Reverb::Mix, 0.8f);
    e.set_playing(true);
    render(e, 400);  // build up a long reverb tail
    e.stop_all();
    e.process();     // the fade-out block
    const float last = std::fabs(e.out(0)[kBlockSize - 1]);
    CHECK(last < 1e-6f, "fade block should end at zero, got %f", last);
    const auto after = render(e, 200);
    float peak = 0.0f;
    for (float x : after) peak = std::max(peak, std::fabs(x));
    CHECK(peak < 1e-6f, "expected silence after stop_all, peak %g", peak);
    CHECK(!e.status().seq_playing, "sequencer still playing");
}

// Level (RMS, dB) of the engine's left output while a pad plays `hz`.
static float sine_level_db(Engine& e, float hz) {
    std::vector<float> sine(48000);
    for (std::size_t i = 0; i < sine.size(); ++i)
        sine[i] = 0.3f * std::sin(2.0f * 3.14159265f * hz * static_cast<float>(i) / kRate);
    load_pad(e, 0, sine);
    e.trigger(0);
    render(e, 40);  // let the filter settle
    const auto out = render(e, 100);
    double sum = 0.0;
    for (float x : out) sum += static_cast<double>(x) * x;
    return static_cast<float>(10.0 * std::log10(sum / static_cast<double>(out.size()) + 1e-20));
}

// Drive, filter and width at their neutral settings leave audio untouched;
// away from neutral they do their job.
// Play right after stop_all (same block): the old sound and the reverb tail
// go, but the new downbeat lands at full level on its exact sample.
static void test_restart_keeps_downbeat() {
    std::printf("stop_all + play in one block keeps the new downbeat's attack\n");
    Engine& e = g_engine;
    e.init(kRate);
    e.set_master_gain(1.0f);
    load_pad(e, 0, {0.5f});                            // impulse
    load_pad(e, 1, std::vector<float>(96000, 0.2f));  // long ringing sound
    e.set_step(0, 0, true);
    e.set_reverb(dsp::Reverb::Mix, 0.5f);
    e.trigger(1);
    render(e, 100);  // pad 1 ringing, reverb full
    e.stop_all();
    e.set_playing(true);
    e.process();
    const float mix_dry = std::cos(0.5f * 3.14159265f * 0.5f);
    // Sample 0: the impulse through the dry path, plus what's left of the old
    // sound (fading, ~0.2 * dry) and the fading wet tail.
    const float first = e.out(0)[0];
    CHECK(first > 0.5f * mix_dry, "downbeat attenuated: %f (expected > %f)", first, 0.5f * mix_dry);
    const auto after = render(e, 50);
    float peak = 0.0f;
    for (float x : after) peak = std::max(peak, std::fabs(x));
    CHECK(peak < 0.05f, "old sound or tail still audible after restart: peak %f", peak);
}

static void test_deck_effects() {
    std::printf("drive, DJ filter, width: bypass exact, filters filter\n");
    Engine& e = g_engine;
    e.init(kRate);
    e.set_master_gain(1.0f);
    std::vector<float> noise(24000);
    std::srand(3);
    for (auto& x : noise) x = static_cast<float>(std::rand() % 65536) / 65536.0f - 0.5f;
    load_pad(e, 0, noise);
    e.set_drive(0.0f);
    e.set_filter(0.0f);
    e.set_width(1.0f);
    e.trigger(0);
    const auto out = render(e, noise.size() / kBlockSize);
    std::size_t diffs = 0;
    for (std::size_t i = 0; i < out.size(); ++i) diffs += out[i] != noise[i];
    CHECK(diffs == 0, "neutral deck changed %zu samples", diffs);

    e.init(kRate);
    e.set_master_gain(1.0f);
    const float open_5k = sine_level_db(e, 5000.0f);
    e.init(kRate);
    e.set_master_gain(1.0f);
    e.set_filter(-1.0f);  // low-pass at 150 Hz
    const float lp_5k = sine_level_db(e, 5000.0f);
    CHECK(open_5k - lp_5k > 40.0f, "low-pass only cut 5 kHz by %.1f dB", open_5k - lp_5k);

    e.init(kRate);
    e.set_master_gain(1.0f);
    const float open_60 = sine_level_db(e, 60.0f);
    e.init(kRate);
    e.set_master_gain(1.0f);
    e.set_filter(1.0f);  // high-pass at 3 kHz
    const float hp_60 = sine_level_db(e, 60.0f);
    CHECK(open_60 - hp_60 > 40.0f, "high-pass only cut 60 Hz by %.1f dB", open_60 - hp_60);

    // Full drive on a hot signal stays within +-1/g and never blows up.
    e.init(kRate);
    e.set_master_gain(1.0f);
    load_pad(e, 0, std::vector<float>(4800, 0.95f));
    e.set_drive(1.0f);
    e.trigger(0);
    float peak = 0.0f;
    for (float x : render(e, 20)) peak = std::max(peak, std::fabs(x));
    CHECK(peak > 0.0f && peak <= 1.0f / 8.0f + 1e-6f, "drive peak %f, expected <= 0.125", peak);

    // Width 0 folds to mono: left equals right.
    e.init(kRate);
    e.set_width(0.0f);
    load_pad(e, 0, noise);
    e.set_reverb(dsp::Reverb::Mix, 0.5f);  // reverb is stereo, so L != R before width
    e.trigger(0);
    const auto frames = 60;
    std::size_t differ = 0;
    for (int b = 0; b < frames; ++b) {
        e.process();
        for (std::size_t i = 0; i < kBlockSize; ++i) differ += e.out(0)[i] != e.out(1)[i];
    }
    CHECK(differ == 0, "width 0 left %zu samples where L != R", differ);
}

static void test_process_never_allocates() {
    std::printf("no allocations in process()\n");
    Engine& e = g_engine;
    e.init(kRate);
    load_pad(e, 0, std::vector<float>(4800, 0.1f));
    for (std::size_t s = 0; s < kDefaultSteps; ++s) e.set_step(0, s, true);
    e.set_reverb(dsp::Reverb::Mix, 0.4f);
    e.set_eq_gain(0, 6.0f);
    e.set_drive(0.5f);
    e.set_filter(-0.4f);
    e.set_width(1.3f);
    e.set_playing(true);
    const long before = g_allocations.load();
    for (int b = 0; b < 10000; ++b) {
        if (b % 100 == 0) e.set_speed(b % 200 == 0 ? 0.8f : 1.0f);
        e.process();
    }
    CHECK(g_allocations.load() == before, "%ld allocations", g_allocations.load() - before);
}

int main() {
    test_sequencer_is_sample_accurate();
    test_reverb_mix_zero_is_bypass();
    test_polyphony_and_stealing();
    test_retrigger_chokes_same_pad();
    test_longer_patterns();
    test_stop_all_silences_everything();
    test_restart_keeps_downbeat();
    test_deck_effects();
    test_process_never_allocates();
    if (g_failures) {
        std::printf("%d check(s) failed\n", g_failures);
        return 1;
    }
    std::printf("all passed\n");
    return 0;
}
