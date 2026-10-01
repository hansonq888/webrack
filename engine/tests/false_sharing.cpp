// False-sharing benchmark. Two threads each increment their own atomic
// counter; nothing is shared logically. The only variable is how far apart
// the two counters sit in memory. When they share a cache line, every write
// by one core invalidates the other core's copy of the line, and the line
// ping-pongs between cores. Once they are a full line apart, each core keeps
// its line to itself.
//
// Run: engine/test.sh cacheline

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <new>
#include <thread>
#include <vector>

namespace {

constexpr std::uint64_t kIncrements = 20'000'000;
constexpr int kTrials = 5;

// Room for two counters up to 256 bytes apart, starting on a 256-byte boundary.
struct alignas(256) Arena {
    unsigned char bytes[512];
};
Arena g_arena;

// Nanoseconds per increment with the counters `offset` bytes apart.
double trial(std::size_t offset) {
    auto* a = new (g_arena.bytes) std::atomic<std::uint64_t>(0);
    auto* b = new (g_arena.bytes + offset) std::atomic<std::uint64_t>(0);
    const auto work = [](std::atomic<std::uint64_t>* counter) {
        for (std::uint64_t i = 0; i < kIncrements; ++i) counter->fetch_add(1, std::memory_order_relaxed);
    };
    const auto t0 = std::chrono::steady_clock::now();
    std::thread ta(work, a), tb(work, b);
    ta.join();
    tb.join();
    const double ns = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - t0).count();
    return ns / static_cast<double>(kIncrements);
}

double median_trial(std::size_t offset) {
    std::vector<double> runs;
    for (int t = 0; t < kTrials; ++t) runs.push_back(trial(offset));
    std::sort(runs.begin(), runs.end());
    return runs[runs.size() / 2];
}

}  // namespace

int main() {
    std::printf("two threads, %llu relaxed increments each, median of %d trials\n",
                static_cast<unsigned long long>(kIncrements), kTrials);
    std::printf("std::hardware_destructive_interference_size = %zu\n\n",
                std::hardware_destructive_interference_size);
    const double apart = median_trial(256);
    for (std::size_t offset : {8u, 32u, 64u, 128u, 256u}) {
        const double ns = median_trial(offset);
        std::printf("  counters %3zu bytes apart: %5.2f ns per increment (%.1fx the unshared cost)\n", offset, ns,
                    ns / apart);
    }
}
