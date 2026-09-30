// Messages between the /bench page and its Worker and AudioWorklet runners.

import type { Inputs, Stats } from './scenario.ts'

export interface WorkerRequest {
  module: WebAssembly.Module
  minutes: number
}

export type WorkerReply =
  | { type: 'progress'; label: string }
  | { type: 'done'; parityDb: number; results: Record<string, Stats & { wallMeanUs: number }> }

export interface WorkletOptions {
  module: WebAssembly.Module
  inputs: Inputs
  blocks: number
  clock: SharedArrayBuffer // the tick-clock Worker's counter
}

/** Ticks of the shared clock spent in each render call. */
export interface WorkletReply {
  ticks: Float64Array
}

/** The shared clock's words: [counter, stop flag]. */
export const CLOCK_WORDS = 2

/** How many ticks the shared clock counted in how many milliseconds. */
export interface ClockCalibration {
  ticks: number
  ms: number
}
