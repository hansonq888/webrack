// A clock for the audio thread, which has no timer of its own: Chrome doesn't
// expose `performance` in AudioWorkletGlobalScope. This Worker spins,
// incrementing a counter in shared memory; the worklet reads the counter
// around each render call. When stopped, the Worker reports how many ticks
// elapsed in how much performance.now() time, which converts ticks to
// microseconds.
//
// The counter is an Int32 that wraps; readers take differences with `| 0`,
// which is correct for any interval shorter than 2^31 ticks.

import type { ClockCalibration } from './protocol.ts'

onmessage = ({ data: buffer }: MessageEvent<SharedArrayBuffer>) => {
  const words = new Int32Array(buffer)
  const t0 = performance.now()
  let ticks = 0
  while (Atomics.load(words, 1) === 0) Atomics.store(words, 0, ++ticks)
  postMessage({ ticks, ms: performance.now() - t0 } satisfies ClockCalibration)
}
