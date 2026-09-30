// Runs the JS-vs-WASM benchmark in a Web Worker, so the page stays responsive
// and the timing loop has a thread to itself. Same scenario and statistics
// as the Node runner (scripts/bench.ts).

import { BLOCK_SIZE } from './js-engine.ts'
import type { WorkerReply, WorkerRequest } from './protocol.ts'
import { SAMPLE_RATE, jsEngine, makeInputs, parity, run, setUp, summarize, wasmEngine } from './scenario.ts'

const post = (msg: WorkerReply) => postMessage(msg)

onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  const blocks = Math.floor((data.minutes * 60 * SAMPLE_RATE) / BLOCK_SIZE)
  const inputs = makeInputs()

  post({ type: 'progress', label: 'Checking both engines render the same audio' })
  const a = wasmEngine(data.module)
  const b = jsEngine()
  setUp(a, inputs)
  setUp(b, inputs)
  const check = parity(a, b, Math.floor((30 * SAMPLE_RATE) / BLOCK_SIZE))
  const parityDb = 20 * Math.log10(check.maxAbsDiff / check.signalRms)

  const results: Record<string, ReturnType<typeof summarize> & { wallMeanUs: number }> = {}
  for (const make of [() => wasmEngine(data.module), jsEngine]) {
    const engine = make()
    post({ type: 'progress', label: `Timing ${engine.name}` })
    setUp(engine, inputs)
    const t0 = performance.now()
    const us = run(engine, blocks, () => performance.now())
    // Mean from wall-clock time: exact even when the timer is coarse.
    results[engine.name] = { ...summarize(us), wallMeanUs: ((performance.now() - t0) * 1000) / blocks }
  }
  post({ type: 'done', parityDb, results })
}
