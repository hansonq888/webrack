// Runs the engine benchmark in a Web Worker, so the page stays responsive and
// the timing loop has a thread to itself. Same scenario and statistics as the
// Node runner (scripts/bench.ts): the SIMD and scalar WASM builds and the
// JavaScript port.

import { BLOCK_SIZE } from './js-engine.ts'
import type { WorkerReply, WorkerRequest } from './protocol.ts'
import {
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
} from './scenario.ts'

const post = (msg: WorkerReply) => postMessage(msg)

onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  const blocks = Math.floor((data.minutes * 60 * SAMPLE_RATE) / BLOCK_SIZE)
  const inputs = makeInputs()
  const makers: Record<string, () => BenchEngine> = {
    [ENGINES.simd]: () => wasmEngine(data.modules.simd, ENGINES.simd),
    [ENGINES.scalar]: () => wasmEngine(data.modules.scalar, ENGINES.scalar),
    [ENGINES.js]: jsEngine,
  }
  const parityOf = (a: string, b: string) => {
    const [x, y] = [makers[a](), makers[b]()]
    setUp(x, inputs)
    setUp(y, inputs)
    return parity(x, y, Math.floor((30 * SAMPLE_RATE) / BLOCK_SIZE))
  }

  post({ type: 'progress', label: 'Checking all three engines render the same audio' })
  const builds = parityOf(ENGINES.simd, ENGINES.scalar)
  const js = parityOf(ENGINES.simd, ENGINES.js)

  const results: Record<string, ReturnType<typeof summarize> & { wallMeanUs: number }> = {}
  for (const [name, make] of Object.entries(makers)) {
    post({ type: 'progress', label: `Timing ${name}` })
    const engine = make()
    setUp(engine, inputs)
    const t0 = performance.now()
    const us = run(engine, blocks, () => performance.now())
    // Mean from wall-clock time: exact even when the timer is coarse.
    results[name] = { ...summarize(us), wallMeanUs: ((performance.now() - t0) * 1000) / blocks }
  }
  post({
    type: 'done',
    buildsIdentical: builds.maxAbsDiff === 0,
    parityDb: 20 * Math.log10(js.maxAbsDiff / js.signalRms),
    results,
  })
}
