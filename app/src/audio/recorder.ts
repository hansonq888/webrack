import recorderUrl from '../worklet/recorder-processor.ts?worker&url'
import { setAudioSession } from './session'

export const MAX_RECORD_SECONDS = 4

let moduleAdded: Promise<void> | null = null

// One take from the mic. Voice-processing filters (echo cancellation, noise
// suppression, auto gain) are turned off: they mangle beatbox sounds.
export class Recording {
  private readonly chunks: Float32Array[] = []
  private frames = 0
  private stopped: Promise<Float32Array> | null = null
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly context: AudioContext
  private readonly stream: MediaStream
  private readonly source: MediaStreamAudioSourceNode
  private readonly node: AudioWorkletNode
  private readonly sink: GainNode

  private constructor(
    context: AudioContext,
    stream: MediaStream,
    source: MediaStreamAudioSourceNode,
    node: AudioWorkletNode,
    sink: GainNode,
    onAutoStop: () => void,
  ) {
    this.context = context
    this.stream = stream
    this.source = source
    this.node = node
    this.sink = sink
    node.port.onmessage = (event: MessageEvent<{ type: 'chunk'; data: Float32Array }>) => {
      if (event.data.type !== 'chunk') return
      this.chunks.push(event.data.data)
      this.frames += event.data.data.length
    }
    this.timer = setTimeout(onAutoStop, MAX_RECORD_SECONDS * 1000)
  }

  static async start(context: AudioContext, onAutoStop: () => void): Promise<Recording> {
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
    return new Recording(context, stream, source, node, sink, onAutoStop)
  }

  get seconds(): number {
    return this.frames / this.context.sampleRate
  }

  /** Stops recording and returns the raw take at the context's sample rate. */
  stop(): Promise<Float32Array> {
    this.stopped ??= new Promise((resolve) => {
      clearTimeout(this.timer)
      this.node.port.onmessage = (event: MessageEvent<{ type: 'chunk' | 'done'; data?: Float32Array }>) => {
        if (event.data.type === 'chunk' && event.data.data) {
          this.chunks.push(event.data.data)
          this.frames += event.data.data.length
        } else if (event.data.type === 'done') {
          this.teardown()
          const maxFrames = MAX_RECORD_SECONDS * this.context.sampleRate
          const out = new Float32Array(Math.min(this.frames, maxFrames))
          let offset = 0
          for (const chunk of this.chunks) {
            if (offset >= out.length) break
            out.set(chunk.subarray(0, out.length - offset), offset)
            offset += chunk.length
          }
          resolve(out)
        }
      }
      this.node.port.postMessage({ type: 'stop' })
    })
    return this.stopped
  }

  private teardown(): void {
    this.source.disconnect()
    this.node.disconnect()
    this.sink.disconnect()
    for (const track of this.stream.getTracks()) track.stop()
    setAudioSession('playback')
  }
}
