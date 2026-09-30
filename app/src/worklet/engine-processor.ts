// Runs on the audio thread. Instantiates engine.wasm (compiled on the main
// thread and passed in via processorOptions), drains the command ring at the
// start of every block, renders one 128-frame block, and publishes status.
//
// The same processor runs live (AudioContext, commands via the SPSC ring) and
// for export (OfflineAudioContext, full state passed up front in
// processorOptions), so an export is rendered by exactly the code you hear.

import { RingReader } from '../engine/ring'
import {
  Op,
  STATUS_WORDS,
  StatusIndex,
  type InitialState,
  type PortMessage,
  type ProcessorOptions,
  type ProcessorReply,
} from '../engine/protocol'

interface EngineExports {
  memory: WebAssembly.Memory
  _initialize(): void
  wr_init(sampleRate: number): void
  wr_process(): void
  wr_output(channel: number): number
  wr_block_size(): number
  wr_status(): number
  wr_pad_data(pad: number): number
  wr_pad_capacity(): number
  wr_pad_begin(pad: number): void
  wr_pad_commit(pad: number, frames: number): void
  wr_trigger(pad: number, gain: number): void
  wr_set_step(pad: number, step: number, on: number): void
  wr_clear_pattern(): void
  wr_set_bpm(bpm: number): void
  wr_set_playing(playing: number): void
  wr_stop_after_steps(steps: number): void
  wr_set_pattern_length(steps: number): void
  wr_stop_all(): void
  wr_set_drive(drive: number): void
  wr_set_filter(position: number): void
  wr_set_width(width: number): void
  wr_song_data(): number
  wr_song_capacity(): number
  wr_song_begin(): void
  wr_song_commit(frames: number): void
  wr_song_set_playing(playing: number): void
  wr_song_seek(frame: number): void
  wr_set_speed(speed: number): void
  wr_set_eq_gain(band: number, db: number): void
  wr_set_reverb(param: number, value: number): void
  wr_set_master_gain(gain: number): void
}

const STATUS_POST_INTERVAL = 8 // blocks between status posts without SharedArrayBuffer

class EngineProcessor extends AudioWorkletProcessor {
  private readonly engine: EngineExports
  private readonly outL: Float32Array
  private readonly outR: Float32Array
  private readonly engineStatus: Int32Array
  private readonly ring: RingReader | null
  private readonly status: Int32Array
  private readonly apply = (op: number, a: number, b: number, f: number) => this.applyCommand(op, a, b, f)
  private blocks = 0

  constructor(options: AudioWorkletNodeOptions) {
    super(options)
    const opts = options.processorOptions as ProcessorOptions
    const instance = new WebAssembly.Instance(opts.module, {})
    const engine = instance.exports as unknown as EngineExports
    engine._initialize()
    engine.wr_init(sampleRate)
    this.engine = engine

    // Memory never grows, so these views stay valid for the processor's life.
    const buffer = engine.memory.buffer
    const blockSize = engine.wr_block_size()
    this.outL = new Float32Array(buffer, engine.wr_output(0), blockSize)
    this.outR = new Float32Array(buffer, engine.wr_output(1), blockSize)
    this.engineStatus = new Int32Array(buffer, engine.wr_status(), StatusIndex.Blocks)

    this.ring = opts.ring ? new RingReader(opts.ring) : null
    this.status = opts.status ? new Int32Array(opts.status) : new Int32Array(STATUS_WORDS)

    if (opts.initial) this.loadInitial(opts.initial)

    this.port.onmessage = (event: MessageEvent<PortMessage>) => this.onMessage(event.data)
    this.reply({ type: 'ready', padCapacity: engine.wr_pad_capacity(), songCapacity: engine.wr_song_capacity() })
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    this.ring?.drain(this.apply)
    this.engine.wr_process()

    const [left, right] = outputs[0]
    left.set(this.outL)
    right?.set(this.outR)

    this.blocks++
    this.status.set(this.engineStatus)
    this.status[StatusIndex.Blocks] = this.blocks
    if (!this.ring && this.blocks % STATUS_POST_INTERVAL === 0) {
      this.reply({ type: 'status', status: this.status.slice().buffer })
    }
    return true
  }

  private applyCommand(op: number, a: number, b: number, f: number): void {
    const e = this.engine
    switch (op) {
      case Op.Trigger: e.wr_trigger(a, f); break
      case Op.SetStep: e.wr_set_step(a, b, f ? 1 : 0); break
      case Op.ClearPattern: e.wr_clear_pattern(); break
      case Op.Bpm: e.wr_set_bpm(f); break
      case Op.Playing: e.wr_set_playing(a); break
      case Op.Speed: e.wr_set_speed(f); break
      case Op.EqGain: e.wr_set_eq_gain(a, f); break
      case Op.Reverb: e.wr_set_reverb(a, f); break
      case Op.SongPlaying: e.wr_song_set_playing(a); break
      case Op.SongSeek: e.wr_song_seek(a); break
      case Op.MasterGain: e.wr_set_master_gain(f); break
      case Op.StopAfterSteps: e.wr_stop_after_steps(a); break
      case Op.PatternLength: e.wr_set_pattern_length(a); break
      case Op.StopAll: e.wr_stop_all(); break
      case Op.Drive: e.wr_set_drive(f); break
      case Op.Filter: e.wr_set_filter(f); break
      case Op.Width: e.wr_set_width(f); break
    }
  }

  private loadInitial({ pads, song, commands }: InitialState): void {
    pads.forEach((data, pad) => this.onMessage({ type: 'pad', pad, data }))
    if (song) {
      this.onMessage({ type: 'song-begin' })
      const frames = Math.min(song.length / 2, this.engine.wr_song_capacity())
      this.onMessage({ type: 'song-chunk', offset: 0, data: song.subarray(0, frames * 2) })
      this.onMessage({ type: 'song-commit', frames })
    }
    for (const [op, a, b, f] of commands) this.applyCommand(op, a, b, f)
  }

  // Bulk loads arrive here, between render calls on the audio thread. Copies
  // are bounded: one pad (≤ 10 s) or one song chunk (1 s) per message.
  private onMessage(msg: PortMessage): void {
    const e = this.engine
    switch (msg.type) {
      case 'commands':
        for (const [op, a, b, f] of msg.commands) this.applyCommand(op, a, b, f)
        break
      case 'pad': {
        e.wr_pad_begin(msg.pad)
        if (msg.data) {
          const frames = Math.min(msg.data.length, e.wr_pad_capacity())
          new Float32Array(e.memory.buffer, e.wr_pad_data(msg.pad), frames).set(msg.data.subarray(0, frames))
          e.wr_pad_commit(msg.pad, frames)
        }
        break
      }
      case 'song-begin':
        e.wr_song_begin()
        break
      case 'song-chunk':
        new Int16Array(e.memory.buffer, e.wr_song_data() + msg.offset * 4, msg.data.length).set(msg.data)
        break
      case 'song-commit':
        e.wr_song_commit(msg.frames)
        break
    }
    if (msg.id !== undefined) this.reply({ type: 'ack', id: msg.id })
  }

  private reply(msg: ProcessorReply): void {
    this.port.postMessage(msg)
  }
}

registerProcessor('webrack-engine', EngineProcessor)
