// Tests for SpscQueue. Build and run: engine/test.sh spsc
// Runs twice: under ThreadSanitizer (catches data races and missing
// happens-before), then optimized (catches bugs that only show at speed, and
// reports throughput).

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <thread>

#include "../src/spsc_queue.hpp"

using webrack::SpscQueue;

static int g_failures = 0;
#define CHECK(cond, ...)                                       \
    do {                                                       \
        if (!(cond)) {                                         \
            ++g_failures;                                      \
            std::printf("  FAIL %s:%d: ", __FILE__, __LINE__); \
            std::printf(__VA_ARGS__);                          \
            std::printf("\n");                                 \
        }                                                      \
    } while (0)

// The engine's command record.
struct Command {
    std::int32_t op, a, b;
    float f;
};

static void test_starts_empty() {
    std::printf("starts empty\n");
    SpscQueue<int, 8> q;
    int out = -1;
    CHECK(!q.try_pop(out), "pop on a new queue succeeded");
    CHECK(out == -1, "failed pop modified its output (%d)", out);
}

static void test_fifo_order() {
    std::printf("first in, first out\n");
    SpscQueue<Command, 16> q;
    for (int i = 0; i < 5; ++i) CHECK(q.try_push({i, i * 2, i * 3, i * 0.5f}), "push %d failed", i);
    for (int i = 0; i < 5; ++i) {
        Command c{};
        CHECK(q.try_pop(c), "pop %d failed", i);
        CHECK(c.op == i && c.a == i * 2 && c.b == i * 3 && c.f == i * 0.5f, "pop %d returned the wrong command", i);
    }
    Command c{};
    CHECK(!q.try_pop(c), "pop succeeded after draining");
}

static void test_capacity_edges() {
    std::printf("full and empty edges\n");
    SpscQueue<int, 8> q;
    static_assert(decltype(q)::kUsableCapacity == 7);
    for (int i = 0; i < 7; ++i) CHECK(q.try_push(i), "push %d of 7 failed", i);
    CHECK(!q.try_push(99), "push succeeded on a full queue");
    int out = -1;
    CHECK(q.try_pop(out) && out == 0, "pop from full queue returned %d, expected 0", out);
    CHECK(q.try_push(7), "push failed after one pop freed a slot");
    CHECK(!q.try_push(100), "push succeeded on a full queue (after wrap)");
    for (int i = 1; i <= 7; ++i) CHECK(q.try_pop(out) && out == i, "pop returned %d, expected %d", out, i);
    CHECK(!q.try_pop(out), "pop succeeded on an empty queue");
}

// Many laps around the ring in one thread: exercises wrap-around.
static void test_wraparound() {
    std::printf("wrap-around, single thread\n");
    SpscQueue<std::uint32_t, 4> q;
    std::uint32_t next_in = 0, next_out = 0;
    bool ok = true;
    for (int round = 0; round < 100'000 && ok; ++round) {
        const int pushes = 1 + round % 3;  // 1..3, never more than capacity
        for (int i = 0; i < pushes; ++i) ok &= q.try_push(next_in++);
        std::uint32_t v;
        while (q.try_pop(v)) ok &= (v == next_out++);
    }
    CHECK(ok && next_in == next_out, "wrap-around lost or reordered items (in %u, out %u)", next_in, next_out);
}

// One producer thread, one consumer thread, millions of items. The consumer
// checks every value arrives exactly once, in order. A small capacity forces
// constant full/empty transitions, where most bugs live.
template <std::size_t Capacity>
static void stress(std::uint64_t items) {
    std::printf("two threads, capacity %zu, %llu items\n", Capacity, static_cast<unsigned long long>(items));
    SpscQueue<std::uint64_t, Capacity> q;
    std::uint64_t bad = 0, received = 0;

    // A broken queue can leave a thread waiting forever; give up instead.
    const auto t0 = std::chrono::steady_clock::now();
    const auto deadline = t0 + std::chrono::seconds(30);
    std::atomic<bool> stuck{false};
    const auto wait = [&] {
        if (std::chrono::steady_clock::now() > deadline) stuck = true;
        std::this_thread::yield();
    };

    std::thread producer([&] {
        for (std::uint64_t i = 0; i < items && !stuck; ++i)
            while (!q.try_push(i) && !stuck) wait();
    });
    std::thread consumer([&] {
        std::uint64_t expected = 0, v = 0;
        while (expected < items && !stuck) {
            if (!q.try_pop(v)) {
                wait();
                continue;
            }
            if (v != expected) ++bad;
            expected = v + 1;
            ++received;
        }
    });
    producer.join();
    consumer.join();
    const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();

    CHECK(!stuck, "no progress for 30 s: an item was never pushed or never popped");
    CHECK(bad == 0, "%llu items arrived out of order or corrupted", static_cast<unsigned long long>(bad));
    CHECK(received == items, "received %llu of %llu items", static_cast<unsigned long long>(received),
          static_cast<unsigned long long>(items));
    std::printf("  %.1f M items/s\n", static_cast<double>(items) / secs / 1e6);
}

int main() {
    test_starts_empty();
    test_fifo_order();
    test_capacity_edges();
    test_wraparound();
#if defined(__SANITIZE_THREAD__) || __has_feature(thread_sanitizer)
    stress<4>(200'000);
    stress<1024>(1'000'000);
#else
    stress<4>(5'000'000);
    stress<1024>(50'000'000);
#endif
    if (g_failures) {
        std::printf("%d check(s) failed\n", g_failures);
        return 1;
    }
    std::printf("all passed\n");
    return 0;
}
