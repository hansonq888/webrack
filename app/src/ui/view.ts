import {
  EXPORT_LOOPS,
  FLAT_VIBE,
  NUM_PADS,
  SLOWED_REVERB,
  STEP_COUNTS,
  Studio,
  type ExportResult,
  type RecordEvent,
  type Vibe,
} from '../state/studio'
import { MAX_RECORD_SECONDS } from '../audio/recorder'
import { Knob, type KnobOptions } from './knob'
import { FINISHES, applyFinish, type Finish } from './finish'

const PAD_KEYS = '1234qwerasdfzxcv'
const PAGE_STEPS = 16 // steps shown at once; longer patterns are paged

const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel)!

export function mountStartScreen(root: HTMLElement, onStart: () => Promise<void>): void {
  root.innerHTML = `
    <div class="device device-start">
      ${deviceTop()}
      <div class="lcd lcd-start" aria-hidden="true">
        <div class="lcd-row"><span>WEBRACK</span><span>v1</span></div>
        <div class="lcd-big">READY</div>
        <div class="lcd-row"><span>16 PADS</span><span>SLOWED+REVERB</span></div>
      </div>
      <p class="start-pitch">Make a beat with your voice.<br />Slow it down. Drown it in reverb.</p>
      <button class="key key-orange key-start" id="start">Start</button>
      ${deviceFoot('No signup. Your audio never leaves this device.')}
    </div>`
  bindFinishSwitch(root)
  const button = $<HTMLButtonElement>(root, '#start')
  button.addEventListener('click', async () => {
    button.disabled = true
    button.textContent = 'Starting…'
    try {
      await onStart()
    } catch (err) {
      console.error(err)
      button.disabled = false
      button.textContent = 'Tap to retry'
      $(root, '.lcd-big').textContent = 'NO AUDIO'
    }
  })
}

// Footer: fine print plus the finish (colorway) switch.
function deviceFoot(text: string): string {
  return `
    <footer class="device-foot">
      <p class="fine-print">${text}</p>
      <div class="seg finish-switch" role="group" aria-label="Finish">
        ${FINISHES.map((f) => `<button class="key key-tiny" data-finish="${f}">${f}</button>`).join('')}
      </div>
    </footer>`
}

function bindFinishSwitch(root: HTMLElement): void {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-finish]')]
  const sync = () =>
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.finish === document.documentElement.dataset.finish)))
  buttons.forEach((b) =>
    b.addEventListener('click', () => {
      applyFinish(b.dataset.finish as Finish)
      sync()
    }),
  )
  sync()
}

function deviceTop(): string {
  return `
    <header class="device-top">
      <div class="brand">
        <span class="wordmark">webrack</span>
        <span class="model">WR-16 · Sampling console</span>
      </div>
      <div class="lamps" aria-hidden="true">
        <span class="lamp-group"><i class="lamp lamp-rec"></i>Rec</span>
        <span class="lamp-group"><i class="lamp lamp-run"></i>Run</span>
      </div>
    </header>`
}

