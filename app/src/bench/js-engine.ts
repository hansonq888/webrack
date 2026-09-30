// A TypeScript port of the C++ engine (engine/src), for the JS-vs-WASM
// benchmark. Same algorithms, same structure, same parameters, written the way
// a careful JS developer would for real-time audio: typed arrays everywhere,
// nothing allocated inside process(). Not used by the app itself.

export const BLOCK_SIZE = 128
const NUM_PADS = 16
const NUM_STEPS = 16
const MAX_VOICES = 16
const VOICE_SLOTS = MAX_VOICES + 8
const FADE_STEP = 1 / 64

// --- Interpolation (engine/src/dsp/interp.hpp) ---------------------------

function hermite(data: Float32Array, length: number, pos: number): number {
  const i = Math.floor(pos)
  const t = pos - i
  const xm1 = i - 1 >= 0 && i - 1 < length ? data[i - 1] : 0
  const x0 = i >= 0 && i < length ? data[i] : 0
  const x1 = i + 1 < length ? data[i + 1] : 0
  const x2 = i + 2 < length ? data[i + 2] : 0
  const c1 = 0.5 * (x1 - xm1)
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1)
  return ((c3 * t + c2) * t + c1) * t + x0
}

// Interleaved stereo int16, one channel.
function hermiteI16(data: Int16Array, length: number, ch: number, pos: number): number {
  const i = Math.floor(pos)
  const t = pos - i
  const xm1 = i - 1 >= 0 && i - 1 < length ? data[2 * (i - 1) + ch] / 32768 : 0
  const x0 = i >= 0 && i < length ? data[2 * i + ch] / 32768 : 0
  const x1 = i + 1 < length ? data[2 * (i + 1) + ch] / 32768 : 0
  const x2 = i + 2 < length ? data[2 * (i + 2) + ch] / 32768 : 0
  const c1 = 0.5 * (x1 - xm1)
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1)
  return ((c3 * t + c2) * t + c1) * t + x0
}

// --- Sampler (engine/src/sampler.hpp) --------------------------------------

class Voice {
  active = false
  pad = 0
  age = 0
  pos = 0
  gain = 1
  fade = 1
  fadeStep = 0
}

class Sampler {
  readonly voices = Array.from({ length: VOICE_SLOTS }, () => new Voice())
  private clock = 0

  trigger(pad: number, gain: number, length: number): void {
    if (length === 0) return
    // Each pad chokes itself: fade out its previous voice.
    for (const v of this.voices) if (v.active && v.pad === pad && v.fadeStep === 0) v.fadeStep = FADE_STEP
    if (this.soundingCount() >= MAX_VOICES) {
      let oldest: Voice | null = null
      for (const v of this.voices) if (v.active && v.fadeStep === 0 && (!oldest || v.age < oldest.age)) oldest = v
      if (oldest) oldest.fadeStep = FADE_STEP
    }
    // An inactive slot, or failing that the quietest fading voice.
    let slot = this.voices[0]
    for (const v of this.voices) {
      if (!v.active) {
        slot = v
        break
      }
      if (v.fadeStep !== 0 && v.fade < slot.fade) slot = v
    }
    slot.active = true
    slot.pad = pad
    slot.gain = gain
    slot.pos = 0
    slot.fade = 1
    slot.fadeStep = 0
    slot.age = ++this.clock
  }

  render(pads: Float32Array[], lengths: Int32Array, rate: number, left: Float32Array, right: Float32Array, begin: number, end: number): void {
    const voices = this.voices
    for (let n = 0; n < voices.length; n++) {
      const v = voices[n]
      if (!v.active) continue
      const data = pads[v.pad]
      const length = lengths[v.pad]
      for (let i = begin; i < end; i++) {
        const x = hermite(data, length, v.pos) * v.gain * v.fade
        left[i] += x
        right[i] += x
        v.pos += rate
        if (v.fadeStep !== 0) v.fade -= v.fadeStep
        if (v.pos >= length || v.fade <= 0) {
          v.active = false
          break
        }
      }
    }
  }

  soundingCount(): number {
    let n = 0
    for (const v of this.voices) if (v.active && v.fadeStep === 0) n++
    return n
  }
}

// --- Sequencer (engine/src/sequencer.hpp) ------------------------------------

