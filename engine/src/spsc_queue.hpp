#pragma once

// Lock-free single-producer / single-consumer queue.
//
// One thread (the producer) calls try_push; one other thread (the consumer)
// calls try_pop. Neither ever blocks, locks, or allocates, so the consumer can
// be a real-time audio thread. Both return false instead of waiting when the
// queue is full or empty.
//
// A fixed ring of Capacity slots with two indices. Each index has exactly one
// writer: the producer owns write_index, the consumer owns read_index, so
// there is never a write-write race and no lock is needed. Each thread loads
// its own index relaxed, and synchronizes through two release/acquire pairs:
//   - push stores write_index with release after writing the slot; pop's
//     acquire load of it guarantees the item is visible before it is read.
//   - pop stores read_index with release after copying the slot out; push's
//     acquire load of it guarantees the copy has finished before the slot is
//     reused.
// The indices sit on separate 64-byte cache lines, so the two threads' writes
// don't invalidate each other's lines (false sharing). 64 bytes is what an
// Apple M5 needed in engine/tests/false_sharing.cpp.
//
// Tests (also under ThreadSanitizer): engine/test.sh spsc

#include <atomic>
#include <cstddef>
#include <type_traits>

namespace webrack {

template <typename T, std::size_t Capacity>
class SpscQueue {
    static_assert(Capacity >= 2 && (Capacity & (Capacity - 1)) == 0,
                  "Capacity must be a power of two (so wrap-around is a bitmask)");
    static_assert(std::is_trivially_copyable_v<T>,
                  "T is copied by value between threads and must be trivially copyable");

public:
    // One slot always stays empty so that "full" and "empty" look different.
    static constexpr std::size_t kUsableCapacity = Capacity - 1;

    SpscQueue() = default;
    SpscQueue(const SpscQueue&) = delete;
    SpscQueue& operator=(const SpscQueue&) = delete;

    // Producer thread only. Returns false (and changes nothing) if full.
    bool try_push(const T& item) {
        const std::size_t current_write =
            write_index.load(std::memory_order_relaxed);

        const std::size_t next_write =
            (current_write + 1) & (Capacity - 1);

        if (next_write ==
            read_index.load(std::memory_order_acquire)) {
            return false;
        }

        buffer[current_write] = item;

        write_index.store(next_write, std::memory_order_release);

        return true;
    }

    // Consumer thread only. Returns false (and leaves `out` alone) if empty.
    bool try_pop(T& out) {
        const std::size_t current_read =
            read_index.load(std::memory_order_relaxed);

        if (current_read ==
            write_index.load(std::memory_order_acquire)) {
            return false;
        }

        out = buffer[current_read];

        const std::size_t next_read =
            (current_read + 1) & (Capacity - 1);

        read_index.store(next_read, std::memory_order_release);

        return true;
    }

private:
    T buffer[Capacity]{};

    alignas(64) std::atomic<std::size_t> write_index{0};
    alignas(64) std::atomic<std::size_t> read_index{0};
};

}  // namespace webrack
