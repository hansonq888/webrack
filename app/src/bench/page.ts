// The /bench page: runs the engine benchmark in this browser.
//  - Worker: C++/WASM vs the JavaScript port, same scenario as the Node runner.
//  - AudioWorklet: the WASM engine on the real audio thread, in real time.

import '@fontsource/geist-sans/latin-500.css'
import '@fontsource/geist-sans/latin-800.css'
import '@fontsource/geist-mono/latin-400.css'
import './bench.css'
import workletUrl from './worklet.ts?worker&url'
import { CLOCK_WORDS, type ClockCalibration, type WorkerReply, type WorkerRequest, type WorkletOptions, type WorkletReply } from './protocol.ts'
import { BUDGET_US, SAMPLE_RATE, makeInputs, summarize, type Stats } from './scenario.ts'
import { BLOCK_SIZE } from './js-engine.ts'

const WORKLET_SECONDS = 30

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const module = WebAssembly.compileStreaming(fetch('/engine.wasm'))
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
  }
}

function showEnvironment(env: ReturnType<typeof readEnvironment>): void {
  $('env').innerHTML = `
    <div><dt>Browser</dt><dd>${env.browser} · ${env.platform}, ${env.cores} cores</dd></div>
    <div><dt>Timer</dt><dd>${env.timerResolutionUs} µs steps${env.crossOriginIsolated ? '' : ' (not cross-origin isolated: coarse)'}</dd></div>
    <div><dt>Budget</dt><dd>${BUDGET_US.toFixed(0)} µs per ${BLOCK_SIZE}-frame block at ${SAMPLE_RATE / 1000} kHz</dd></div>`
}

// --- Results ------------------------------------------------------------------

const us = (v: number) => `${v.toFixed(1)} µs`

function statsRow(name: string, s: Stats, mean = s.mean): string {
  return `<tr><th>${name}</th><td>${us(s.p50)}</td><td>${us(s.p99)}</td><td>${us(s.p999)}</td>
    <td>${us(mean)}</td><td>${s.overBudget}</td><td>${Math.round(s.realtimeFactor)}×</td></tr>`
}

function table(rows: string): string {
  return `<table><thead><tr><th></th><th>p50</th><th>p99</th><th>p99.9</th><th>mean</th>
    <th>over budget</th><th>real time</th></tr></thead><tbody>${rows}</tbody></table>`
}

// --- Worker benchmark ---------------------------------------------------------

async function runWorker(button: HTMLButtonElement): Promise<void> {
  const minutes = Number($<HTMLSelectElement>('minutes').value)
  const status = $('worker-status')
  button.disabled = true
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  worker.postMessage({ module: await module, minutes } satisfies WorkerRequest)
  worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
    if (data.type === 'progress') {
      status.textContent = `${data.label}…`
      return
    }
    worker.terminate()
    button.disabled = false
    const [wasm, js] = [data.results['C++ → WASM'], data.results['JavaScript']]
    status.textContent = `${minutes} min of audio per engine. Outputs match to ${Math.round(-data.parityDb)} dB below the signal.`
    $('worker-results').innerHTML =
      table(Object.entries(data.results).map(([name, s]) => statsRow(name, s, s.wallMeanUs)).join('')) +
      // The headline uses wall-clock mean time: per-block percentiles are
      // rounded to the timer's step (5 µs in Chrome), the mean is not.
      `<p class="verdict">WASM is <b>${(js.wallMeanUs / wasm.wallMeanUs).toFixed(1)}×</b> faster
       (mean block time, ${us(wasm.wallMeanUs)} vs ${us(js.wallMeanUs)}).
       Percentiles are rounded to the timer's ${env.timerResolutionUs} µs steps.</p>`
    report.worker = { minutes, parityDb: data.parityDb, results: data.results }
  }
}

// --- AudioWorklet benchmark ---------------------------------------------------

async function runWorklet(button: HTMLButtonElement): Promise<void> {
  const status = $('worklet-status')
  button.disabled = true
  status.textContent = `Running for ${WORKLET_SECONDS} s on the audio thread (silent)…`
  const clockBuffer = new SharedArrayBuffer(CLOCK_WORDS * 4)
  const clock = new Worker(new URL('./tick-clock.ts', import.meta.url), { type: 'module' })
  const calibration = new Promise<ClockCalibration>((resolve) => (clock.onmessage = (e) => resolve(e.data)))
  clock.postMessage(clockBuffer)
  const context = new AudioContext({ sampleRate: SAMPLE_RATE })
  try {
    await context.audioWorklet.addModule(workletUrl)
    const blocks = Math.floor((WORKLET_SECONDS * context.sampleRate) / BLOCK_SIZE)
    const node = new AudioWorkletNode(context, 'webrack-bench', {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: { module: await module, inputs: makeInputs(), blocks, clock: clockBuffer } satisfies WorkletOptions,
    })
    // Silent: the node's output is never written, and a zero gain guards the speakers anyway.
    node.connect(new GainNode(context, { gain: 0 })).connect(context.destination)
    await context.resume()
    const { ticks } = await new Promise<WorkletReply>((resolve) => (node.port.onmessage = (e) => resolve(e.data)))

    Atomics.store(new Int32Array(clockBuffer), 1, 1) // stop the clock
    const cal = await calibration
    const usPerTick = (cal.ms * 1000) / cal.ticks
    const stats = summarize(ticks.map((t) => t * usPerTick))
    status.textContent =
      `${WORKLET_SECONDS} s in real time at ${context.sampleRate / 1000} kHz, timed inside the AudioWorklet ` +
      `with a shared-memory clock (${(1 / usPerTick).toFixed(0)} ticks per µs).`
    $('worklet-results').innerHTML = table(statsRow('C++ → WASM', stats))
    report.worklet = { seconds: WORKLET_SECONDS, sampleRate: context.sampleRate, clockTicksPerUs: 1 / usPerTick, stats }
  } finally {
    clock.terminate()
    await context.close()
    button.disabled = false
  }
}

// --- Page ---------------------------------------------------------------------

const env = readEnvironment()
report.environment = env
showEnvironment(env)
$<HTMLButtonElement>('run-worker').addEventListener('click', (e) => void runWorker(e.currentTarget as HTMLButtonElement))
$<HTMLButtonElement>('run-worklet').addEventListener('click', (e) => void runWorklet(e.currentTarget as HTMLButtonElement))
$<HTMLButtonElement>('copy').addEventListener('click', async (e) => {
  const button = e.currentTarget as HTMLButtonElement
  await navigator.clipboard.writeText(JSON.stringify({ date: new Date().toISOString(), ...report }, null, 2))
  button.textContent = 'Copied'
  setTimeout(() => (button.textContent = 'Copy results as JSON'), 1500)
})
