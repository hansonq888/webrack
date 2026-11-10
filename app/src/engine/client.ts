import processorUrl from '../worklet/engine-processor.ts?worker&url'
import { ENGINE_URLS, preferredBuild } from './build'
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

/** The engine build this browser runs: SIMD, or the scalar fallback. */
export const engineBuild = preferredBuild()

// Compile the engine as soon as the page loads, so the Start tap only has to
// create the AudioContext and the node.
const engineModule = WebAssembly.compileStreaming(fetch(ENGINE_URLS[engineBuild]))

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

// One live processor and the shared memory it talks over. Replaced as a
// whole when the engine restarts after a crash.
interface Connection {
  node: AudioWorkletNode
  ring: RingWriter | null
  statusInts: Int32Array
  statusFloats: Float32Array
  padCapacity: number
  songCapacity: number
}

/** Creates a live processor (optionally starting from `initial`) and waits until it's ready. */
async function connect(context: AudioContext, initial?: InitialState): Promise<Connection> {
  const shared = typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated
  const ring = shared ? createRingBuffer() : null
  const status = shared ? new SharedArrayBuffer(STATUS_WORDS * 4) : new ArrayBuffer(STATUS_WORDS * 4)
  const node = await createNode(context, {
    module: await engineModule,
    ring,
    status: shared ? (status as SharedArrayBuffer) : null,
    initial,
  })
  const ready = await new Promise<{ padCapacity: number; songCapacity: number }>((resolve) => {
    node.port.onmessage = (event: MessageEvent<ProcessorReply>) => {
      if (event.data.type === 'ready') resolve(event.data)
    }
  })
  return {
    node,
    ring: ring ? new RingWriter(ring) : null,
    statusInts: new Int32Array(status),
    statusFloats: new Float32Array(status),
    padCapacity: ready.padCapacity,
    songCapacity: ready.songCapacity,
  }
}

// UI-thread handle to the live engine processor.
export class EngineClient {
  readonly context: AudioContext
  /** A tap on the live output for visualizers (the audio path is unaffected). */
  readonly analyser: AnalyserNode
  readonly padCapacity: number
  readonly songCapacity: number
  /**
   * Called when the processor crashes (an uncaught error or a WebAssembly
   * trap on the audio thread). The engine is silent until restart() runs.
   */
  onCrash: (() => void) | null = null

  private conn: Connection
  private nextId = 1
  private readonly pending = new Map<number, () => void>()

  private constructor(context: AudioContext, conn: Connection) {
    this.context = context
    this.analyser = context.createAnalyser()
    this.analyser.fftSize = 2048
    this.analyser.smoothingTimeConstant = 0.72
    this.padCapacity = conn.padCapacity
    this.songCapacity = conn.songCapacity
    this.conn = conn
    this.attach(conn)
  }

  /** Creates the live engine node, talking over the SPSC ring when SharedArrayBuffer is available. */
  static async create(context: AudioContext): Promise<EngineClient> {
    return new EngineClient(context, await connect(context))
  }

  /**
   * Replaces a crashed processor with a fresh one that starts from `initial`
   * (the kit, song and settings), with new shared memory.
   */
  async restart(initial: InitialState): Promise<void> {
    const next = await connect(this.context, initial)
    const old = this.conn
    old.node.onprocessorerror = null
    old.node.disconnect()
    old.node.port.close()
    // The old processor will never answer; let anyone awaiting it move on.
    for (const resolve of this.pending.values()) resolve()
    this.pending.clear()
    this.conn = next
    this.attach(next)
  }

  /** Development builds only: crashes the processor, to exercise restart(). */
  debugCrash(): void {
    if (import.meta.env.DEV) this.post({ type: 'debug-crash' })
  }

  get usesSharedMemory(): boolean {
    return this.conn.ring !== null
  }

  private attach(conn: Connection): void {
    conn.node.connect(this.context.destination)
    conn.node.connect(this.analyser)
    conn.node.onprocessorerror = () => this.onCrash?.()
    conn.node.port.onmessage = (event: MessageEvent<ProcessorReply>) => {
      const msg = event.data
      if (msg.type === 'ack') {
        this.pending.get(msg.id)?.()
        this.pending.delete(msg.id)
      } else if (msg.type === 'status') {
        conn.statusInts.set(new Int32Array(msg.status))
      }
    }
  }

  // --- Commands (real-time path) ---------------------------------------

  send(command: Command): void {
    if (!this.conn.ring?.push(command)) this.post({ type: 'commands', commands: [command] })
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
    const i = this.conn.statusInts
    return {
      step: i[StatusIndex.Step],
      seqPlaying: i[StatusIndex.SeqPlaying] !== 0,
      peakLeft: this.conn.statusFloats[StatusIndex.PeakLeft],
      peakRight: this.conn.statusFloats[StatusIndex.PeakRight],
      songFrame: i[StatusIndex.SongFrame],
      songLength: i[StatusIndex.SongLength],
      songPlaying: i[StatusIndex.SongPlaying] !== 0,
      voices: i[StatusIndex.Voices],
      blocks: i[StatusIndex.Blocks],
    }
  }

  dispose(): void {
    this.conn.node.disconnect()
    this.conn.node.port.close()
  }

  private post(msg: PortMessage, transfer: Transferable[] = []): void {
    this.conn.node.port.postMessage(msg, transfer)
  }

  private request(msg: PortMessage, transfer: Transferable[] = []): Promise<void> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.post({ ...msg, id }, transfer)
    })
  }
}
