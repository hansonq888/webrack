// The /bench page: runs the engine benchmark in this browser.
//  - Worker: the SIMD and scalar WASM builds and the JavaScript port, same
//    scenario as the Node runner.
//  - AudioWorklet: the WASM engine on the real audio thread, in real time,
//    repeated and optionally under CPU contention (audio-thread-run.ts).

import '@fontsource/geist-sans/latin-500.css'
import '@fontsource/geist-sans/latin-800.css'
import '@fontsource/geist-mono/latin-400.css'
import './bench.css'
import { runOnAudioThread, type AudioThreadRunResult } from './audio-thread-run.ts'
import type { WorkerReply, WorkerRequest } from './protocol.ts'
import { BUDGET_US, ENGINES, SAMPLE_RATE, type Stats } from './scenario.ts'
import { ENGINE_URLS, preferredBuild, simdSupported, type EngineBuild } from '../engine/build.ts'
import { BLOCK_SIZE } from './js-engine.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const compile = (build: EngineBuild) => WebAssembly.compileStreaming(fetch(ENGINE_URLS[build]))
const modules = { simd: simdSupported ? compile('simd') : null, scalar: compile('scalar') }
// The worklet run defaults to the build the app itself would load here.
const appBuild = preferredBuild()
const report: Record<string, unknown> = {}

// --- Environment --------------------------------------------------------------

function browserName(): string {
  const ua = navigator.userAgent
  const match =
    ua.match(/(Edg|OPR|Firefox|Chrome)\/(\d+)/) ?? (ua.includes('Safari') ? ua.match(/Version\/(\d+(?:\.\d+)?)/) : null)
  if (!match) return 'Unknown browser'
  if (match.length === 2) return `Safari ${match[1]}`
  const names: Record<string, string> = { Edg: 'Edge', OPR: 'Opera' }
  return `${names[match[1]] ?? match[1]} ${match[2]}`
}

/** Smallest step of performance.now(), in microseconds. */
function timerResolutionUs(): number {
  let best = Infinity
  for (let i = 0; i < 20_000; i++) {
    const a = performance.now()
    let b = performance.now()
    while (b === a) b = performance.now()
    best = Math.min(best, b - a)
  }
  return best * 1000
}

function readEnvironment() {
  return {
    browser: browserName(),
    platform: navigator.platform,
    cores: navigator.hardwareConcurrency,
    crossOriginIsolated,
    timerResolutionUs: Number(timerResolutionUs().toFixed(1)),
    simdSupported,
  }
}

function showEnvironment(env: ReturnType<typeof readEnvironment>): void {
  $('env').innerHTML = `
    <div><dt>Browser</dt><dd>${env.browser} · ${env.platform}, ${env.cores} cores</dd></div>
    <div><dt>WASM</dt><dd>${env.simdSupported ? 'SIMD supported' : 'no SIMD: the app runs the scalar build'}</dd></div>
    <div><dt>Timer</dt><dd>${env.timerResolutionUs} µs steps${env.crossOriginIsolated ? '' : ' (not cross-origin isolated: coarse)'}</dd></div>
    <div><dt>Budget</dt><dd>${BUDGET_US.toFixed(0)} µs per ${BLOCK_SIZE}-frame block at ${SAMPLE_RATE / 1000} kHz</dd></div>`
}

// --- Results ------------------------------------------------------------------

const us = (v: number) => `${v.toFixed(1)} µs`

function statsRow(name: string, s: Stats, mean = s.mean, extra = ''): string {
  return `<tr><th>${name}</th><td>${us(s.p50)}</td><td>${us(s.p95)}</td><td>${us(s.p99)}</td>
    <td>${us(s.p999)}</td><td>${us(s.max)}</td><td>${us(mean)}</td>
    <td>${s.overBudget} / ${s.blocks.toLocaleString('en-US')}</td>${extra}</tr>`
}

function table(rows: string, extraHeader = ''): string {
  return `<table><thead><tr><th></th><th>p50</th><th>p95</th><th>p99</th><th>p99.9</th><th>max</th>
    <th>mean</th><th>missed deadlines</th>${extraHeader}</tr></thead><tbody>${rows}</tbody></table>`
}

/** "lo–hi" of one statistic across runs. */
function range(values: number[], digits = 1): string {
  const [lo, hi] = [Math.min(...values), Math.max(...values)]
  return lo === hi ? lo.toFixed(digits) : `${lo.toFixed(digits)}–${hi.toFixed(digits)}`
}

// --- Worker benchmark ---------------------------------------------------------

