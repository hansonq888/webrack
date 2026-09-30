import { EngineClient, renderOffline } from '../engine/client'
import { Op, ReverbParam, type Command } from '../engine/protocol'
import { DEMO_BPM, DEMO_KIT, DEMO_PATTERN } from '../audio/kit'
import { decodeFile, resample, toInterleavedInt16, toMono } from '../audio/decode'
import { autoTrim, normalize } from '../audio/trim'
import { Recording, type RecordingEnd } from '../audio/recorder'
import { setAudioSession } from '../audio/session'
import { encodeWav } from '../audio/wav'
import { load, save } from './storage'

export const NUM_PADS = 16
export const MAX_STEPS = 64
export const STEP_COUNTS = [16, 32, 64] as const
export type StepCount = (typeof STEP_COUNTS)[number]
export const EXPORT_LOOPS = 4
const EXPORT_TAIL_SECONDS = 3
const MASTER_GAIN = 0.45

export type Mode = 'beat' | 'song'

export interface Vibe {
  speed: number // 0.5–1.0
  size: number // 0–1
  damping: number // 0–1
  preDelayMs: number // 0–200
  mix: number // 0–1
  low: number // dB, ±12
  mid: number
  high: number
}

export const FLAT_VIBE: Vibe = { speed: 1, size: 0.7, damping: 0.5, preDelayMs: 20, mix: 0.15, low: 0, mid: 0, high: 0 }
export const SLOWED_REVERB: Vibe = {
  speed: 0.8,
  size: 0.9,
  damping: 0.6,
  preDelayMs: 40,
  mix: 0.45,
  low: 3,
  mid: -1,
  high: -3,
}

export interface Pad {
  name: string
  data: Float32Array | null
  custom: boolean // recorded or loaded by the user (vs. the demo kit)
}

export interface Song {
  name: string
  data: Int16Array // interleaved stereo at the engine's rate
  frames: number
  truncated: boolean
  waveform: Float32Array // peak (0-1) per bucket, for the timeline
}

const WAVEFORM_BUCKETS = 480

/** Peak level per bucket across both channels, for drawing the timeline. */
function waveformOf(data: Int16Array, buckets: number): Float32Array {
  const frames = data.length / 2
  const out = new Float32Array(buckets)
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * frames) / buckets) * 2
    const end = Math.floor(((b + 1) * frames) / buckets) * 2
    let peak = 0
    for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(data[i]))
    out[b] = peak / 32768
  }
  return out
}

export type RecordEvent = {
  type: 'started' | 'recorded' | 'silent' | 'cancelled' | 'timeout'
  pad: number
}

export interface ExportResult {
  blob: Blob
  fileName: string
  seconds: number
  renderMs: number
}

interface SavedPad {
  index: number
  name: string
  sampleRate: number
  data: Float32Array
}
interface SavedSession {
  pattern: boolean[][]
  stepCount?: StepCount
  bpm: number
  vibe: Vibe
  selected: number
}

// The app's state and every action on it. The UI calls these and re-renders
// on `onChange`; the engine is kept in sync here.
export class Studio {
  mode: Mode = 'beat'
  pads: Pad[] = []
  selected = 0
  // Always MAX_STEPS wide; only the first stepCount steps play.
  pattern: boolean[][] = Array.from({ length: NUM_PADS }, () => Array(MAX_STEPS).fill(false))
  stepCount: StepCount = 16
  bpm = DEMO_BPM
  playing = false
  vibe: Vibe = { ...FLAT_VIBE }
  song: Song | null = null
  recording: Recording | null = null
  recordingPad = 0
  onChange: () => void = () => {}
  onRecordEvent: (event: RecordEvent) => void = () => {}

  readonly context: AudioContext
  readonly engine: EngineClient
  private saveTimer: ReturnType<typeof setTimeout> | undefined

  private constructor(context: AudioContext, engine: EngineClient) {
    this.context = context
    this.engine = engine
  }

