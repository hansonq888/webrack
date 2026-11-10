// Graceful degradation under overload. Fed the browser's running count of
// output underruns (glitches), it lowers the engine's voice cap when glitches
// cluster, so each block has less to render, and restores it one step at a
// time once the output has been clean for a while.
//
// Pure logic, no audio APIs, so it can be tested with simulated counts.

export interface ShedderOptions {
  /** Voice caps from full polyphony down; each overload step moves one along. */
  steps: number[]
  /** This many underruns within `windowMs` means the engine is overloaded. */
  underrunsToShed: number
  windowMs: number
  /** Clean output for this long restores one step. */
  recoverAfterMs: number
}

export const DEFAULT_SHEDDER: ShedderOptions = {
  steps: [16, 8, 4],
  underrunsToShed: 2,
  windowMs: 5_000,
  recoverAfterMs: 30_000,
}

export class LoadShedder {
  private readonly options: ShedderOptions
  private level = 0
  private lastTotal: number | null = null
  private recent: number[] = [] // times of recent underruns
  private lastUnderrunMs = -Infinity
  private lastChangeMs = -Infinity

  constructor(options: ShedderOptions = DEFAULT_SHEDDER) {
    this.options = options
  }

  /** The current voice cap. */
  get voices(): number {
    return this.options.steps[this.level]
  }

  /**
   * Takes the browser's cumulative underrun count at time `nowMs`. Returns the
   * new voice cap when it changes, otherwise null.
   */
  update(totalUnderruns: number, nowMs: number): number | null {
    const { steps, underrunsToShed, windowMs, recoverAfterMs } = this.options
    const fresh = this.lastTotal === null ? 0 : Math.max(0, totalUnderruns - this.lastTotal)
    this.lastTotal = totalUnderruns
    for (let i = 0; i < fresh; i++) this.recent.push(nowMs)
    if (fresh > 0) this.lastUnderrunMs = nowMs
    this.recent = this.recent.filter((t) => nowMs - t < windowMs)

    // Shed: glitches are clustering. One step per window, so a single burst
    // doesn't drop straight to the floor.
    if (this.recent.length >= underrunsToShed && this.level < steps.length - 1 && nowMs - this.lastChangeMs >= windowMs) {
      return this.change(this.level + 1, nowMs)
    }
    // Recover: clean for long enough since the last glitch and the last change.
    if (this.level > 0 && nowMs - this.lastUnderrunMs >= recoverAfterMs && nowMs - this.lastChangeMs >= recoverAfterMs) {
      return this.change(this.level - 1, nowMs)
    }
    return null
  }

  private change(level: number, nowMs: number): number {
    this.level = level
    this.lastChangeMs = nowMs
    this.recent = []
    return this.voices
  }
}
