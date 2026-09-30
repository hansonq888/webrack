// Captures the mic input and posts it to the UI thread in 4096-frame chunks
// (about 85 ms), so recording never touches the engine's audio path.

const CHUNK_FRAMES = 4096

class RecorderProcessor extends AudioWorkletProcessor {
  private chunk = new Float32Array(CHUNK_FRAMES)
  private filled = 0
  private recording = true

  constructor(options: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent<{ type: 'stop' }>) => {
      if (event.data.type === 'stop') {
        this.recording = false
        this.flush()
        this.port.postMessage({ type: 'done' })
      }
    }
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0]
    if (!this.recording) return false
    if (!input) return true
    let read = 0
    while (read < input.length) {
      const n = Math.min(input.length - read, CHUNK_FRAMES - this.filled)
      this.chunk.set(input.subarray(read, read + n), this.filled)
      this.filled += n
      read += n
      if (this.filled === CHUNK_FRAMES) this.flush()
    }
    return true
  }

  private flush(): void {
    if (this.filled === 0) return
    const data = this.chunk.slice(0, this.filled)
    this.port.postMessage({ type: 'chunk', data }, [data.buffer])
    this.filled = 0
  }
}

registerProcessor('webrack-recorder', RecorderProcessor)