  /** Must run inside a user gesture (iOS won't start audio otherwise). */
  static async start(): Promise<Studio> {
    setAudioSession('playback')
    // No forced sampleRate: forcing one that differs from the hardware rate
    // distorts AudioWorklet output on some iOS devices.
    const context = new AudioContext({ latencyHint: 'interactive' })
    const resumed = context.resume()
    const engine = await EngineClient.create(context)
    await resumed

    const studio = new Studio(context, engine)
    await studio.restore()
    return studio
  }

  get sampleRate(): number {
    return this.context.sampleRate
  }

  // --- Pads -------------------------------------------------------------

  hit(pad: number): void {
    this.engine.trigger(pad)
  }

  select(pad: number): void {
    if (this.selected === pad) return
    this.selected = pad
    this.changed()
  }

  /**
   * Arms the mic for the selected pad. Recording starts on its own when you
   * make a sound and ends when you go quiet; `onRecordEvent` reports progress.
   */
  async armRecording(): Promise<void> {
    if (this.recording) return
    // Silence everything first: playback would bleed from the speaker into
    // the mic (and could even trigger the take).
    this.stopAll()
    const pad = this.selected
    this.recordingPad = pad
    this.recording = await Recording.start(this.context, {
      onStart: () => {
        this.onRecordEvent({ type: 'started', pad })
        this.changed(false)
      },
      onEnd: (audio, why) => void this.finishRecording(pad, audio, why),
    })
    this.changed(false)
  }

  /** Stops early (keeping the take), or cancels if no sound has started yet. */
  stopRecording(): void {
    this.recording?.stop()
  }

  private async finishRecording(pad: number, audio: Float32Array | null, why: RecordingEnd): Promise<void> {
    this.recording = null
    const trimmed = audio && autoTrim(audio, this.sampleRate)
    if (trimmed) await this.setPad(pad, { name: `Rec ${pad + 1}`, data: trimmed, custom: true })
    this.onRecordEvent(
      trimmed ? { type: 'recorded', pad } : { type: why === 'timeout' ? 'timeout' : audio ? 'silent' : 'cancelled', pad },
    )
    this.changed(!!trimmed)
  }

  async loadFileToPad(pad: number, file: File): Promise<void> {
    const buffer = await decodeFile(this.context, file)
    const mono = toMono(buffer).slice(0, this.engine.padCapacity)
    const data = autoTrim(mono, this.sampleRate) ?? normalize(mono)
    await this.setPad(pad, { name: file.name.replace(/\.[^.]+$/, '').slice(0, 12), data, custom: true })
    this.changed()
  }

  async resetPad(pad: number): Promise<void> {
    await this.setPad(pad, this.kitPad(pad))
    this.changed()
  }

  // --- Sequencer --------------------------------------------------------

  toggleStep(pad: number, step: number): void {
    const on = !this.pattern[pad][step]
    this.pattern[pad][step] = on
    this.engine.setStep(pad, step, on)
    this.changed()
  }

  /**
   * Sets the pattern length. Growing it repeats what's there into the new
   * bars (so a 1-bar beat becomes the same beat twice, ready to vary);
   * shrinking keeps the hidden steps for when you grow it back.
   */
  setStepCount(count: StepCount): void {
    const old = this.stepCount
    if (count === old) return
    if (count > old) {
      this.pattern.forEach((row, pad) => {
        for (let s = old; s < count; s++) {
          row[s] = row[s % old]
          this.engine.setStep(pad, s, row[s])
        }
      })
    }
    this.stepCount = count
    this.engine.send([Op.PatternLength, count, 0, 0])
    this.changed()
  }

  /** Whether a pad has any hits in the playing length. */
  padHasSteps(pad: number): boolean {
    return this.pattern[pad].slice(0, this.stepCount).some(Boolean)
  }

  clearPattern(): void {
    for (const row of this.pattern) row.fill(false)
    this.engine.send([Op.ClearPattern, 0, 0, 0])
    this.changed()
  }

  setBpm(bpm: number): void {
    this.bpm = Math.max(60, Math.min(180, Math.round(bpm)))
    this.engine.setBpm(this.bpm)
    this.changed()
  }

