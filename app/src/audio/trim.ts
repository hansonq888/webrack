const TARGET_PEAK = 0.89 // -1 dBFS

function peakOf(data: Float32Array): number {
  let peak = 0
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
  return peak
}

/** Scales in place so the peak sits at -1 dBFS. */
export function normalize(data: Float32Array): Float32Array {
  const peak = peakOf(data)
  if (peak > 0) {
    const gain = TARGET_PEAK / peak
    for (let i = 0; i < data.length; i++) data[i] *= gain
  }
  return data
}

/**
 * Cuts leading and trailing silence from a recording, adds short fades so the
 * cut points don't click, and normalizes. Returns null if nothing but silence
 * (or noise floor) was captured.
 */
export function autoTrim(data: Float32Array, sampleRate: number): Float32Array | null {
  const peak = peakOf(data)
  if (peak < 0.01) return null // below -40 dBFS: nothing there
  const threshold = Math.max(peak * 0.06, 0.004)

  let first = 0
  while (first < data.length && Math.abs(data[first]) < threshold) first++
  let last = data.length - 1
  while (last > first && Math.abs(data[last]) < threshold) last--

  // Keep a hair before the onset and let the tail ring out.
  const start = Math.max(0, first - Math.round(0.004 * sampleRate))
  const end = Math.min(data.length, last + Math.round(0.08 * sampleRate))
  const out = data.slice(start, end)

  const fadeIn = Math.min(out.length, Math.round(0.002 * sampleRate))
  const fadeOut = Math.min(out.length, Math.round(0.02 * sampleRate))
  for (let i = 0; i < fadeIn; i++) out[i] *= i / fadeIn
  for (let i = 0; i < fadeOut; i++) out[out.length - 1 - i] *= i / fadeOut
  return normalize(out)
}
