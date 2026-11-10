// One benchmark run on the real audio thread: the engine renders the worst
// case in an AudioWorklet in real time (output silent) while the tick-clock
// Worker times every block. Optionally, burner Workers load other cores.
//
// Two independent views of reliability come back:
//  - render time per block, from the shared clock: did the engine fit the
//    2,667 µs deadline?
//  - the browser's own underrun count (AudioContext.playbackStats, Chrome):
//    did the output actually glitch, for any reason?

import workletUrl from './worklet.ts?worker&url'
import { BLOCK_SIZE } from './js-engine.ts'
import { CLOCK_WORDS, type ClockCalibration, type WorkletOptions, type WorkletReply } from './protocol.ts'
import { SAMPLE_RATE, makeInputs, summarize, type Stats } from './scenario.ts'
import { readPlaybackStats } from '../engine/playback-stats.ts'

export interface AudioThreadRunOptions {
  module: WebAssembly.Module
  seconds: number
  /** Burner Workers spinning on other cores during the run. */
  contention: number
}

export interface Underruns {
  events: number
  durationMs: number
  totalMs: number
}

export interface AudioThreadRunResult {
  stats: Stats
  sampleRate: number
  clockTicksPerUs: number
  /** Null where the browser doesn't report underruns. */
  underruns: Underruns | null
  /** The slowest blocks, by index: tells a cold start (block 0, 1, ...) from a stall mid-run. */
  slowest: { block: number; us: number }[]
}

/** Starts `count` burner Workers; returns a function that stops them. */
function startContention(count: number): () => void {
  const stop = new SharedArrayBuffer(4)
  const workers = Array.from({ length: count }, () => {
    const worker = new Worker(new URL('./burner.ts', import.meta.url), { type: 'module' })
    worker.postMessage(stop)
    return worker
  })
  return () => {
    Atomics.store(new Int32Array(stop), 0, 1)
    for (const worker of workers) worker.terminate()
  }
}

export async function runOnAudioThread({ module, seconds, contention }: AudioThreadRunOptions): Promise<AudioThreadRunResult> {
  const clockBuffer = new SharedArrayBuffer(CLOCK_WORDS * 4)
  const clock = new Worker(new URL('./tick-clock.ts', import.meta.url), { type: 'module' })
  const calibration = new Promise<ClockCalibration>((resolve) => (clock.onmessage = (e) => resolve(e.data)))
  clock.postMessage(clockBuffer)
  const stopContention = startContention(contention)
  const context = new AudioContext({ sampleRate: SAMPLE_RATE })
  try {
    await context.audioWorklet.addModule(workletUrl)
    const blocks = Math.floor((seconds * context.sampleRate) / BLOCK_SIZE)
    const node = new AudioWorkletNode(context, 'webrack-bench', {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: { module, inputs: makeInputs(), blocks, clock: clockBuffer, fullChain: true } satisfies WorkletOptions,
    })
    // Silent: the node's output is never written, and a zero gain guards the speakers anyway.
    node.connect(new GainNode(context, { gain: 0 })).connect(context.destination)
    await context.resume()
    const before = readPlaybackStats(context)
    const { ticks } = await new Promise<WorkletReply>((resolve) => (node.port.onmessage = (e) => resolve(e.data)))
    const after = readPlaybackStats(context)

    Atomics.store(new Int32Array(clockBuffer), 1, 1) // stop the clock
    const cal = await calibration
    const usPerTick = (cal.ms * 1000) / cal.ticks
    const us = ticks.map((t) => t * usPerTick)
    const slowest = Array.from(us, (value, block) => ({ block, us: value }))
      .sort((a, b) => b.us - a.us)
      .slice(0, 5)
    return {
      stats: summarize(us),
      slowest,
      sampleRate: context.sampleRate,
      clockTicksPerUs: 1 / usPerTick,
      underruns:
        before && after
          ? {
              events: after.underrunEvents - before.underrunEvents,
              durationMs: (after.underrunDuration - before.underrunDuration) * 1000,
              totalMs: (after.totalDuration - before.totalDuration) * 1000,
            }
          : null,
    }
  } finally {
    stopContention()
    clock.terminate()
    await context.close()
  }
}