export function mountStudio(root: HTMLElement, studio: Studio): void {
  root.innerHTML = `
    <div class="device">
      ${deviceTop()}
      <div class="device-grid">
        <div class="col-main">
          <div class="lcd" aria-live="polite">
            <div class="lcd-row">
              <span id="lcd-mode">BEAT</span>
              <span class="beat-only">BPM <b id="lcd-bpm"></b></span>
              <span>SPD <b id="lcd-speed"></b></span>
            </div>
            <div class="lcd-steps beat-only" id="lcd-steps"></div>
            <div class="lcd-progress song-only"><i id="lcd-progress"></i></div>
            <div class="lcd-row">
              <span id="lcd-msg" class="lcd-msg"></span>
              <span class="lcd-meter" aria-hidden="true"><i id="meter-l"></i><i id="meter-r"></i></span>
            </div>
          </div>

          <div class="mode-switch" role="tablist" aria-label="Source">
            <button class="key key-small" role="tab" data-mode="beat">Beat</button>
            <button class="key key-small" role="tab" data-mode="song">Song</button>
          </div>

          <section class="beat-only beat-section">
            <div class="pads" role="group" aria-label="Pads">
              ${Array.from({ length: NUM_PADS }, (_, i) => `
                <button class="pad" data-pad="${i}">
                  <span class="pad-key">${PAD_KEYS[i].toUpperCase()}</span>
                  <span class="pad-name"></span>
                  <i class="pad-led"></i>
                </button>`).join('')}
            </div>

            <div class="pad-tools">
              <button class="key key-red" id="rec"><i class="rec-dot"></i> <span id="rec-label">Rec</span></button>
              <button class="key" id="load">Load</button>
              <button class="key" id="reset">Reset</button>
              <input type="file" id="load-input" accept="audio/*,.wav,.mp3,.flac,.m4a,.ogg" hidden />
            </div>

            <div class="section-label"><span>Steps</span><b id="steps-pad"></b></div>
            <div class="steps-bar">
              <div class="seg" role="group" aria-label="Pattern length">
                ${STEP_COUNTS.map((n) => `<button class="key key-small" data-count="${n}">${n}</button>`).join('')}
              </div>
              <div class="seg pages" role="group" aria-label="Bar">
                ${[0, 1, 2, 3].map((p) => `<button class="key key-small" data-page="${p}" aria-label="Bar ${p + 1}">${p + 1}<i class="page-led"></i></button>`).join('')}
              </div>
            </div>
            <div class="steps" role="group" aria-label="Steps">
              ${Array.from({ length: PAGE_STEPS }, (_, i) => `<button class="step" data-step="${i}"><i></i></button>`).join('')}
            </div>
          </section>

          <section class="song-only song-panel">
            <label class="drop" id="song-drop">
              <input type="file" id="song-input" accept="audio/*,.wav,.mp3,.flac,.m4a,.ogg" hidden />
              <b id="song-name">Drop a song here</b>
              <span id="song-hint">or tap to choose a file (WAV, MP3, FLAC · up to 6 min)</span>
            </label>
            <div class="song-bar" id="song-bar" role="slider" aria-label="Song position" tabindex="0"><i id="song-fill"></i></div>
          </section>

          <div class="transport">
            <button class="key key-orange key-play" id="play" aria-label="Play">▶</button>
            <label class="fader beat-only">
              <span class="fader-label">BPM</span>
              <input type="range" id="bpm" min="60" max="180" step="1" aria-label="Tempo in BPM" />
              <output id="bpm-out"></output>
            </label>
            <button class="key beat-only" id="clear">Clear</button>
          </div>
        </div>

        <div class="col-side">
          <div class="section-label"><span>Vibe</span></div>
          <div class="presets">
            <button class="key key-orange" id="preset-slowed">Slowed + reverb</button>
            <button class="key" id="preset-flat">Dry</button>
          </div>
          <div class="knobs" id="knobs"></div>

          <div class="section-label"><span>Out</span></div>
          <div class="export">
            <button class="key key-cream key-wide" id="export">Export WAV</button>
            <div class="export-result" id="export-result" hidden>
              <div class="export-file" id="export-file"></div>
              <div class="export-actions">
                <button class="key key-orange" id="share">Share</button>
                <a class="key" id="download">Download</a>
              </div>
            </div>
          </div>
        </div>
      </div>
      ${deviceFoot('Your audio never leaves this device. Drag an audio file onto a pad to load it.')}
    </div>`

  bindFinishSwitch(root)
  new StudioView(root, studio)
}

class StudioView {
  private readonly pads: HTMLButtonElement[]
  private readonly steps: HTMLButtonElement[]
  private lcdSteps: HTMLElement[] = []
  private lcdStepCount = 0
  private page = 0 // which 16-step bar the step keys show
  private readonly knobs = new Map<keyof Vibe, Knob>()
  private message: { text: string; until: number } | null = null
  private exportUrl: string | null = null
  private exporting = false
  private lastExport: ExportResult | null = null
  private readonly root: HTMLElement
  private readonly studio: Studio

  constructor(root: HTMLElement, studio: Studio) {
    this.root = root
    this.studio = studio
    this.pads = [...root.querySelectorAll<HTMLButtonElement>('.pad')]
    this.steps = [...root.querySelectorAll<HTMLButtonElement>('.step')]
    this.buildKnobs()
    this.bindPads()
    this.bindControls()
    studio.onChange = () => this.render()
    studio.onRecordEvent = (event) => this.onRecordEvent(event)
    this.render()
    requestAnimationFrame(this.frame)
  }

