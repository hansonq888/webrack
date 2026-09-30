// decodeAudioData resamples to the context's rate, which is the rate the
// engine runs at, so decoded audio can go straight into the engine.

export async function decodeFile(context: BaseAudioContext, file: Blob): Promise<AudioBuffer> {
  const bytes = await file.arrayBuffer()
  return context.decodeAudioData(bytes)
}

export function toMono(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length)
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < out.length; i++) out[i] += data[i] / buffer.numberOfChannels
  }
  return out
}

/** Interleaved stereo int16 (mono is duplicated), up to maxFrames. */
export function toInterleavedInt16(buffer: AudioBuffer, maxFrames: number): Int16Array {
  const frames = Math.min(buffer.length, maxFrames)
  const left = buffer.getChannelData(0)
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left
  const out = new Int16Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    out[2 * i] = Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767)))
    out[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767)))
  }
  return out
}

/** Resamples mono audio (e.g. a pad saved at another device's rate). */
export async function resample(data: Float32Array, fromRate: number, toRate: number): Promise<Float32Array> {
  if (fromRate === toRate) return data
  const frames = Math.ceil((data.length * toRate) / fromRate)
  const context = new OfflineAudioContext({ numberOfChannels: 1, length: frames, sampleRate: toRate })
  const buffer = context.createBuffer(1, data.length, fromRate)
  buffer.copyToChannel(new Float32Array(data), 0)
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  source.start()
  return (await context.startRendering()).getChannelData(0)
}
