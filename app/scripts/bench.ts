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
  ENGINES,
  SAMPLE_RATE,
  jsEngine,
  makeInputs,
  parity,
  run,
  setUp,
  summarize,
  wasmEngine,
  type BenchEngine,
  type Stats,
} from '../src/bench/scenario.ts'
import { BLOCK_SIZE } from '../src/bench/js-engine.ts'

const args = process.argv.slice(2)
const minutes = Number(args.find((a) => !a.startsWith('--')) ?? 10)
const jsonPath = args.includes('--json') ? args[args.indexOf('--json') + 1] : null

const load = (file: string) => new WebAssembly.Module(readFileSync(new URL(`../public/${file}`, import.meta.url)))
const modules = { simd: load('engine.wasm'), scalar: load('engine-scalar.wasm') }
const makers: Record<string, () => BenchEngine> = {
  [ENGINES.simd]: () => wasmEngine(modules.simd, ENGINES.simd),
  [ENGINES.scalar]: () => wasmEngine(modules.scalar, ENGINES.scalar),
  [ENGINES.js]: jsEngine,
}
const inputs = makeInputs()
const blocks = Math.floor((minutes * 60 * SAMPLE_RATE) / BLOCK_SIZE)

// 1. Same work: every engine must produce the same audio. The two WASM builds
// come from one source and must match bit for bit; the JavaScript port only
// to within float rounding.
function checkParity(a: string, b: string) {
  const [x, y] = [makers[a](), makers[b]()]
  setUp(x, inputs)
  setUp(y, inputs)
  return parity(x, y, Math.floor((30 * SAMPLE_RATE) / BLOCK_SIZE))
}
const builds = checkParity(ENGINES.simd, ENGINES.scalar)
if (builds.maxAbsDiff !== 0) {
  console.error(`SIMD and scalar builds differ (max |diff| ${builds.maxAbsDiff}); they must be bit-identical`)
  process.exit(1)
}
console.log('SIMD vs scalar build over 30 s: bit-identical')
const check = checkParity(ENGINES.simd, ENGINES.js)
const diffDb = 20 * Math.log10(check.maxAbsDiff / check.signalRms)
console.log(`SIMD vs JavaScript over 30 s: max |diff| ${check.maxAbsDiff.toExponential(2)} (${diffDb.toFixed(0)} dB below signal RMS)`)

// 2. Timing, fresh instances.
const results: Record<string, Stats> = {}
for (const [name, make] of Object.entries(makers)) {
  const engine = make()
  setUp(engine, inputs)
  results[name] = summarize(run(engine, blocks, () => performance.now()))
}

const cpu = os.cpus()[0]?.model ?? 'unknown CPU'
console.log(`\n${minutes} min of audio (${blocks} blocks of ${BLOCK_SIZE} @ ${SAMPLE_RATE} Hz), budget ${BUDGET_US.toFixed(0)} µs/block`)
console.log(`Node ${process.version} (V8 ${process.versions.v8}), ${cpu}\n`)

const LABEL = 22
const cols = ['p50', 'p99', 'p99.9', 'max', 'over budget', 'realtime ×'] as const
const row = (label: string, s: Stats) =>
  [label.padEnd(LABEL), ...[s.p50, s.p99, s.p999, s.max].map((v) => `${v.toFixed(1)} µs`.padStart(11)),
   String(s.overBudget).padStart(12), `${s.realtimeFactor.toFixed(0)}×`.padStart(11)].join('')
console.log(''.padEnd(LABEL) + cols.map((c) => c.padStart(c === 'over budget' ? 12 : 11)).join(''))
for (const [name, s] of Object.entries(results)) console.log(row(name, s))

const advantage = (faster: Stats, slower: Stats) =>
  `p50 ${(slower.p50 / faster.p50).toFixed(2)}×, throughput ${(faster.realtimeFactor / slower.realtimeFactor).toFixed(2)}×`
const simd = results[ENGINES.simd]
console.log(`\nSIMD vs scalar WASM: ${advantage(simd, results[ENGINES.scalar])}`)
console.log(`SIMD WASM vs JavaScript: ${advantage(simd, results[ENGINES.js])}`)

if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify({ date: new Date().toISOString(), minutes, node: process.version, v8: process.versions.v8, cpu, parity: { simdVsScalar: builds, simdVsJs: check }, results }, null, 2))
  console.log(`wrote ${jsonPath}`)
}