class Sequencer {
  readonly pattern = new Uint16Array(NUM_PADS)
  private sampleRate = 48000
  private bpm = 90
  private speed = 1
  private stepFrames = 8000
  playing = false
  private anchorFrame = 0
  private anchorStep = 0
  private nextStep = 0
  readonly hitOffsets = new Int32Array(4)
  readonly hitSteps = new Int32Array(4)

  init(sampleRate: number): void {
    this.sampleRate = sampleRate
    this.update()
  }
  setBpm(bpm: number, now: number): void {
    this.bpm = Math.max(60, Math.min(180, bpm))
    this.retime(now)
  }
  setSpeed(speed: number, now: number): void {
    this.speed = speed
    this.retime(now)
  }
  setPlaying(playing: boolean, now: number): void {
    this.playing = playing
    this.anchorFrame = now
    this.anchorStep = 0
    this.nextStep = 0
  }
  stepOn(pad: number, step: number): boolean {
    return ((this.pattern[pad] >> step) & 1) === 1
  }

  collect(now: number, frames: number): number {
    if (!this.playing) return 0
    let n = 0
    const end = now + frames
    for (let t = this.frameOf(this.nextStep); t < end && n < 4; t = this.frameOf(this.nextStep)) {
      this.hitOffsets[n] = t < now ? 0 : t - now
      this.hitSteps[n] = this.nextStep % NUM_STEPS
      n++
      this.nextStep++
    }
    return n
  }

  private frameOf(step: number): number {
    return this.anchorFrame + Math.round((step - this.anchorStep) * this.stepFrames)
  }
  private update(): void {
    this.stepFrames = (this.sampleRate * 60) / this.bpm / 4 / this.speed
  }
  private retime(now: number): void {
    if (!this.playing) {
      this.update()
      return
    }
    const left = this.frameOf(this.nextStep) - now
    const old = this.stepFrames
    this.update()
    this.anchorFrame = now + Math.round((Math.max(0, left) * this.stepFrames) / old)
    this.anchorStep = this.nextStep
  }
}

// --- Song (engine/src/song.hpp) ------------------------------------------------

class SongPlayer {
  data: Int16Array = new Int16Array(0)
  length = 0
  pos = 0
  playing = false

  render(rate: number, left: Float32Array, right: Float32Array, begin: number, end: number): void {
    if (!this.playing) return
    for (let i = begin; i < end; i++) {
      left[i] += hermiteI16(this.data, this.length, 0, this.pos)
      right[i] += hermiteI16(this.data, this.length, 1, this.pos)
      this.pos += rate
      if (this.pos >= this.length) {
        this.playing = false
        this.pos = 0
        return
      }
    }
  }
}

// --- EQ (engine/src/dsp/biquad.hpp, eq.hpp) -------------------------------------

const EQ_FREQ = [150, 1000, 6000]
const EQ_Q = [0.707, 0.9, 0.707]

class ThreeBandEq {
  private sampleRate = 48000
  private readonly target = new Float64Array(3)
  private readonly current = new Float64Array(3)
  // Per band: b0 b1 b2 a1 a2.
  private readonly coeffs = new Float64Array(15)
  // Per channel per band: z1 z2.
  private readonly state = new Float64Array(12)

  init(sampleRate: number): void {
    this.sampleRate = sampleRate
    for (let b = 0; b < 3; b++) this.updateCoeffs(b)
  }
  setGainDb(band: number, db: number): void {
    this.target[band] = Math.max(-12, Math.min(12, db))
  }

  process(left: Float32Array, right: Float32Array, n: number): void {
    for (let b = 0; b < 3; b++) {
      const diff = this.target[b] - this.current[b]
      if (diff === 0) continue
      this.current[b] = Math.abs(diff) < 0.01 ? this.target[b] : this.current[b] + 0.15 * diff
      this.updateCoeffs(b)
    }
    if (this.current[0] === 0 && this.current[1] === 0 && this.current[2] === 0) return
    const c = this.coeffs
    const s = this.state
    for (let ch = 0; ch < 2; ch++) {
      const x = ch === 0 ? left : right
      for (let i = 0; i < n; i++) {
        let y = x[i]
        for (let b = 0; b < 3; b++) {
          const k = b * 5
          const z = ch * 6 + b * 2
          const out = c[k] * y + s[z]
          s[z] = c[k + 1] * y - c[k + 3] * out + s[z + 1]
          s[z + 1] = c[k + 2] * y - c[k + 4] * out
          y = out
        }
        x[i] = y
      }
    }
  }

