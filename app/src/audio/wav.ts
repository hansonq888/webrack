/** 16-bit PCM WAV with TPDF dither. */
export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, buffer.numberOfChannels)
  const frames = buffer.length
  const bytesPerFrame = channels * 2
  const out = new DataView(new ArrayBuffer(44 + frames * bytesPerFrame))

  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) out.setUint8(offset + i, s.charCodeAt(i))
  }
  text(0, 'RIFF')
  out.setUint32(4, 36 + frames * bytesPerFrame, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  out.setUint32(16, 16, true)
  out.setUint16(20, 1, true) // PCM
  out.setUint16(22, channels, true)
  out.setUint32(24, buffer.sampleRate, true)
  out.setUint32(28, buffer.sampleRate * bytesPerFrame, true)
  out.setUint16(32, bytesPerFrame, true)
  out.setUint16(34, 16, true)
  text(36, 'data')
  out.setUint32(40, frames * bytesPerFrame, true)

  const data = Array.from({ length: channels }, (_, ch) => buffer.getChannelData(ch))
  let offset = 44
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const dither = (Math.random() - Math.random()) / 32768
      const s = Math.max(-1, Math.min(1, data[ch][i] + dither))
      out.setInt16(offset, Math.round(s * 32767), true)
      offset += 2
    }
  }
  return new Blob([out.buffer], { type: 'audio/wav' })
}