  // --- Setup ------------------------------------------------------------------

  private buildKnobs(): void {
    const s = this.studio
    const pct = (v: number) => `${Math.round(v * 100)}%`
    const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`
    const specs: [keyof Vibe, Omit<KnobOptions, 'value' | 'onInput'>][] = [
      ['speed', { label: 'Speed', cap: 'yellow', min: 0.5, max: 1, reset: 1, step: 0.01, format: (v) => `${v.toFixed(2)}×` }],
      ['mix', { label: 'Reverb', cap: 'red', min: 0, max: 1, reset: FLAT_VIBE.mix, format: pct }],
      ['size', { label: 'Size', cap: 'blue', min: 0, max: 1, reset: FLAT_VIBE.size, format: pct }],
      ['damping', { label: 'Damp', cap: 'blue', min: 0, max: 1, reset: FLAT_VIBE.damping, format: pct }],
      ['preDelayMs', { label: 'Pre', cap: 'blue', min: 0, max: 200, reset: FLAT_VIBE.preDelayMs, step: 1, format: (v) => `${Math.round(v)}ms` }],
      ['low', { label: 'Low', cap: 'green', min: -12, max: 12, reset: 0, step: 0.5, format: db }],
      ['mid', { label: 'Mid', cap: 'green', min: -12, max: 12, reset: 0, step: 0.5, format: db }],
      ['high', { label: 'High', cap: 'green', min: -12, max: 12, reset: 0, step: 0.5, format: db }],
    ]
    const container = $(this.root, '#knobs')
    for (const [key, spec] of specs) {
      const knob = new Knob({ ...spec, value: s.vibe[key], onInput: (v) => s.setVibe(key, v) })
      this.knobs.set(key, knob)
      container.append(knob.el)
    }
  }

  private bindPads(): void {
    const s = this.studio
    this.pads.forEach((pad, i) => {
      pad.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        this.hit(i)
      })
      // Keyboard activation (Enter/Space on a focused pad) arrives as click with detail 0.
      pad.addEventListener('click', (e) => {
        if (e.detail === 0) this.hit(i)
      })
      pad.addEventListener('dragover', (e) => {
        e.preventDefault()
        pad.classList.add('drop-target')
      })
      pad.addEventListener('dragleave', () => pad.classList.remove('drop-target'))
      pad.addEventListener('drop', (e) => {
        e.preventDefault()
        pad.classList.remove('drop-target')
        const file = e.dataTransfer?.files[0]
        if (file) void this.loadToPad(i, file)
      })
    })

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target instanceof Element ? e.target : document.body
      if (target.closest('input, [role="slider"]')) return
      if (e.key === ' ' && !target.closest('button, a')) {
        e.preventDefault()
        s.togglePlay()
        return
      }
      const i = PAD_KEYS.indexOf(e.key.toLowerCase())
      if (i < 0 || s.mode !== 'beat') return
      e.preventDefault()
      if (!e.repeat) this.hit(i)
    })

    this.steps.forEach((step, i) =>
      step.addEventListener('click', () => s.toggleStep(s.selected, this.page * PAGE_STEPS + i)),
    )
  }

  private bindControls(): void {
    const s = this.studio
    const on = (sel: string, fn: (e: Event) => void) => $(this.root, sel).addEventListener('click', fn)

    this.root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => s.setMode(b.dataset.mode as 'beat' | 'song')),
    )

    on('#rec', () => void this.toggleRecording())
    const loadInput = $<HTMLInputElement>(this.root, '#load-input')
    on('#load', () => loadInput.click())
    loadInput.addEventListener('change', () => {
      const file = loadInput.files?.[0]
      if (file) void this.loadToPad(s.selected, file)
      loadInput.value = ''
    })
    on('#reset', () => void s.resetPad(s.selected).then(() => this.flash('KIT SOUND RESTORED')))

    on('#play', () => s.togglePlay())
    const bpm = $<HTMLInputElement>(this.root, '#bpm')
    bpm.addEventListener('input', () => s.setBpm(Number(bpm.value)))
    this.root.querySelectorAll<HTMLButtonElement>('[data-count]').forEach((b) =>
      b.addEventListener('click', () => s.setStepCount(Number(b.dataset.count) as 16 | 32 | 64)),
    )
    this.root.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((b) =>
      b.addEventListener('click', () => {
        this.page = Number(b.dataset.page)
        this.render()
      }),
    )
    on('#clear', () => {
      s.clearPattern()
      this.flash('PATTERN CLEARED')
    })

    on('#preset-slowed', () => {
      s.applyVibe(SLOWED_REVERB)
      this.flash('SLOWED + REVERB')
    })
    on('#preset-flat', () => {
      s.applyVibe(FLAT_VIBE)
      this.flash('DRY')
    })

    // Song loading: tap to choose, or drop anywhere on the panel.
    const songInput = $<HTMLInputElement>(this.root, '#song-input')
    songInput.addEventListener('change', () => {
      const file = songInput.files?.[0]
      if (file) void this.loadSong(file)
      songInput.value = ''
    })
    const drop = $(this.root, '#song-drop')
    drop.addEventListener('dragover', (e) => {
      e.preventDefault()
      drop.classList.add('drop-target')
    })
    drop.addEventListener('dragleave', () => drop.classList.remove('drop-target'))
    drop.addEventListener('drop', (e) => {
      e.preventDefault()
      drop.classList.remove('drop-target')
      const file = e.dataTransfer?.files[0]
      if (file) void this.loadSong(file)
    })
    const bar = $(this.root, '#song-bar')
    bar.addEventListener('pointerdown', (e) => {
      const rect = bar.getBoundingClientRect()
      s.seekSong((e.clientX - rect.left) / rect.width)
    })

    on('#export', () => void this.export())
    on('#share', () => void this.share())
  }

  // --- Actions ----------------------------------------------------------------

  private hit(i: number): void {
    this.studio.hit(i)
    this.studio.select(i)
    const pad = this.pads[i]
    pad.classList.remove('hit')
    void pad.offsetWidth // restart the flash animation
    pad.classList.add('hit')
  }

  // Rec arms the mic; the take starts on sound and ends on silence. Tapping
  // again stops early (or cancels if nothing has been heard yet).
  private async toggleRecording(): Promise<void> {
    const s = this.studio
    if (s.recording) {
      s.stopRecording()
      return
    }
    try {
      await s.armRecording()
    } catch (err) {
      console.error(err)
      this.flash('MIC BLOCKED · ALLOW THE MICROPHONE', 4000)
    }
  }

  private onRecordEvent(event: RecordEvent): void {
    const n = event.pad + 1
    switch (event.type) {
      case 'started':
        navigator.vibrate?.(35) // Android; iOS doesn't let websites vibrate
        break
      case 'recorded':
        this.flash(`RECORDED ON PAD ${n}`)
        this.hit(event.pad)
        break
      case 'silent':
        this.flash("DIDN'T CATCH THAT · TRY AGAIN", 2500)
        break
      case 'cancelled':
        this.flash('RECORDING CANCELLED')
        break
      case 'timeout':
        this.flash('NO SOUND HEARD · TAP REC AGAIN', 3000)
        break
    }
  }

  private async loadToPad(pad: number, file: File): Promise<void> {
    this.flash('LOADING…')
    try {
      await this.studio.loadFileToPad(pad, file)
      this.studio.select(pad)
      this.flash(`LOADED ON PAD ${pad + 1}`)
    } catch (err) {
      console.error(err)
      this.flash("COULDN'T READ THAT FILE", 3000)
    }
  }

  private async loadSong(file: File): Promise<void> {
    this.flash('DECODING…', 60_000)
    try {
      await this.studio.loadSong(file)
      this.flash(this.studio.song?.truncated ? 'LOADED · TRIMMED TO 6 MIN' : 'SONG LOADED', 2500)
    } catch (err) {
      console.error(err)
      this.flash("COULDN'T READ THAT FILE", 3000)
    }
  }

  private async export(): Promise<void> {
    if (this.exporting) return
    const s = this.studio
    if (s.mode === 'song' && !s.song) {
      this.flash('LOAD A SONG FIRST')
      return
    }
    this.exporting = true
    this.flash('RENDERING…', 120_000)
    const button = $<HTMLButtonElement>(this.root, '#export')
    button.disabled = true
    try {
      this.showExport(await s.export())
      this.flash('READY TO SHARE', 3000)
    } catch (err) {
      console.error(err)
      this.flash('EXPORT FAILED', 3000)
    } finally {
      this.exporting = false
      button.disabled = false
    }
  }

  private showExport(result: ExportResult): void {
    this.lastExport = result
    if (this.exportUrl) URL.revokeObjectURL(this.exportUrl)
    this.exportUrl = URL.createObjectURL(result.blob)
    const download = $<HTMLAnchorElement>(this.root, '#download')
    download.href = this.exportUrl
    download.download = result.fileName
    const mb = (result.blob.size / 1e6).toFixed(1)
    const what = this.studio.mode === 'beat' ? `${EXPORT_LOOPS} × ${this.studio.stepCount / PAGE_STEPS} bars · ` : ''
    $(this.root, '#export-file').textContent =
      `${result.fileName} · ${what}${formatTime(result.seconds)} · ${mb} MB · rendered in ${(result.renderMs / 1000).toFixed(1)} s`
    const file = new File([result.blob], result.fileName, { type: 'audio/wav' })
    $(this.root, '#share').hidden = !navigator.canShare?.({ files: [file] })
    $(this.root, '#export-result').hidden = false
  }

  private async share(): Promise<void> {
    const result = this.lastExport
    if (!result) return
    const file = new File([result.blob], result.fileName, { type: 'audio/wav' })
    try {
      await navigator.share({ files: [file], title: 'Made on WebRack' })
    } catch (err) {
      if ((err as Error).name !== 'AbortError') this.flash('SHARE FAILED · TRY DOWNLOAD', 3000)
    }
  }

  private flash(text: string, ms = 1800): void {
    this.message = { text, until: performance.now() + ms }
  }

  // --- Rendering ----------------------------------------------------------------

  private render(): void {
    const s = this.studio
    this.root.querySelector('.device')!.setAttribute('data-mode', s.mode)
    this.root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.setAttribute('aria-selected', String(b.dataset.mode === s.mode)),
    )
    $(this.root, '#lcd-mode').textContent = s.mode === 'beat' ? 'BEAT' : 'SONG'
    $(this.root, '#lcd-bpm').textContent = String(s.bpm).padStart(3, '0')
    $(this.root, '#bpm-out').textContent = String(s.bpm)
    const bpmInput = $<HTMLInputElement>(this.root, '#bpm')
    if (document.activeElement !== bpmInput) bpmInput.value = String(s.bpm)
    $(this.root, '#lcd-speed').textContent = `${s.vibe.speed.toFixed(2)}×`

    this.pads.forEach((pad, i) => {
      $(pad, '.pad-name').textContent = s.pads[i]?.name ?? ''
      pad.classList.toggle('selected', i === s.selected)
      pad.classList.toggle('custom', !!s.pads[i]?.custom)
      pad.classList.toggle('has-steps', s.padHasSteps(i))
      pad.setAttribute('aria-label', `Pad ${i + 1}: ${s.pads[i]?.name ?? 'empty'} (key ${PAD_KEYS[i].toUpperCase()})`)
    })
    // Pattern length and bar pages.
    const bars = s.stepCount / PAGE_STEPS
    if (this.page >= bars) this.page = 0
    this.root.querySelectorAll<HTMLButtonElement>('[data-count]').forEach((b) =>
      b.setAttribute('aria-pressed', String(Number(b.dataset.count) === s.stepCount)),
    )
    this.root.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((b) => {
      const p = Number(b.dataset.page)
      b.hidden = bars === 1 || p >= bars
      b.setAttribute('aria-pressed', String(p === this.page))
    })
    this.steps.forEach((step, i) => {
      const index = this.page * PAGE_STEPS + i
      const on = s.pattern[s.selected][index]
      step.classList.toggle('on', on)
      step.setAttribute('aria-pressed', String(on))
      step.setAttribute('aria-label', `Step ${index + 1}`)
    })
    if (this.lcdStepCount !== s.stepCount) {
      const lcd = $(this.root, '#lcd-steps')
      lcd.innerHTML = '<i></i>'.repeat(s.stepCount)
      lcd.style.setProperty('--steps', String(s.stepCount))
      this.lcdSteps = [...lcd.querySelectorAll<HTMLElement>('i')]
      this.lcdStepCount = s.stepCount
    }
    $(this.root, '#steps-pad').textContent = s.pads[s.selected]?.name ?? ''

    // Recording state drives the Rec key, the target pad and the REC lamp.
    const recState = s.recording?.state
    const rec = recState === 'recording' ? 'live' : recState === 'armed' ? 'armed' : ''
    this.root.querySelector('.device')!.setAttribute('data-rec', rec)
    $(this.root, '#rec-label').textContent = rec === 'live' ? 'Stop' : rec === 'armed' ? 'Armed' : 'Rec'
    this.pads.forEach((pad, i) => pad.classList.toggle('rec-target', !!rec && i === s.recordingPad))
    $(this.root, '#reset').toggleAttribute('disabled', !s.pads[s.selected]?.custom)

    if (s.song) {
      $(this.root, '#song-name').textContent = s.song.name
      $(this.root, '#song-hint').textContent = `${formatTime(s.song.frames / s.sampleRate)} · tap to load another`
    }
    for (const [key, knob] of this.knobs) knob.set(s.vibe[key])
  }

  private readonly frame = () => {
    const s = this.studio
    const st = s.engine.status()

    const playing = s.mode === 'song' ? st.songPlaying : s.playing
    const play = $(this.root, '#play')
    play.textContent = playing ? '■' : '▶'
    play.setAttribute('aria-label', playing ? 'Stop' : 'Play')
    play.classList.toggle('lit', playing)

    this.lcdSteps.forEach((dot, i) => dot.classList.toggle('now', i === st.step))
    this.steps.forEach((step, i) => step.classList.toggle('now', this.page * PAGE_STEPS + i === st.step))
    this.root.querySelectorAll<HTMLElement>('[data-page]').forEach((b) =>
      b.classList.toggle('playing', st.step >= 0 && Math.floor(st.step / PAGE_STEPS) === Number(b.dataset.page)),
    )

    // While recording, the meters show the mic input instead of the output.
    const input = s.recording?.level
    $(this.root, '#meter-l').style.setProperty('--level', String(meter(input ?? st.peakLeft)))
    $(this.root, '#meter-r').style.setProperty('--level', String(meter(input ?? st.peakRight)))
    this.root.querySelector('.device')!.classList.toggle('running', playing)

    const progress = st.songLength > 0 ? st.songFrame / st.songLength : 0
    $(this.root, '#lcd-progress').style.transform = `scaleX(${progress})`
    $(this.root, '#song-fill').style.transform = `scaleX(${progress})`

    $(this.root, '#lcd-msg').textContent = this.lcdMessage(st.songFrame)
    requestAnimationFrame(this.frame)
  }

  private lcdMessage(songFrame: number): string {
    const s = this.studio
    if (s.recording?.state === 'armed') return `ARMED · MAKE A SOUND · PAD ${s.recordingPad + 1}`
    if (s.recording?.state === 'recording') {
      const secs = Math.min(s.recording.seconds, MAX_RECORD_SECONDS)
      return `● REC ${secs.toFixed(1)}s · PAD ${s.recordingPad + 1}`
    }
    if (this.message && performance.now() < this.message.until) return this.message.text
    if (s.mode === 'song') {
      if (!s.song) return 'LOAD A SONG'
      return `${formatTime(songFrame / s.sampleRate)} / ${formatTime(s.song.frames / s.sampleRate)}`
    }
    return `${String(s.selected + 1).padStart(2, '0')} ${s.pads[s.selected]?.name.toUpperCase() ?? ''}`
  }
}

// Peak → meter length on a -48..0 dB scale.
function meter(peak: number): number {
  if (peak <= 0) return 0
  const db = 20 * Math.log10(peak)
  return Math.max(0, Math.min(1, (db + 48) / 48))
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