  private updateCoeffs(b: number): void {
    const A = 10 ** (this.current[b] / 40)
    const w0 = (2 * Math.PI * EQ_FREQ[b]) / this.sampleRate
    const cw = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * EQ_Q[b])
    let b0, b1, b2, a0, a1, a2
    if (b === 1) {
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A
    } else {
      const k = 2 * Math.sqrt(A) * alpha
      const sign = b === 0 ? 1 : -1 // low shelf vs. high shelf
      b0 = A * ((A + 1) - sign * (A - 1) * cw + k)
      b1 = sign * 2 * A * ((A - 1) - sign * (A + 1) * cw)
      b2 = A * ((A + 1) - sign * (A - 1) * cw - k)
      a0 = (A + 1) + sign * (A - 1) * cw + k
      a1 = -sign * 2 * ((A - 1) + sign * (A + 1) * cw)
      a2 = (A + 1) + sign * (A - 1) * cw - k
    }
    const o = b * 5
    this.coeffs[o] = b0 / a0
    this.coeffs[o + 1] = b1 / a0
    this.coeffs[o + 2] = b2 / a0
    this.coeffs[o + 3] = a1 / a0
    this.coeffs[o + 4] = a2 / a0
  }
}

// --- Reverb (engine/src/dsp/reverb.hpp) ------------------------------------------

const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const ALLPASS_TUNING = [556, 441, 341, 225]
const STEREO_SPREAD = 23

class DelayLine {
  readonly buf: Float32Array
  index = 0
  store = 0
  constructor(length: number) {
    this.buf = new Float32Array(length)
  }
}

class Reverb {
  private combs: DelayLine[][] = []
  private allpasses: DelayLine[][] = []
  private predelay = new Float32Array(20000)
  private predelayWrite = 0
  private predelayFrames = 0
  private sampleRate = 48000
  private hpCoeff = 0.97
  private hpState = 0
  private hpPrev = 0
  private feedback = 0.84
  private damp = 0.2
  private mix = 0
  private mixTarget = 0

  init(sampleRate: number): void {
    const sr = Math.min(sampleRate, 96000)
    const scale = sr / 44100
    this.combs = [0, 1].map((ch) => COMB_TUNING.map((t) => new DelayLine(Math.floor((t + ch * STEREO_SPREAD) * scale))))
    this.allpasses = [0, 1].map((ch) => ALLPASS_TUNING.map((t) => new DelayLine(Math.floor((t + ch * STEREO_SPREAD) * scale))))
    this.sampleRate = sr
    this.hpCoeff = Math.exp((-2 * Math.PI * 220) / sr)
    this.set(0, 0.7)
    this.set(1, 0.5)
    this.set(2, 20)
    this.set(3, 0)
    this.mix = this.mixTarget
  }

  set(param: number, value: number): void {
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
    if (param === 0) this.feedback = 0.7 + 0.28 * clamp01(value)
    else if (param === 1) this.damp = 0.4 * clamp01(value)
    else if (param === 2) this.predelayFrames = Math.floor(Math.max(0, Math.min(200, value)) * 0.001 * this.sampleRate)
    else this.mixTarget = clamp01(value)
  }

  process(left: Float32Array, right: Float32Array, n: number): void {
    const mixStep = (this.mixTarget - this.mix) / n
    const cap = this.predelay.length
    const feedback = this.feedback
    const damp = this.damp
    for (let i = 0; i < n; i++) {
      const mono = (left[i] + right[i]) * 0.015
      this.hpState = this.hpCoeff * (this.hpState + mono - this.hpPrev)
      this.hpPrev = mono
      this.predelay[this.predelayWrite] = this.hpState
      let read = this.predelayWrite + cap - this.predelayFrames
      if (read >= cap) read -= cap
      const input = this.predelay[read] + 1e-18
      if (++this.predelayWrite === cap) this.predelayWrite = 0

      let wetL = 0
      let wetR = 0
      for (let ch = 0; ch < 2; ch++) {
        const combs = this.combs[ch]
        const allpasses = this.allpasses[ch]
        let acc = 0
        for (let k = 0; k < combs.length; k++) {
          const c = combs[k]
          const out = c.buf[c.index]
          c.store = out * (1 - damp) + c.store * damp
          c.buf[c.index] = input + c.store * feedback
          if (++c.index === c.buf.length) c.index = 0
          acc += out
        }
        for (let k = 0; k < allpasses.length; k++) {
          const a = allpasses[k]
          const delayed = a.buf[a.index]
          a.buf[a.index] = acc + delayed * 0.5
          if (++a.index === a.buf.length) a.index = 0
          acc = delayed - acc
        }
        if (ch === 0) wetL = acc
        else wetR = acc
      }

      this.mix += mixStep
      const angle = this.mix * (Math.PI / 2)
      const dry = this.mix === 0 ? 1 : Math.cos(angle)
      const wet = this.mix === 0 ? 0 : Math.sin(angle)
      left[i] = left[i] * dry + wetL * wet
      right[i] = right[i] * dry + wetR * wet
    }
    this.mix = this.mixTarget
  }
}

