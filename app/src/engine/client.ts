import processorUrl from '../worklet/engine-processor.ts?worker&url'
import { createRingBuffer, RingWriter } from './ring'
import {
  Op,
  STATUS_WORDS,
  StatusIndex,
  type Command,
  type InitialState,
  type PortMessage,
  type ProcessorOptions,
  type ProcessorReply,
} from './protocol'

// Compile the engine as soon as the page loads, so the Start tap only has to
// create the AudioContext and the node.
const engineModule = WebAssembly.compileStreaming(fetch('/engine.wasm'))

export interface EngineStatus {
  step: number
  seqPlaying: boolean
  peakLeft: number
  peakRight: number
  songFrame: number
  songLength: number
  songPlaying: boolean
  voices: number
  blocks: number
}

const SONG_CHUNK_FRAMES = 48_000

async function createNode(context: BaseAudioContext, options: ProcessorOptions): Promise<AudioWorkletNode> {
  await context.audioWorklet.addModule(processorUrl)
  return new AudioWorkletNode(context, 'webrack-engine', {
    numberOfInputs: 0,
    outputChannelCount: [2],
    processorOptions: options,
  })
}

/**
 * Renders `frames` of audio offline with the same processor as live playback,
 * starting from `initial`. Returns the rendered buffer.
 */
export async function renderOffline(sampleRate: number, frames: number, initial: InitialState): Promise<AudioBuffer> {
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: frames, sampleRate })
  const node = await createNode(context, { module: await engineModule, ring: null, status: null, initial })
  node.connect(context.destination)
  return context.startRendering()
}

// UI-thread handle to the live engine processor.
export class EngineClient {
  readonly padCapacity: number
  readonly songCapacity: number
  private readonly ring: RingWriter | null
  private readonly statusInts: Int32Array
  private readonly statusFloats: Float32Array
  private nextId = 1
  private readonly pending = new Map<number, () => void>()

  readonly context: AudioContext
  readonly node: AudioWorkletNode
  /** A tap on the live output for visualizers (the audio path is unaffected). */
  readonly analyser: AnalyserNode

  private constructor(
    context: AudioContext,
    node: AudioWorkletNode,
    ready: { padCapacity: number; songCapacity: number },
    ring: SharedArrayBuffer | null,
    status: SharedArrayBuffer | null,
  ) {
    this.context = context
    this.node = node
    this.analyser = context.createAnalyser()
    this.analyser.fftSize = 2048
    this.analyser.smoothingTimeConstant = 0.72
    node.connect(this.analyser)
    this.padCapacity = ready.padCapacity
    this.songCapacity = ready.songCapacity
    this.ring = ring ? new RingWriter(ring) : null
    const statusBuffer = status ?? new ArrayBuffer(STATUS_WORDS * 4)
    this.statusInts = new Int32Array(statusBuffer)
    this.statusFloats = new Float32Array(statusBuffer)
    node.port.onmessage = (event: MessageEvent<ProcessorReply>) => {
      const msg = event.data
      if (msg.type === 'ack') {
        this.pending.get(msg.id)?.()
        this.pending.delete(msg.id)
      } else if (msg.type === 'status') {
        this.statusInts.set(new Int32Array(msg.status))
      }
    }
  }

  /** Creates the live engine node, talking over the SPSC ring when SharedArrayBuffer is available. */
  static async create(context: AudioContext): Promise<EngineClient> {
    const shared = typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated
    const ring = shared ? createRingBuffer() : null
    const status = shared ? new SharedArrayBuffer(STATUS_WORDS * 4) : null
    const node = await createNode(context, { module: await engineModule, ring, status })
    const ready = await new Promise<{ padCapacity: number; songCapacity: number }>((resolve) => {
      node.port.onmessage = (event: MessageEvent<ProcessorReply>) => {
        if (event.data.type === 'ready') resolve(event.data)
      }
    })
    node.connect(context.destination)
    return new EngineClient(context, node, ready, ring, status)
  }

  get usesSharedMemory(): boolean {
    return this.ring !== null
  }

  // --- Commands (real-time path) ---------------------------------------

  send(command: Command): void {
    if (!this.ring?.push(command)) this.post({ type: 'commands', commands: [command] })
  }

  trigger(pad: number, gain = 1): void {
    this.send([Op.Trigger, pad, 0, gain])
  }
  setStep(pad: number, step: number, on: boolean): void {
    this.send([Op.SetStep, pad, step, on ? 1 : 0])
  }
  setBpm(bpm: number): void {
    this.send([Op.Bpm, 0, 0, bpm])
  }
  setPlaying(playing: boolean): void {
    this.send([Op.Playing, playing ? 1 : 0, 0, 0])
  }
  setSpeed(speed: number): void {
    this.send([Op.Speed, 0, 0, speed])
  }
  setEqGain(band: number, db: number): void {
    this.send([Op.EqGain, band, 0, db])
  }
  setReverb(param: number, value: number): void {
    this.send([Op.Reverb, param, 0, value])
  }
  setSongPlaying(playing: boolean): void {
    this.send([Op.SongPlaying, playing ? 1 : 0, 0, 0])
  }
  seekSong(frame: number): void {
    this.send([Op.SongSeek, frame, 0, 0])
  }

  /** Applies a batch of commands and resolves once the processor has them. */
  applyNow(commands: Command[]): Promise<void> {
    return this.request({ type: 'commands', commands })
  }

  // --- Bulk data (port messages) -----------------------------------------

  loadPad(pad: number, data: Float32Array | null): Promise<void> {
    // Copy: the caller keeps its buffer, and transferring detaches it.
    const copy = data ? data.slice(0, this.padCapacity) : null
    return this.request({ type: 'pad', pad, data: copy }, copy ? [copy.buffer] : [])
  }

  /** Loads interleaved stereo int16 in 1 s chunks, so no single copy on the audio thread is large. */
  async loadSong(interleaved: Int16Array): Promise<void> {
    const frames = Math.min(interleaved.length / 2, this.songCapacity)
    await this.request({ type: 'song-begin' })
    for (let offset = 0; offset < frames; offset += SONG_CHUNK_FRAMES) {
      const end = Math.min(frames, offset + SONG_CHUNK_FRAMES)
      const data = interleaved.slice(offset * 2, end * 2)
      this.post({ type: 'song-chunk', offset, data }, [data.buffer])
    }
    await this.request({ type: 'song-commit', frames })
  }

  // --- Status ---------------------------------------------------------------

  status(): EngineStatus {
    const i = this.statusInts
    return {
      step: i[StatusIndex.Step],
      seqPlaying: i[StatusIndex.SeqPlaying] !== 0,
      peakLeft: this.statusFloats[StatusIndex.PeakLeft],
      peakRight: this.statusFloats[StatusIndex.PeakRight],
      songFrame: i[StatusIndex.SongFrame],
      songLength: i[StatusIndex.SongLength],
      songPlaying: i[StatusIndex.SongPlaying] !== 0,
      voices: i[StatusIndex.Voices],
      blocks: i[StatusIndex.Blocks],
    }
  }

  dispose(): void {
    this.node.disconnect()
    this.node.port.close()
  }

  private post(msg: PortMessage, transfer: Transferable[] = []): void {
    this.node.port.postMessage(msg, transfer)
  }

  private request(msg: PortMessage, transfer: Transferable[] = []): Promise<void> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.post({ ...msg, id }, transfer)
    })
  }
}
