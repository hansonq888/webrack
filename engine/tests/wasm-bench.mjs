// Soak benchmark of the shipped engine.wasm in V8 (Node), same scenario as
// bench.cpp: 16 voices retriggered and stolen, song on top, speed 0.8x, EQ,
// reverb. Usage: node engine/tests/wasm-bench.mjs [minutes] [path/to/engine.wasm]

import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

const minutes = Number(process.argv[2] ?? 10)
const rate = 48000
const wasm = process.argv[3] ?? new URL('../../app/public/engine.wasm', import.meta.url)
const { exports: e } = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(wasm)), {})
e._initialize()
e.wr_init(rate)

let seed = 7
const noise = () => ((seed = (seed * 1103515245 + 12345) >>> 0) % 65536) / 65536 - 0.5

for (let p = 0; p < 16; p++) {
  e.wr_pad_begin(p)
  const pad = new Float32Array(e.memory.buffer, e.wr_pad_data(p), 96000)
  for (let i = 0; i < pad.length; i++) pad[i] = noise()
  e.wr_pad_commit(p, 96000)
  for (let s = 0; s < 16; s++) e.wr_set_step(p, s, 1)
}
const songFrames = 60 * rate
const song = new Int16Array(e.memory.buffer, e.wr_song_data(), songFrames * 2)
for (let i = 0; i < song.length; i++) song[i] = noise() * 20000
e.wr_song_commit(songFrames)
e.wr_song_set_playing(1)

e.wr_set_bpm(180)
e.wr_set_speed(0.8)
e.wr_set_eq_gain(0, 4)
e.wr_set_eq_gain(1, -2)
e.wr_set_eq_gain(2, 3)
e.wr_set_reverb(0, 0.85)
e.wr_set_reverb(3, 0.35)
e.wr_set_playing(1)

const status = new Int32Array(e.memory.buffer, e.wr_status(), 8)
const blockSize = e.wr_block_size()
const budgetUs = (blockSize / rate) * 1e6
const blocks = Math.floor((minutes * 60 * rate) / blockSize)
const us = new Float64Array(blocks)
for (let b = 0; b < blocks; b++) {
  if (!status[6]) e.wr_song_set_playing(1)
  const t0 = performance.now()
  e.wr_process()
  us[b] = (performance.now() - t0) * 1000
}

const sorted = us.slice().sort()
const pct = (p) => sorted[Math.floor(p * (sorted.length - 1))]
const line = (label, v) =>
  `  ${label.padEnd(5)} ${v.toFixed(1).padStart(7)} us  (${((100 * v) / budgetUs).toFixed(1).padStart(4)}%)`
console.log(`wasm (V8 ${process.versions.v8}) full chain, ${minutes} min of audio (${blocks} blocks)`)
console.log(line('p50', pct(0.5)) + ` of ${budgetUs.toFixed(0)} us budget`)
console.log(line('p99', pct(0.99)))
console.log(line('p99.9', pct(0.999)))
console.log(line('max', sorted.at(-1)))
console.log(`  blocks over budget: ${us.filter((t) => t > budgetUs).length}`)
