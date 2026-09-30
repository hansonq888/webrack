// JS vs WASM benchmark in Node (V8).
//   node scripts/bench.ts [minutes=10] [--json out.json]
//
// Each engine runs in a fresh instance from a cold start, so the numbers
// include JIT warm-up, as they would in a real session.

import { readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import os from 'node:os'
import {
  BUDGET_US,
  SAMPLE_RATE,
  jsEngine,
  makeInputs,
  parity,
  run,
  setUp,
  summarize,
  wasmEngine,
  type Stats,
} from '../src/bench/scenario.ts'
import { BLOCK_SIZE } from '../src/bench/js-engine.ts'

const args = process.argv.slice(2)
const minutes = Number(args.find((a) => !a.startsWith('--')) ?? 10)
const jsonPath = args.includes('--json') ? args[args.indexOf('--json') + 1] : null

const module = new WebAssembly.Module(readFileSync(new URL('../public/engine.wasm', import.meta.url)))
const inputs = makeInputs()
const blocks = Math.floor((minutes * 60 * SAMPLE_RATE) / BLOCK_SIZE)

// 1. Same work: both engines must produce the same audio.
const a = wasmEngine(module)
const b = jsEngine()
setUp(a, inputs)
setUp(b, inputs)
const check = parity(a, b, Math.floor((30 * SAMPLE_RATE) / BLOCK_SIZE))
const diffDb = 20 * Math.log10(check.maxAbsDiff / check.signalRms)
console.log(`output parity over 30 s: max |diff| ${check.maxAbsDiff.toExponential(2)} (${diffDb.toFixed(0)} dB below signal RMS)`)

// 2. Timing, fresh instances.
const results: Record<string, Stats> = {}
for (const make of [wasmEngine.bind(null, module), jsEngine]) {
  const engine = make()
  setUp(engine, inputs)
  results[engine.name] = summarize(run(engine, blocks, () => performance.now()))
}

const cpu = os.cpus()[0]?.model ?? 'unknown CPU'
console.log(`\n${minutes} min of audio (${blocks} blocks of ${BLOCK_SIZE} @ ${SAMPLE_RATE} Hz), budget ${BUDGET_US.toFixed(0)} µs/block`)
console.log(`Node ${process.version} (V8 ${process.versions.v8}), ${cpu}\n`)

const cols = ['p50', 'p99', 'p99.9', 'max', 'over budget', 'realtime ×'] as const
const row = (label: string, s: Stats) =>
  [label.padEnd(12), ...[s.p50, s.p99, s.p999, s.max].map((v) => `${v.toFixed(1)} µs`.padStart(11)),
   String(s.overBudget).padStart(12), `${s.realtimeFactor.toFixed(0)}×`.padStart(11)].join('')
console.log(''.padEnd(12) + cols.map((c) => c.padStart(c === 'over budget' ? 12 : 11)).join(''))
for (const [name, s] of Object.entries(results)) console.log(row(name, s))

const [w, j] = [results['C++ → WASM'], results['JavaScript']]
const ratio = (k: keyof Stats) => (j[k] / w[k]).toFixed(1)
console.log(`\nWASM advantage: p50 ${ratio('p50')}×, p99 ${ratio('p99')}×, p99.9 ${ratio('p999')}×, max ${ratio('max')}×, throughput ${(w.realtimeFactor / j.realtimeFactor).toFixed(1)}×`)

if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify({ date: new Date().toISOString(), minutes, node: process.version, v8: process.versions.v8, cpu, parity: check, results }, null, 2))
  console.log(`wrote ${jsonPath}`)
}
