import type { Command } from './protocol'

// Lock-free single-producer / single-consumer ring of fixed 16-byte commands
// in a SharedArrayBuffer. The UI thread only writes `head`, the audio thread
// only writes `tail`; neither ever blocks or allocates.
//
// Layout: head and tail as Int32, each at the start of its own 128-byte cache
// line, then CAPACITY records of [op:i32, a:i32, b:i32, f:f32]. The two
// threads write head and tail constantly; on the same line, every write by
// one core would invalidate the other's copy (false sharing). 64 bytes apart
// is enough on an M5 (engine/test.sh cacheline); 128 covers other chips.

const LINE_WORDS = 32 // 128 bytes
const HEAD = 0
const TAIL = LINE_WORDS
const HEADER_WORDS = 2 * LINE_WORDS
const RECORD_WORDS = 4
const CAPACITY = 1024 // records; must be a power of two

export function createRingBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer((HEADER_WORDS + CAPACITY * RECORD_WORDS) * 4)
}

export class RingWriter {
  private readonly header: Int32Array
  private readonly ints: Int32Array
  private readonly floats: Float32Array

  constructor(buffer: SharedArrayBuffer) {
    this.header = new Int32Array(buffer, 0, HEADER_WORDS)
    this.ints = new Int32Array(buffer, HEADER_WORDS * 4)
    this.floats = new Float32Array(buffer, HEADER_WORDS * 4)
  }

  /** Returns false if the ring is full (the command is dropped). */
  push([op, a, b, f]: Command): boolean {
    const head = Atomics.load(this.header, HEAD)
    const tail = Atomics.load(this.header, TAIL)
    if (((head + 1) & (CAPACITY - 1)) === tail) return false
    const i = head * RECORD_WORDS
    this.ints[i] = op
    this.ints[i + 1] = a
    this.ints[i + 2] = b
    this.floats[i + 3] = f
    Atomics.store(this.header, HEAD, (head + 1) & (CAPACITY - 1))
    return true
  }
}

export class RingReader {
  private readonly header: Int32Array
  private readonly ints: Int32Array
  private readonly floats: Float32Array

  constructor(buffer: SharedArrayBuffer) {
    this.header = new Int32Array(buffer, 0, HEADER_WORDS)
    this.ints = new Int32Array(buffer, HEADER_WORDS * 4)
    this.floats = new Float32Array(buffer, HEADER_WORDS * 4)
  }

  /** Calls `apply` for every pending command, oldest first. */
  drain(apply: (op: number, a: number, b: number, f: number) => void): void {
    const head = Atomics.load(this.header, HEAD)
    let tail = Atomics.load(this.header, TAIL)
    while (tail !== head) {
      const i = tail * RECORD_WORDS
      apply(this.ints[i], this.ints[i + 1], this.ints[i + 2], this.floats[i + 3])
      tail = (tail + 1) & (CAPACITY - 1)
    }
    Atomics.store(this.header, TAIL, tail)
  }
}