async function runWorker(button: HTMLButtonElement): Promise<void> {
  const minutes = Number($<HTMLSelectElement>('minutes').value)
  const status = $('worker-status')
  button.disabled = true
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  if (!modules.simd) {
    status.textContent = 'This browser has no WebAssembly SIMD, so there is no SIMD build to compare.'
    button.disabled = false
    return
  }
  worker.postMessage({ modules: { simd: await modules.simd, scalar: await modules.scalar }, minutes } satisfies WorkerRequest)
  worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
    if (data.type === 'progress') {
      status.textContent = `${data.label}…`
      return
    }
    worker.terminate()
    button.disabled = false
    const [simd, scalar, js] = [data.results[ENGINES.simd], data.results[ENGINES.scalar], data.results[ENGINES.js]]
    const speedup = (slower: { wallMeanUs: number }) => (slower.wallMeanUs / simd.wallMeanUs).toFixed(2)
    status.textContent =
      `${minutes} min of audio per engine. The SIMD and scalar builds are ` +
      `${data.buildsIdentical ? 'bit-identical' : 'NOT identical (a bug)'}; JavaScript matches to ` +
      `${Math.round(-data.parityDb)} dB below the signal.`
    $('worker-results').innerHTML =
      table(Object.entries(data.results).map(([name, s]) => statsRow(name, s, s.wallMeanUs)).join('')) +
      // The headline uses wall-clock mean time: per-block percentiles are
      // rounded to the timer's step (5 µs in Chrome), the mean is not.
      `<p class="verdict">SIMD WASM is <b>${speedup(scalar)}×</b> faster than the scalar build and
       <b>${speedup(js)}×</b> faster than JavaScript (mean block time: ${us(simd.wallMeanUs)},
       ${us(scalar.wallMeanUs)}, ${us(js.wallMeanUs)}). Percentiles are rounded to the timer's
       ${env.timerResolutionUs} µs steps.</p>`
    report.worker = { minutes, buildsIdentical: data.buildsIdentical, parityDb: data.parityDb, results: data.results }
  }
}

// --- AudioWorklet benchmark ---------------------------------------------------

async function runWorklet(button: HTMLButtonElement): Promise<void> {
  const status = $('worklet-status')
  const seconds = Number($<HTMLSelectElement>('wl-seconds').value)
  const build = $<HTMLSelectElement>('wl-build').value as EngineBuild
  const runs = Number($<HTMLSelectElement>('wl-runs').value)
  const contentionChoice = $<HTMLSelectElement>('wl-contention').value
  // "All other cores" leaves one for the audio thread and one for the clock.
  const contention = contentionChoice === 'all' ? Math.max(0, navigator.hardwareConcurrency - 2) : Number(contentionChoice)
  const module = await modules[build]
  if (!module) {
    status.textContent = 'This browser has no WebAssembly SIMD; choose the scalar build.'
    return
  }

  button.disabled = true
  const results: AudioThreadRunResult[] = []
  try {
    for (let i = 0; i < runs; i++) {
      status.textContent = `Run ${i + 1} of ${runs}: ${seconds} s on the audio thread (silent)…`
      results.push(await runOnAudioThread({ module, seconds, contention }))
    }
  } finally {
    button.disabled = false
  }

  const underrunText = (r: AudioThreadRunResult) => (r.underruns ? String(r.underruns.events) : 'n/a')
  const rows = results
    .map((r, i) => statsRow(`Run ${i + 1}`, r.stats, r.stats.mean, `<td>${underrunText(r)}</td>`))
    .join('')
  const stats = results.map((r) => r.stats)
  const missed = stats.reduce((n, s) => n + s.overBudget, 0)
  const blocks = stats.reduce((n, s) => n + s.blocks, 0)
  const underruns = results.every((r) => r.underruns)
    ? `${results.reduce((n, r) => n + r.underruns!.events, 0)} output underruns reported by the browser`
    : 'underruns: not reported by this browser'
  status.textContent =
    `${ENGINES[build]}, ${runs} × ${seconds} s at ${results[0].sampleRate / 1000} kHz, ` +
    `${contention ? `${contention} busy cores` : 'no added contention'}, full chain.`
  $('worklet-results').innerHTML =
    table(rows, '<th>underruns</th>') +
    `<p class="verdict">Across runs: p50 <b>${range(stats.map((s) => s.p50))} µs</b>, p99
     <b>${range(stats.map((s) => s.p99))} µs</b>, max ${range(stats.map((s) => s.max))} µs;
     <b>${missed}</b> of ${blocks.toLocaleString('en-US')} blocks missed the ${BUDGET_US.toFixed(0)} µs deadline;
     ${underruns}.</p>`
  const slowestText = results
    .map((r, i) => `run ${i + 1}: ` + r.slowest.slice(0, 3).map((b) => `block ${b.block} (${us(b.us)})`).join(', '))
    .join('; ')
  $('worklet-results').innerHTML += `<p class="note">Slowest blocks: ${slowestText}.</p>`
  report.worklet = { build, seconds, runs, contention, fullChain: true, results }
}

// --- Page ---------------------------------------------------------------------

$<HTMLSelectElement>('wl-build').value = appBuild
const env = readEnvironment()
report.environment = env
showEnvironment(env)
$<HTMLButtonElement>('run-worker').addEventListener('click', (e) => void runWorker(e.currentTarget as HTMLButtonElement))
$<HTMLButtonElement>('run-worklet').addEventListener('click', (e) => void runWorklet(e.currentTarget as HTMLButtonElement))
const reportJson = () => JSON.stringify({ date: new Date().toISOString(), ...report }, null, 2)

$<HTMLButtonElement>('download').addEventListener('click', () => {
  // One file per browser, so runs from Chrome, Firefox and Safari sit side by side.
  const name = `webrack-bench-${env.browser.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([reportJson()], { type: 'application/json' }))
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
})
$<HTMLButtonElement>('copy').addEventListener('click', async (e) => {
  const button = e.currentTarget as HTMLButtonElement
  await navigator.clipboard.writeText(reportJson())
  button.textContent = 'Copied'
  setTimeout(() => (button.textContent = 'Copy results as JSON'), 1500)
})