  /** Stops the beat and the song, fades every pad, and cuts the reverb tail. */
  stopAll(): void {
    this.playing = false
    this.engine.send([Op.StopAll, 0, 0, 0])
    this.changed(false)
  }

  /** Transport stop: halts the beat or song; sounding pads ring out. */
  stop(): void {
    if (this.mode === 'song') this.engine.setSongPlaying(false)
    else if (this.playing) {
      this.playing = false
      this.engine.setPlaying(false)
    }
    this.changed(false)
  }

  /** Transport play: starts the beat from step 1 (restarting if running), or the song. */
  play(): void {
    if (this.mode === 'song') {
      if (this.song) this.engine.setSongPlaying(true)
    } else {
      this.playing = true
      this.engine.setPlaying(true)
    }
    this.changed(false)
  }

  togglePlay(): void {
    if (this.mode === 'song') {
      if (!this.song) return
      const status = this.engine.status()
      this.engine.setSongPlaying(!status.songPlaying)
    } else {
      this.playing = !this.playing
      this.engine.setPlaying(this.playing)
    }
    this.changed(false)
  }

  // --- Vibe ---------------------------------------------------------------

  setVibe(key: keyof Vibe, value: number): void {
    this.vibe[key] = value
    for (const command of vibeCommands({ [key]: value })) this.engine.send(command)
    this.changed()
  }

  applyVibe(vibe: Vibe): void {
    this.vibe = { ...vibe }
    for (const command of vibeCommands(vibe)) this.engine.send(command)
    this.changed()
  }

  // --- Song ---------------------------------------------------------------

  setMode(mode: Mode): void {
    if (this.mode === mode) return
    this.mode = mode
    if (mode === 'song' && this.playing) {
      this.playing = false
      this.engine.setPlaying(false)
    }
    if (mode === 'beat') this.engine.setSongPlaying(false)
    this.changed(false)
  }

  async loadSong(file: File): Promise<void> {
    this.engine.setSongPlaying(false)
    const buffer = await decodeFile(this.context, file)
    const data = toInterleavedInt16(buffer, this.engine.songCapacity)
    const frames = data.length / 2
    await this.engine.loadSong(data)
    this.song = {
      name: file.name.replace(/\.[^.]+$/, ''),
      data,
      frames,
      truncated: frames < buffer.length,
      waveform: waveformOf(data, WAVEFORM_BUCKETS),
    }
    this.changed(false)
  }

  seekSong(fraction: number): void {
    if (!this.song) return
    this.engine.seekSong(Math.floor(Math.max(0, Math.min(1, fraction)) * this.song.frames))
  }

  // --- Export ---------------------------------------------------------------

  async export(): Promise<ExportResult> {
    const sr = this.sampleRate
    const tail = Math.round(EXPORT_TAIL_SECONDS * sr)
    const commands: Command[] = [[Op.MasterGain, 0, 0, MASTER_GAIN], ...vibeCommands(this.vibe)]
    let frames: number
    let song: Int16Array | null = null

    if (this.mode === 'song') {
      if (!this.song) throw new Error('Load a song first')
      song = this.song.data
      frames = Math.ceil(this.song.frames / this.vibe.speed) + tail
      commands.push([Op.SongPlaying, 1, 0, 0])
    } else {
      const steps = EXPORT_LOOPS * this.stepCount
      const stepFrames = (sr * 60) / this.bpm / 4 / this.vibe.speed
      frames = Math.ceil(steps * stepFrames) + tail
      this.pattern.forEach((row, pad) => row.forEach((on, step) => on && commands.push([Op.SetStep, pad, step, 1])))
      commands.push(
        [Op.PatternLength, this.stepCount, 0, 0],
        [Op.Bpm, 0, 0, this.bpm],
        [Op.Playing, 1, 0, 0],
        [Op.StopAfterSteps, steps, 0, 0],
      )
    }

    const t0 = performance.now()
    const rendered = await renderOffline(sr, frames, {
      pads: this.mode === 'beat' ? this.pads.map((p) => p.data) : [],
      song,
      commands,
    })
    const renderMs = performance.now() - t0

    const slowed = this.vibe.speed < 1 ? `-${this.vibe.speed.toFixed(2)}x` : ''
    const base = this.mode === 'song' ? slug(this.song!.name) : `beat-${this.bpm}bpm`
    return {
      blob: encodeWav(rendered),
      fileName: `webrack-${base}${slowed}.wav`,
      seconds: frames / sr,
      renderMs,
    }
  }

