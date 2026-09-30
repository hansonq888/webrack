// Sound-triggered recording, like a hardware sampler's "auto sample" mode.
//
// Fed mic audio in small chunks, it waits (armed) until the input rises well
// above the room's noise floor, starts the take there, keeping a little
// pre-roll so the attack isn't clipped, and ends it after a stretch of
// silence or at the length limit. Pure logic, no audio APIs, so it can be
// tested with synthetic input.

export type GateState = 'armed' | 'recording' | 'done'

export interface GateOptions {
  prerollMs: number
  silenceMs: number // quiet this long ends the take
  minMs: number // never end a take shorter than this
  maxSeconds: number
}

export const DEFAULT_GATE: GateOptions = { prerollMs: 150, silenceMs: 1000, minMs: 150, maxSeconds: 4 }

// Absolute floors, so a silent room doesn't make the trigger hair-trigger.
const MIN_START_LEVEL = 0.02 // -34 dBFS
const MIN_SILENCE_LEVEL = 0.008 // -42 dBFS

export class RecordGate {
  state: GateState = 'armed'
  /** Peak of the latest chunk, for the input meter. */
  level = 0

  private readonly sampleRate: number
  private readonly options: GateOptions
  private noiseFloor = Infinity
  private readonly preroll: Float32Array[] = []
  private prerollFrames = 0
  private readonly take: Float32Array[] = []
  private takeFrames = 0
  private silentFrames = 0

  constructor(sampleRate: number, options: GateOptions = DEFAULT_GATE) {
    this.sampleRate = sampleRate
    this.options = options
  }

  /** Seconds recorded since the sound started (0 while armed). */
  get seconds(): number {
    return this.takeFrames / this.sampleRate
  }

  /** Feeds one chunk. Returns 'start' or 'stop' on a state change. */
  push(chunk: Float32Array): 'start' | 'stop' | null {
    let peak = 0
    for (let i = 0; i < chunk.length; i++) peak = Math.max(peak, Math.abs(chunk[i]))
    this.level = peak

    if (this.state === 'armed') {
      // The quietest chunk seen so far is our estimate of the room's noise.
      // Until we've heard one, assume a quiet room, so a sound made the
      // instant Rec is tapped still triggers.
      const threshold = Math.max(MIN_START_LEVEL, this.noise() * 6)
      if (peak > threshold) {
        this.state = 'recording'
        this.take.push(...this.preroll, chunk)
        this.takeFrames = this.prerollFrames + chunk.length
        return 'start'
      }
      this.noiseFloor = Math.min(this.noiseFloor, peak)
      this.preroll.push(chunk)
      this.prerollFrames += chunk.length
      while (this.prerollFrames - this.preroll[0].length >= this.ms(this.options.prerollMs)) {
        this.prerollFrames -= this.preroll.shift()!.length
      }
      return null
    }

    if (this.state === 'recording') {
      this.take.push(chunk)
      this.takeFrames += chunk.length
      const quiet = peak < Math.max(MIN_SILENCE_LEVEL, this.noise() * 2.5)
      this.silentFrames = quiet ? this.silentFrames + chunk.length : 0
      const longEnough = this.takeFrames >= this.ms(this.options.minMs)
      if (this.takeFrames >= this.options.maxSeconds * this.sampleRate || (longEnough && this.silentFrames >= this.ms(this.options.silenceMs))) {
        this.state = 'done'
        return 'stop'
      }
    }
    return null
  }

  /** Ends the take early (manual stop). */
  finish(): void {
    this.state = 'done'
  }

  /** The recorded audio (pre-roll included), capped at maxSeconds. */
  audio(): Float32Array {
    const out = new Float32Array(Math.min(this.takeFrames, this.options.maxSeconds * this.sampleRate))
    let offset = 0
    for (const chunk of this.take) {
      if (offset >= out.length) break
      out.set(chunk.subarray(0, out.length - offset), offset)
      offset += chunk.length
    }
    return out
  }

  private noise(): number {
    return Number.isFinite(this.noiseFloor) ? this.noiseFloor : 0
  }

  private ms(ms: number): number {
    return (ms / 1000) * this.sampleRate
  }
}
