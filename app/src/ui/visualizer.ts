// Song-mode visuals, drawn on canvases once per animation frame:
//  - Spectrum: a segmented-LED spectrum analyzer of the live output (after
//    speed, EQ and reverb), log-spaced bands with falling peak caps.
//  - Waveform: the song's peak overview as the timeline; the played part is lit.

export interface VizColors {
  lit: string
  dim: string
  peak: string
}

/** Resizes a canvas to its CSS size at device resolution; returns the 2D context and size. */
function fit(canvas: HTMLCanvasElement): { g: CanvasRenderingContext2D; w: number; h: number } {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  const g = canvas.getContext('2d')!
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)
  return { g, w, h }
}

const MIN_HZ = 35
const MAX_HZ = 16_000
const SEGMENT = 4 // px per LED segment
const SEGMENT_GAP = 2
const PEAK_FALL = 0.012 // per frame

export class Spectrum {
  private readonly canvas: HTMLCanvasElement
  private readonly analyser: AnalyserNode
  private readonly bins: Uint8Array<ArrayBuffer>
  private peaks = new Float32Array(0)

  constructor(canvas: HTMLCanvasElement, analyser: AnalyserNode) {
    this.canvas = canvas
    this.analyser = analyser
    this.bins = new Uint8Array(analyser.frequencyBinCount)
  }

  draw(colors: VizColors, active: boolean): void {
    const { g, w, h } = fit(this.canvas)
    if (w === 0 || h === 0) return
    const bars = Math.max(20, Math.min(64, Math.floor(w / 9)))
    const gap = 3
    const barW = (w - gap * (bars - 1)) / bars
    const segments = Math.floor((h + SEGMENT_GAP) / (SEGMENT + SEGMENT_GAP))
    if (this.peaks.length !== bars) this.peaks = new Float32Array(bars)

    if (active) this.analyser.getByteFrequencyData(this.bins)
    else this.bins.fill(0)
    const nyquist = this.analyser.context.sampleRate / 2
    const binHz = nyquist / this.bins.length

    for (let b = 0; b < bars; b++) {
      // Log-spaced band edges, so bass and treble get fair space.
      const lo = MIN_HZ * (MAX_HZ / MIN_HZ) ** (b / bars)
      const hi = MIN_HZ * (MAX_HZ / MIN_HZ) ** ((b + 1) / bars)
      const first = Math.floor(lo / binHz)
      const last = Math.max(first, Math.min(this.bins.length - 1, Math.floor(hi / binHz)))
      let level = 0
      for (let i = first; i <= last; i++) level = Math.max(level, this.bins[i])
      const value = (level / 255) ** 1.6
      this.peaks[b] = Math.max(value, this.peaks[b] - PEAK_FALL)

      const x = b * (barW + gap)
      const litSegments = Math.round(value * segments)
      const peakSegment = Math.min(segments - 1, Math.round(this.peaks[b] * segments))
      for (let s = 0; s < segments; s++) {
        const y = h - (s + 1) * SEGMENT - s * SEGMENT_GAP
        g.fillStyle = s < litSegments ? colors.lit : s === peakSegment && this.peaks[b] > 0.02 ? colors.peak : colors.dim
        g.fillRect(x, y, barW, SEGMENT)
      }
    }
  }
}

export class Waveform {
  private readonly canvas: HTMLCanvasElement

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
  }

  draw(peaks: Float32Array | null, progress: number, colors: VizColors): void {
    const { g, w, h } = fit(this.canvas)
    if (w === 0 || h === 0) return
    const mid = h / 2
    if (!peaks) {
      g.fillStyle = colors.dim
      g.fillRect(0, mid - 1, w, 2)
      return
    }
    const bars = Math.min(peaks.length, Math.floor(w / 3))
    const barW = w / bars
    for (let b = 0; b < bars; b++) {
      // Each drawn bar summarizes a run of buckets.
      const from = Math.floor((b * peaks.length) / bars)
      const to = Math.max(from + 1, Math.floor(((b + 1) * peaks.length) / bars))
      let peak = 0
      for (let i = from; i < to; i++) peak = Math.max(peak, peaks[i])
      const half = Math.max(1, peak * (h / 2 - 2))
      g.fillStyle = (b + 0.5) / bars <= progress ? colors.lit : colors.dim
      g.fillRect(b * barW, mid - half, Math.max(1, barW - 1), half * 2)
    }
  }
}

// Song mode's backdrop: the live waveform as one soft line across the
// whole window, passing behind the device at its vertical center. Kept
// deliberately calm: low swing, smoothed over time, drawn as a curve.
export class Scope {
  private readonly canvas: HTMLCanvasElement
  private readonly analyser: AnalyserNode
  private readonly samples: Float32Array<ArrayBuffer>
  private shown = new Float32Array(0) // what's drawn, eased toward the live signal
  private gain = 1

  constructor(canvas: HTMLCanvasElement, analyser: AnalyserNode) {
    this.canvas = canvas
    this.analyser = analyser
    this.samples = new Float32Array(analyser.fftSize)
  }

  /** Draws one frame; `centerY` is where the line rests (CSS px from the top). */
  draw(color: string, active: boolean, centerY: number): void {
    const { g, w, h } = fit(this.canvas)
    if (w === 0 || h === 0) return
    if (active) this.analyser.getFloatTimeDomainData(this.samples)
    else this.samples.fill(0)

    // Gentle auto-gain, eased slowly so the size never jumps.
    let peak = 0
    for (let i = 0; i < this.samples.length; i++) peak = Math.max(peak, Math.abs(this.samples[i]))
    const target = peak > 0.001 ? Math.min(2.5, 0.6 / peak) : this.gain
    this.gain += (target - this.gain) * 0.02

    // Sample the waveform at a few points and ease each toward the new value.
    const points = Math.max(32, Math.floor(w / 10))
    if (this.shown.length !== points + 1) this.shown = new Float32Array(points + 1)
    const stride = this.samples.length / points
    for (let p = 0; p <= points; p++) {
      const v = this.samples[Math.min(this.samples.length - 1, Math.floor(p * stride))] * this.gain
      this.shown[p] += (Math.max(-1, Math.min(1, v)) - this.shown[p]) * 0.25
    }

    const amplitude = Math.min(h * 0.07, 48)
    const x = (p: number) => (p / points) * w
    const y = (p: number) => centerY - this.shown[p] * amplitude
    g.lineWidth = 1.25
    g.lineJoin = 'round'
    g.lineCap = 'round'
    g.strokeStyle = color
    g.shadowColor = color
    g.shadowBlur = 5
    g.globalAlpha = active ? 0.45 : 0.18
    // A smooth curve through the points (midpoint quadratic splines).
    g.beginPath()
    g.moveTo(x(0), y(0))
    for (let p = 1; p < points; p++) {
      g.quadraticCurveTo(x(p), y(p), (x(p) + x(p + 1)) / 2, (y(p) + y(p + 1)) / 2)
    }
    g.lineTo(x(points), y(points))
    g.stroke()
    g.globalAlpha = 1
    g.shadowBlur = 0
  }
}
