// Times the engine on the real audio thread: an AudioWorkletProcessor that
// runs the benchmark scenario in real time and records how many ticks of the
// shared clock (tick-clock.ts) each wr_process() call takes. Output is silent.

import type { WorkletOptions, WorkletReply } from './protocol.ts'
import { setUp, wasmEngine, type BenchEngine } from './scenario.ts'

class BenchProcessor extends AudioWorkletProcessor {
  private readonly engine: BenchEngine
  private readonly clock: Int32Array
  private readonly ticks: Float64Array
  private block = 0

  constructor(options: AudioWorkletNodeOptions) {
    super(options)
    const opts = options.processorOptions as WorkletOptions
    this.engine = wasmEngine(opts.module)
    setUp(this.engine, opts.inputs)
    this.clock = new Int32Array(opts.clock)
    this.ticks = new Float64Array(opts.blocks)
  }

  process(): boolean {
    if (this.block === this.ticks.length) return false
    if (!this.engine.songPlaying()) this.engine.setSongPlaying(true)
    const t0 = Atomics.load(this.clock, 0)
    this.engine.process()
    this.ticks[this.block++] = (Atomics.load(this.clock, 0) - t0) | 0
    if (this.block === this.ticks.length) this.port.postMessage({ ticks: this.ticks } satisfies WorkletReply)
    return true
  }
}

registerProcessor('webrack-bench', BenchProcessor)
