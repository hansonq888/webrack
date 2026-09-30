// The JS-vs-WASM benchmark: one scenario, one timing loop, two engines.
// Used by the Node runner (scripts/bench.ts) and the in-browser /bench page.
//
// Scenario (worst case for the engine): 16 pads of 2 s noise, every pad on
// every step at 180 BPM so all 16 voices are always sounding and being stolen,
// a song playing on top, speed 0.8x (interpolation on every voice), EQ on,
// reverb at 35%.

import { BLOCK_SIZE, JsEngine } from './js-engine.ts'

export const SAMPLE_RATE = 48000
export const BUDGET_US = (BLOCK_SIZE / SAMPLE_RATE) * 1e6

export interface BenchEngine {
  readonly name: string
  readonly outL: Float32Array
  loadPad(pad: number, data: Float32Array): void
  loadSong(interleaved: Int16Array): void
  setStep(pad: number, step: number, on: boolean): void
  setBpm(bpm: number): void
  setSpeed(speed: number): void
  setEqGain(band: number, db: number): void
  setReverb(param: number, value: number): void
  setPlaying(playing: boolean): void
  setSongPlaying(playing: boolean): void
  songPlaying(): boolean
  process(): void
}

export interface Inputs {
  pads: Float32Array[]
  song: Int16Array
}

/** Deterministic inputs, identical for both engines. */
export function makeInputs(): Inputs {
  let seed = 7
  const noise = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % 65536) / 65536 - 0.5
  const pads = Array.from({ length: 16 }, () => Float32Array.from({ length: 2 * SAMPLE_RATE }, noise))
  const song = Int16Array.from({ length: 60 * SAMPLE_RATE * 2 }, () => Math.round(noise() * 20000))
  return { pads, song }
}

export function setUp(engine: BenchEngine, inputs: Inputs): void {
  inputs.pads.forEach((data, pad) => {
    engine.loadPad(pad, data)
    for (let s = 0; s < 16; s++) engine.setStep(pad, s, true)
  })
  engine.loadSong(inputs.song)
  engine.setSongPlaying(true)
  engine.setBpm(180)
  engine.setSpeed(0.8)
  engine.setEqGain(0, 4)
  engine.setEqGain(1, -2)
  engine.setEqGain(2, 3)
  engine.setReverb(0, 0.85)
  engine.setReverb(3, 0.35)
  engine.setPlaying(true)
}

/** Times every process() call, in microseconds. The song restarts when it ends. */
export function run(engine: BenchEngine, blocks: number, now: () => number): Float64Array {
  const us = new Float64Array(blocks)
  for (let b = 0; b < blocks; b++) {
    if (!engine.songPlaying()) engine.setSongPlaying(true)
    const t0 = now()
    engine.process()
    us[b] = (now() - t0) * 1000
  }
  return us
}

export interface Stats {
  blocks: number
  p50: number
  p99: number
  p999: number
  max: number
  mean: number
  overBudget: number
  realtimeFactor: number // seconds of audio rendered per second of compute
}

export function summarize(us: Float64Array): Stats {
  const sorted = us.slice().sort()
  const pct = (p: number) => sorted[Math.floor(p * (sorted.length - 1))]
  let total = 0
  let over = 0
  for (const t of us) {
    total += t
    if (t > BUDGET_US) over++
  }
  return {
    blocks: us.length,
    p50: pct(0.5),
    p99: pct(0.99),
    p999: pct(0.999),
    max: sorted[sorted.length - 1],
    mean: total / us.length,
    overBudget: over,
    realtimeFactor: (us.length * BUDGET_US) / total,
  }
}

/** Renders `blocks` with fresh engines and compares their left outputs. */
export function parity(a: BenchEngine, b: BenchEngine, blocks: number): { maxAbsDiff: number; signalRms: number } {
  let maxAbsDiff = 0
  let sumsq = 0
  for (let n = 0; n < blocks; n++) {
    if (!a.songPlaying()) a.setSongPlaying(true)
    if (!b.songPlaying()) b.setSongPlaying(true)
    a.process()
    b.process()
    for (let i = 0; i < BLOCK_SIZE; i++) {
      maxAbsDiff = Math.max(maxAbsDiff, Math.abs(a.outL[i] - b.outL[i]))
      sumsq += a.outL[i] * a.outL[i]
    }
  }
  return { maxAbsDiff, signalRms: Math.sqrt(sumsq / (blocks * BLOCK_SIZE)) }
}

export function jsEngine(): BenchEngine {
  const e = new JsEngine()
  e.init(SAMPLE_RATE)
  return {
    name: 'JavaScript',
    outL: e.outL,
    loadPad: (pad, data) => e.loadPad(pad, data),
    loadSong: (data) => e.loadSong(data),
    setStep: (pad, step, on) => e.setStep(pad, step, on),
    setBpm: (bpm) => e.setBpm(bpm),
    setSpeed: (speed) => e.setSpeed(speed),
    setEqGain: (band, db) => e.setEqGain(band, db),
    setReverb: (param, value) => e.setReverb(param, value),
    setPlaying: (playing) => e.setPlaying(playing),
    setSongPlaying: (playing) => e.setSongPlaying(playing),
    songPlaying: () => e.song.playing,
    process: () => e.process(),
  }
}

interface WasmExports {
  memory: WebAssembly.Memory
  _initialize(): void
  wr_init(sampleRate: number): void
  wr_process(): void
  wr_output(channel: number): number
  wr_status(): number
  wr_pad_data(pad: number): number
  wr_pad_begin(pad: number): void
  wr_pad_commit(pad: number, frames: number): void
  wr_set_step(pad: number, step: number, on: number): void
  wr_set_bpm(bpm: number): void
  wr_set_playing(playing: number): void
  wr_song_data(): number
  wr_song_commit(frames: number): void
  wr_song_set_playing(playing: number): void
  wr_set_speed(speed: number): void
  wr_set_eq_gain(band: number, db: number): void
  wr_set_reverb(param: number, value: number): void
}

const SONG_PLAYING_WORD = 6 // Status::song_playing

export function wasmEngine(module: WebAssembly.Module): BenchEngine {
  const e = new WebAssembly.Instance(module, {}).exports as unknown as WasmExports
  e._initialize()
  e.wr_init(SAMPLE_RATE)
  const buffer = e.memory.buffer
  const status = new Int32Array(buffer, e.wr_status(), 8)
  return {
    name: 'C++ → WASM',
    outL: new Float32Array(buffer, e.wr_output(0), BLOCK_SIZE),
    loadPad: (pad, data) => {
      e.wr_pad_begin(pad)
      new Float32Array(buffer, e.wr_pad_data(pad), data.length).set(data)
      e.wr_pad_commit(pad, data.length)
    },
    loadSong: (data) => {
      new Int16Array(buffer, e.wr_song_data(), data.length).set(data)
      e.wr_song_commit(data.length / 2)
    },
    setStep: (pad, step, on) => e.wr_set_step(pad, step, on ? 1 : 0),
    setBpm: (bpm) => e.wr_set_bpm(bpm),
    setSpeed: (speed) => e.wr_set_speed(speed),
    setEqGain: (band, db) => e.wr_set_eq_gain(band, db),
    setReverb: (param, value) => e.wr_set_reverb(param, value),
    setPlaying: (playing) => e.wr_set_playing(playing ? 1 : 0),
    setSongPlaying: (playing) => e.wr_song_set_playing(playing ? 1 : 0),
    songPlaying: () => status[SONG_PLAYING_WORD] !== 0,
    process: () => e.wr_process(),
  }
}
