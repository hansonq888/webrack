// Performance regression check: this build's engine against a base build
// (in CI, the previous commit's), on the same machine in the same run, so
// machine-to-machine differences cancel out. Rounds alternate base and
// current to spread noise evenly; each side's score is its median round.
//
//   node scripts/perf-check.ts --base <base engine.wasm> [--seconds 60] [--rounds 5]
//                              [--threshold 1.10] [--json out.json]
//
// Exits 1 if the current build is more than `threshold` times slower, or if
// the SIMD and scalar builds stop producing bit-identical audio. Also prints
// SIMD-vs-scalar and SIMD-vs-JavaScript ratios, to track over time.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import os from 'node:os'
import { BLOCK_SIZE } from '../src/bench/js-engine.ts'
import { ENGINES, SAMPLE_RATE, jsEngine, makeInputs, parity, run, setUp, wasmEngine, type BenchEngine } from '../src/bench/scenario.ts'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const basePath = arg('base', '')
if (!basePath) {
  console.error('usage: perf-check.ts --base <base engine.wasm> [--seconds 60] [--rounds 5] [--threshold 1.10] [--json out.json]')
  process.exit(2)
}
const seconds = Number(arg('seconds', '60'))
const rounds = Number(arg('rounds', '5'))
const threshold = Number(arg('threshold', '1.10'))
const jsonPath = arg('json', '')

const load = (path: string | URL) => new WebAssembly.Module(readFileSync(path))
const modules = {
  base: load(basePath),
  current: load(new URL('../public/engine.wasm', import.meta.url)),
  scalar: load(new URL('../public/engine-scalar.wasm', import.meta.url)),
}
const inputs = makeInputs()
const blocks = Math.floor((seconds * SAMPLE_RATE) / BLOCK_SIZE)

/** Mean µs per block over a fresh run of `seconds` of audio. */
function meanUs(make: () => BenchEngine): number {
  const engine = make()
  setUp(engine, inputs)
  const us = run(engine, blocks, () => performance.now())
  return us.reduce((a, b) => a + b, 0) / us.length
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

// 1. Correctness: the two current builds must still match bit for bit.
const a = wasmEngine(modules.current)
const b = wasmEngine(modules.scalar)
setUp(a, inputs)
setUp(b, inputs)
const identical = parity(a, b, Math.floor((10 * SAMPLE_RATE) / BLOCK_SIZE)).maxAbsDiff === 0

// 2. Regression: base vs current, alternating.
const baseRounds: number[] = []
const currentRounds: number[] = []
for (let r = 0; r < rounds; r++) {
  baseRounds.push(meanUs(() => wasmEngine(modules.base)))
  currentRounds.push(meanUs(() => wasmEngine(modules.current)))
}
const base = median(baseRounds)
const current = median(currentRounds)
const ratio = current / base

// 3. Tracking: the current build against its own scalar build and JavaScript.
const scalar = meanUs(() => wasmEngine(modules.scalar, ENGINES.scalar))
const js = meanUs(jsEngine)

const passed = identical && ratio <= threshold
const lines = [
  `| | mean µs per block |`,
  `|---|---|`,
  `| base build (median of ${rounds}) | ${base.toFixed(2)} |`,
  `| this build (median of ${rounds}) | ${current.toFixed(2)} |`,
  `| this build, scalar | ${scalar.toFixed(2)} |`,
  `| JavaScript port | ${js.toFixed(2)} |`,
  ``,
  `- This build vs base: **${ratio.toFixed(3)}×** the time (limit ${threshold}×): ${ratio <= threshold ? 'ok' : '**regression**'}`,
  `- SIMD vs scalar: ${(scalar / current).toFixed(2)}× faster; SIMD vs JavaScript: ${(js / current).toFixed(2)}× faster`,
  `- SIMD and scalar builds bit-identical: ${identical ? 'yes' : '**no**'}`,
  `- ${seconds} s of audio per round, ${os.cpus()[0]?.model ?? 'unknown CPU'}, Node ${process.version}`,
]
console.log(lines.join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Engine performance\n\n${lines.join('\n')}\n`)
if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify(
      { date: new Date().toISOString(), cpu: os.cpus()[0]?.model, node: process.version, seconds, rounds,
        baseRounds, currentRounds, base, current, ratio, threshold, scalar, js, identical, passed },
      null,
      2,
    ),
  )
}
process.exit(passed ? 0 : 1)
