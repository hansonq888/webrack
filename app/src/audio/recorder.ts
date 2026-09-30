import recorderUrl from '../worklet/recorder-processor.ts?worker&url'
import { DEFAULT_GATE, RecordGate, type GateState } from './record-gate'
import { setAudioSession } from './session'

export const MAX_RECORD_SECONDS = DEFAULT_GATE.maxSeconds
const ARMED_TIMEOUT_MS = 10_000

export type RecordingEnd = 'done' | 'stopped' | 'cancelled' | 'timeout'

export interface RecordingHandlers {
  onStart(): void
  onEnd(audio: Float32Array | null, why: RecordingEnd): void
}

let moduleAdded: Promise<void> | null = null

// One sound-triggered take from the mic: armed until you make a sound, then
// recording until you go quiet (see RecordGate). Voice-processing filters
// (echo cancellation, noise suppression, auto gain) are turned off: they
// mangle beatbox sounds.
export class Recording {
  private readonly gate: RecordGate
  private readonly handlers: RecordingHandlers
  private readonly stream: MediaStream
  private readonly source: MediaStreamAudioSourceNode
  private readonly node: AudioWorkletNode
  private readonly sink: GainNode
  private readonly armedTimer: ReturnType<typeof setTimeout>
  private ended = false

  private constructor(
    context: AudioContext,
    stream: MediaStream,
    source: MediaStreamAudioSourceNode,
    node: AudioWorkletNode,
    sink: GainNode,
    handlers: RecordingHandlers,
  ) {
    this.gate = new RecordGate(context.sampleRate)
    this.handlers = handlers
    this.stream = stream
    this.source = source
    this.node = node
    this.sink = sink
    node.port.onmessage = (event: MessageEvent<{ type: 'chunk'; data: Float32Array }>) => {
      if (event.data.type !== 'chunk' || this.ended) return
      const change = this.gate.push(event.data.data)
      if (change === 'start') {
        clearTimeout(this.armedTimer)
        handlers.onStart()
      } else if (change === 'stop') {
        this.end('done')
      }
    }
    this.armedTimer = setTimeout(() => this.end('timeout'), ARMED_TIMEOUT_MS)
  }

  static async start(context: AudioContext, handlers: RecordingHandlers): Promise<Recording> {
    setAudioSession('play-and-record')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
    } catch (err) {
      setAudioSession('playback')
      throw err
    }
    moduleAdded ??= context.audioWorklet.addModule(recorderUrl)
    await moduleAdded
    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, 'webrack-recorder', { numberOfInputs: 1, numberOfOutputs: 1 })
    // The node must be pulled by the graph to run; route it to a muted sink.
    const sink = context.createGain()
    sink.gain.value = 0
    source.connect(node).connect(sink).connect(context.destination)
    return new Recording(context, stream, source, node, sink, handlers)
  }

  get state(): GateState {
    return this.gate.state
  }
  /** Latest input peak (0–1), for the meter. */
  get level(): number {
    return this.gate.level
  }
  /** Seconds since the sound started. */
  get seconds(): number {
    return this.gate.seconds
  }

  /** Manual stop: keeps the take if one started, otherwise cancels. */
  stop(): void {
    this.end(this.gate.state === 'recording' ? 'stopped' : 'cancelled')
  }

  private end(why: RecordingEnd): void {
    if (this.ended) return
    this.ended = true
    clearTimeout(this.armedTimer)
    const hadTake = why === 'done' || why === 'stopped'
    this.gate.finish()
    this.node.port.postMessage({ type: 'stop' })
    this.source.disconnect()
    this.node.disconnect()
    this.sink.disconnect()
    for (const track of this.stream.getTracks()) track.stop()
    setAudioSession('playback')
    this.handlers.onEnd(hadTake ? this.gate.audio() : null, why)
  }
}