  // --- Internals ------------------------------------------------------------

  private kitPad(pad: number): Pad {
    const sound = DEMO_KIT[pad]
    return { name: sound.name, data: sound.render(this.sampleRate), custom: false }
  }

  private async setPad(pad: number, value: Pad): Promise<void> {
    this.pads[pad] = value
    await this.engine.loadPad(pad, value.data)
  }

  private async restore(): Promise<void> {
    const [session, saved] = await Promise.all([load<SavedSession>('session'), load<SavedPad[]>('pads')])

    this.pads = Array.from({ length: NUM_PADS }, (_, i) => this.kitPad(i))
    for (const p of saved ?? []) {
      if (p.index < 0 || p.index >= NUM_PADS) continue
      this.pads[p.index] = { name: p.name, data: await resample(p.data, p.sampleRate, this.sampleRate), custom: true }
    }
    await Promise.all(this.pads.map((p, i) => this.engine.loadPad(i, p.data)))

    if (session) {
      // Older sessions saved 16-step rows; widen them.
      this.pattern = session.pattern.map((row) => [...row, ...Array(Math.max(0, MAX_STEPS - row.length)).fill(false)])
      this.stepCount = session.stepCount ?? 16
      this.bpm = session.bpm
      this.vibe = { ...FLAT_VIBE, ...session.vibe }
      this.selected = session.selected
    } else {
      for (const [pad, steps] of Object.entries(DEMO_PATTERN)) for (const s of steps) this.pattern[Number(pad)][s] = true
    }

    const commands: Command[] = [
      [Op.MasterGain, 0, 0, MASTER_GAIN],
      [Op.PatternLength, this.stepCount, 0, 0],
      [Op.Bpm, 0, 0, this.bpm],
      ...vibeCommands(this.vibe),
    ]
    this.pattern.forEach((row, pad) => row.forEach((on, step) => on && commands.push([Op.SetStep, pad, step, 1])))
    await this.engine.applyNow(commands)
  }

  private changed(persist = true): void {
    this.onChange()
    if (!persist) return
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.persist(), 400)
  }

  private async persist(): Promise<void> {
    const session: SavedSession = {
      pattern: this.pattern,
      stepCount: this.stepCount,
      bpm: this.bpm,
      vibe: this.vibe,
      selected: this.selected,
    }
    const pads: SavedPad[] = []
    this.pads.forEach((p, index) => {
      if (p.custom && p.data) pads.push({ index, name: p.name, sampleRate: this.sampleRate, data: p.data })
    })
    await Promise.all([save('session', session), save('pads', pads)])
  }
}

function vibeCommands(v: Partial<Vibe>): Command[] {
  const out: Command[] = []
  if (v.speed !== undefined) out.push([Op.Speed, 0, 0, v.speed])
  if (v.size !== undefined) out.push([Op.Reverb, ReverbParam.Size, 0, v.size])
  if (v.damping !== undefined) out.push([Op.Reverb, ReverbParam.Damping, 0, v.damping])
  if (v.preDelayMs !== undefined) out.push([Op.Reverb, ReverbParam.PreDelayMs, 0, v.preDelayMs])
  if (v.mix !== undefined) out.push([Op.Reverb, ReverbParam.Mix, 0, v.mix])
  if (v.low !== undefined) out.push([Op.EqGain, 0, 0, v.low])
  if (v.mid !== undefined) out.push([Op.EqGain, 1, 0, v.mid])
  if (v.high !== undefined) out.push([Op.EqGain, 2, 0, v.high])
  return out
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'song'
}