// --- Engine (engine/src/engine.cpp) ---------------------------------------------

function softClip(x: number): number {
  const a = Math.abs(x)
  if (a <= 0.8) return x
  const y = 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2)
  return x < 0 ? -y : y
}

export class JsEngine {
  readonly outL = new Float32Array(BLOCK_SIZE)
  readonly outR = new Float32Array(BLOCK_SIZE)
  readonly pads: Float32Array[] = Array.from({ length: NUM_PADS }, () => new Float32Array(0))
  readonly padLengths = new Int32Array(NUM_PADS)
  private readonly sampler = new Sampler()
  private readonly sequencer = new Sequencer()
  readonly song = new SongPlayer()
  private readonly eq = new ThreeBandEq()
  private readonly reverb = new Reverb()
  private now = 0
  private speed = 1
  private masterGain = 0.8

  init(sampleRate: number): void {
    this.sequencer.init(sampleRate)
    this.eq.init(sampleRate)
    this.reverb.init(sampleRate)
  }

  loadPad(pad: number, data: Float32Array): void {
    this.pads[pad] = data
    this.padLengths[pad] = data.length
  }
  loadSong(interleaved: Int16Array): void {
    this.song.data = interleaved
    this.song.length = interleaved.length / 2
    this.song.pos = 0
  }
  trigger(pad: number, gain = 1): void {
    this.sampler.trigger(pad, gain, this.padLengths[pad])
  }
  setStep(pad: number, step: number, on: boolean): void {
    const bit = 1 << step
    this.sequencer.pattern[pad] = on ? this.sequencer.pattern[pad] | bit : this.sequencer.pattern[pad] & ~bit
  }
  setBpm(bpm: number): void {
    this.sequencer.setBpm(bpm, this.now)
  }
  setPlaying(playing: boolean): void {
    this.sequencer.setPlaying(playing, this.now)
  }
  setSpeed(speed: number): void {
    // The C++ engine holds speed as a 32-bit float; match it bit for bit.
    this.speed = Math.fround(Math.max(0.5, Math.min(1, speed)))
    this.sequencer.setSpeed(this.speed, this.now)
  }
  setEqGain(band: number, db: number): void {
    this.eq.setGainDb(band, db)
  }
  setReverb(param: number, value: number): void {
    this.reverb.set(param, value)
  }
  setSongPlaying(playing: boolean): void {
    this.song.playing = playing && this.song.length > 0
  }
  setMasterGain(gain: number): void {
    this.masterGain = gain
  }

  process(): void {
    const left = this.outL
    const right = this.outR
    left.fill(0)
    right.fill(0)

    const seq = this.sequencer
    const hits = seq.collect(this.now, BLOCK_SIZE)
    let cursor = 0
    for (let h = 0; h < hits; h++) {
      this.renderSources(cursor, seq.hitOffsets[h])
      cursor = seq.hitOffsets[h]
      for (let pad = 0; pad < NUM_PADS; pad++) if (seq.stepOn(pad, seq.hitSteps[h])) this.trigger(pad)
    }
    this.renderSources(cursor, BLOCK_SIZE)

    this.eq.process(left, right, BLOCK_SIZE)
    this.reverb.process(left, right, BLOCK_SIZE)
    for (let i = 0; i < BLOCK_SIZE; i++) {
      left[i] = softClip(left[i] * this.masterGain)
      right[i] = softClip(right[i] * this.masterGain)
    }
    this.now += BLOCK_SIZE
  }

  private renderSources(begin: number, end: number): void {
    if (begin >= end) return
    this.sampler.render(this.pads, this.padLengths, this.speed, this.outL, this.outR, begin, end)
    this.song.render(this.speed, this.outL, this.outR, begin, end)
  }
}
