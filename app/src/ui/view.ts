import {
  EXPORT_LOOPS,
  DEFAULT_LEVEL,
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
import { settingsControl, bindSettings } from './settings'
import { Scope, Spectrum, Waveform, type VizColors } from './visualizer'

const PAD_KEYS = '1234qwerasdfzxcv'
const PAGE_STEPS = 16 // steps shown at once; longer patterns are paged

const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel)!

// Two ways in: make a beat, or slow down a song you already have.
export function mountStartScreen(root: HTMLElement, onStart: (mode: 'beat' | 'song') => Promise<void>): void {
  root.innerHTML = `
    <div class="device device-start">
      ${deviceTop()}
      <div class="lcd lcd-start" aria-hidden="true">
        <div class="lcd-row"><span>WEBRACK</span><span>v1</span></div>
        <div class="lcd-big">READY</div>
        <div class="lcd-row"><span>16 PADS</span><span>SLOWED+REVERB</span></div>
      </div>
      <p class="start-pitch">Make a beat with your voice, or bring a song.<br />Slow it down. Drown it in reverb.</p>
      <div class="start-choices">
        <button class="key key-orange key-start" data-start="beat">
          <span class="start-title">Make a beat</span>
          <span class="start-sub">16 pads · your voice · step sequencer</span>
        </button>
        <button class="key key-start key-start-alt" data-start="song">
          <span class="start-title">Slow a song</span>
          <span class="start-sub">Drop in a track · slowed + reverb</span>
        </button>
      </div>
      ${deviceFoot('No signup. Your audio never leaves this device.')}
    </div>`
  bindSettings(root, null)
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-start]')]
  buttons.forEach((button) =>
    button.addEventListener('click', async () => {
      buttons.forEach((b) => (b.disabled = true))
      const title = $(button, '.start-title')
      const label = title.textContent
      title.textContent = 'Starting…'
      try {
        await onStart(button.dataset.start as 'beat' | 'song')
      } catch (err) {
        console.error(err)
        buttons.forEach((b) => (b.disabled = false))
        title.textContent = label
        $(root, '.lcd-big').textContent = 'NO AUDIO'
      }
    }),
  )
}

// Footer: fine print plus the finish (colorway) switch.
function deviceFoot(text: string): string {
  return `
    <footer class="device-foot">
      <p class="fine-print">${text}</p>
    </footer>`
}

// Export lives in the studio's header (top right); the result drops down
// under it as a small card with Share and Download.
function exportControl(): string {
  return `
    <div class="export-wrap">
      <button class="key key-small key-cream" id="export">
        <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M7 2h2v6.6l2.3-2.3 1.4 1.4L8 12.4 3.3 7.7l1.4-1.4L7 8.6Z" /><path d="M3 13h10v2H3z" /></svg>
        Export
      </button>
      <div class="export-pop" id="export-result" role="dialog" aria-label="Exported file" hidden>
        <div class="export-file" id="export-file"></div>
        <div class="export-actions">
          <button class="key key-small key-orange" id="share">Share</button>
          <a class="key key-small" id="download">Download</a>
        </div>
        <button class="export-close" id="export-close" aria-label="Close">×</button>
      </div>
    </div>`
}

function deviceTop(withExport = false): string {
  return `
    <span class="screws" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <header class="device-top">
      <div class="brand">
        <a class="wordmark" href="/" aria-label="WebRack home">webrack</a>
        <span class="model">WR-16 · Sampling console</span>
      </div>
      <div class="grille" aria-hidden="true"></div>
      <div class="header-right">
        <div class="lamps" aria-hidden="true">
          <span class="lamp-group"><i class="lamp lamp-rec"></i>Rec</span>
          <span class="lamp-group"><i class="lamp lamp-run"></i>Run</span>
        </div>
        ${settingsControl(withExport)}
        ${withExport ? exportControl() : ''}
      </div>
    </header>`
}

export function mountStudio(root: HTMLElement, studio: Studio): void {
  root.innerHTML = `
    <canvas class="backdrop-scope" id="scope" aria-hidden="true"></canvas>
    <div class="device">
      ${deviceTop(true)}
      <div class="machine">
        <section class="m-screen">
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
            <div class="lcd-row lcd-status" id="lcd-status"></div>
          </div>
        </section>

        <section class="m-transport beat-only">
          <div class="section-label"><span>Transport</span></div>
          <button class="key key-transport" id="stop" aria-label="Stop"><span class="glyph">■</span> Stop</button>
          <button class="key key-orange key-transport key-play" id="play" aria-label="Play"><span class="glyph">▶</span> Play</button>
          <div class="tempo" role="group" aria-label="Tempo">
            <span class="tempo-label">Tempo</span>
            <output class="tempo-led" id="bpm-out" aria-live="off"></output>
            <div id="tempo-knob"></div>
            <button class="key key-small" id="tap" aria-label="Tap tempo (T)">Tap</button>
          </div>
        </section>

        <section class="m-pads">
          <div class="beat-only pad-block">
            <div class="section-label"><span>Pads</span><b>1–16</b></div>
            <div class="pad-well">
            <div class="pads" role="group" aria-label="Pads">
              ${Array.from({ length: NUM_PADS }, (_, i) => `
                <button class="pad" data-pad="${i}">
                  <span class="pad-num">${String(i + 1).padStart(2, '0')}</span>
                  <span class="pad-foot"><span class="pad-name"></span><span class="pad-key">${PAD_KEYS[i].toUpperCase()}</span></span>
                  <i class="pad-led"></i>
                </button>`).join('')}
            </div>
            <div class="pad-tools" role="group" aria-label="Selected pad">
              <span class="pad-target" aria-hidden="true"><b id="target-num"></b><span id="target-name"></span></span>
              <button class="key key-small" id="rec"><i class="rec-dot"></i> <span id="rec-label">Rec</span></button>
              <button class="key key-small" id="load">Load</button>
              <button class="key key-small" id="reset">Reset</button>
              <input type="file" id="load-input" accept="audio/*,.wav,.mp3,.flac,.m4a,.ogg" hidden />
            </div>
            </div>
          </div>

          <div class="song-only song-panel">
            <label class="drop song-screen" id="song-drop">
              <input type="file" id="song-input" accept="audio/*,.wav,.mp3,.flac,.m4a,.ogg" hidden />
              <canvas class="viz" id="viz" aria-hidden="true"></canvas>
              <span class="song-meta">
                <b id="song-name">Drop a song here</b>
                <span id="song-hint">or tap to choose a file (WAV, MP3, FLAC · up to 6 min)</span>
              </span>
            </label>
            <div class="song-transport">
              <button class="key key-orange key-transport song-play" id="song-play" aria-label="Play">
                <svg class="icon icon-play" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4a.8.8 0 0 0 1.2.7l8.3-5.2a.8.8 0 0 0 0-1.4L5.7 2.1a.8.8 0 0 0-1.2.7Z" /></svg>
                <svg class="icon icon-pause" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3.2" height="11" rx="0.8" /><rect x="9.3" y="2.5" width="3.2" height="11" rx="0.8" /></svg>
                <span id="song-play-label">Play</span>
              </button>
              <div class="song-timeline">
                <div class="song-bar" id="song-bar" role="slider" aria-label="Song position" tabindex="0">
                  <canvas class="wave" id="wave" aria-hidden="true"></canvas><b class="song-head" id="song-head"></b>
                </div>
                <div class="song-times"><span id="song-now">0:00</span><span id="song-total">0:00</span></div>
              </div>
            </div>
          </div>
        </section>

        <section class="m-seq beat-only">
          <div class="seq-head">
            <div class="section-label"><span>Steps</span><b id="steps-pad"></b></div>
            <button class="key key-small" id="clear" aria-label="Clear the pattern">Clear</button>
            <button class="key key-small" id="len" aria-label="Pattern length"></button>
          </div>
          <div class="bar-tabs" role="tablist" aria-label="Bars">
            ${[0, 1, 2, 3].map((b) => `
              <button class="key key-small bar-tab" role="tab" data-bar="${b}">
                <span class="bar-num">Bar ${b + 1}</span>
                <span class="bar-mini" aria-hidden="true">${'<i></i>'.repeat(PAGE_STEPS)}</span>
                <i class="bar-led" aria-hidden="true"></i>
              </button>`).join('')}
          </div>
          <div class="steps" role="group" aria-label="Steps">
            ${Array.from({ length: PAGE_STEPS }, (_, i) => `<button class="step" data-step="${i}"><i></i><span class="step-num">${i + 1}</span></button>`).join('')}
          </div>
        </section>

        <section class="m-qlink">
          <div class="panel-top">
            <div class="panel-switches">
              <div class="switch-group">
                <div class="rocker" role="group" aria-label="Source">
                  <button class="key" data-mode="beat">Beat</button>
                  <button class="key" data-mode="song">Song</button>
                </div>
                <span class="switch-label">Beat / Song</span>
              </div>
              <div class="switch-group">
                <div class="rocker" role="group" aria-label="Effects">
                  <button class="key" data-fx="active">On</button>
                  <button class="key" data-fx="bypass">Bypass</button>
                </div>
                <span class="switch-label">FX active / bypass</span>
              </div>
              <div class="section-label vibe-rule"><span>Vibe</span></div>
              <label class="slide-switch">
                <input type="checkbox" role="switch" id="slowed-switch" />
                <span class="slide-track" aria-hidden="true"><span class="slide-thumb"></span></span>
                <span class="switch-label">Slowed + reverb</span>
              </label>
            </div>
          </div>
          <div class="knob-boxes">
            <fieldset class="knob-box">
              <legend>Deck</legend>
              <div class="knobs" id="knobs-deck"></div>
            </fieldset>
            <fieldset class="knob-box">
              <legend>Reverb</legend>
              <div class="knobs" id="knobs-reverb"></div>
            </fieldset>
            <fieldset class="knob-box">
              <legend>Tone</legend>
              <div class="knobs" id="knobs-tone"></div>
            </fieldset>
          </div>
        </section>

      </div>
      ${deviceFoot('Your audio never leaves this device. Drag an audio file onto a pad to load it.')}
    </div>`

  const view = new StudioView(root, studio)
  bindSettings(root, studio, (msg) => view.flash(msg))
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
  private tempoKnob: Knob | null = null
  private levelKnob: Knob | null = null
  private readonly spectrum: Spectrum
  private readonly waveform: Waveform
  private readonly scope: Scope
  private vizColors: { spectrum: VizColors; wave: VizColors } | null = null
  private vizColorsAt = 0
  private taps: number[] = []
  private litStep = -1
  private readonly root: HTMLElement
  private readonly studio: Studio

  constructor(root: HTMLElement, studio: Studio) {
    this.root = root
    this.studio = studio
    this.pads = [...root.querySelectorAll<HTMLButtonElement>('.pad')]
    this.steps = [...root.querySelectorAll<HTMLButtonElement>('.step')]
    this.spectrum = new Spectrum($<HTMLCanvasElement>(root, '#viz'), studio.engine.analyser)
    this.waveform = new Waveform($<HTMLCanvasElement>(root, '#wave'))
    this.scope = new Scope($<HTMLCanvasElement>(root, '#scope'), studio.engine.analyser)
    this.buildKnobs()
    this.bindPads()
    // Clicking a key, step or knob shouldn't park keyboard focus on it:
    // otherwise the next key press (say, "1" for a pad) makes the browser
    // draw a focus ring around whatever was clicked last. Tabbing still
    // focuses controls normally. (Preventing mousedown's default only skips
    // the focus change; the click itself still happens.)
    root.addEventListener('mousedown', (e) => {
      const target = e.target as Element
      if (target.closest('select')) return
      if (target.closest('.key, .step, .knob-dial')) e.preventDefault()
    })
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
    const add = (container: string, key: keyof Vibe, spec: Omit<KnobOptions, 'value' | 'onInput' | 'cap'>) => {
      const knob = new Knob({ ...spec, cap: 'cream', value: s.vibe[key], onInput: (v) => s.setVibe(key, v) })
      this.knobs.set(key, knob)
      $(this.root, container).append(knob.el)
    }
    const filter = (v: number) => (Math.abs(v) < 0.005 ? 'Off' : `${v < 0 ? 'LP' : 'HP'} ${Math.round(Math.abs(v) * 100)}`)
    // Deck: how the whole mix plays back.
    add('#knobs-deck', 'speed', { label: 'Speed', min: 0.5, max: 1, reset: 1, step: 0.01, format: (v) => `${v.toFixed(2)}×` })
    add('#knobs-deck', 'filter', { label: 'Filter', min: -1, max: 1, reset: 0, step: 0.01, format: filter })
    add('#knobs-deck', 'drive', { label: 'Drive', min: 0, max: 1, reset: 0, format: pct })
    // Reverb.
    add('#knobs-reverb', 'mix', { label: 'Mix', min: 0, max: 1, reset: FLAT_VIBE.mix, format: pct })
    add('#knobs-reverb', 'size', { label: 'Size', min: 0, max: 1, reset: FLAT_VIBE.size, format: pct })
    add('#knobs-reverb', 'damping', { label: 'Damp', min: 0, max: 1, reset: FLAT_VIBE.damping, format: pct })
    add('#knobs-reverb', 'preDelayMs', { label: 'Pre', min: 0, max: 200, reset: FLAT_VIBE.preDelayMs, step: 1, format: (v) => `${Math.round(v)}ms` })
    add('#knobs-tone', 'low', { label: 'Low', min: -12, max: 12, reset: 0, step: 0.5, format: db })
    add('#knobs-tone', 'mid', { label: 'Mid', min: -12, max: 12, reset: 0, step: 0.5, format: db })
    add('#knobs-tone', 'high', { label: 'High', min: -12, max: 12, reset: 0, step: 0.5, format: db })
    add('#knobs-tone', 'width', { label: 'Width', min: 0, max: 1.5, reset: 1, step: 0.01, format: pct })
    // Level isn't part of the vibe (presets leave it alone); it closes out the deck.
    this.levelKnob = new Knob({ label: 'Level', cap: 'cream', min: 0, max: 1, value: s.level, reset: DEFAULT_LEVEL, format: pct, onInput: (v) => s.setLevel(v) })
    $(this.root, '#knobs-deck').append(this.levelKnob.el)
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
      // Pad keys work everywhere except where keys mean typing (text fields,
      // and the theme dropdown's type-to-select). Knobs only use arrow keys,
      // so a focused knob doesn't block them.
      if (target.closest('input:not([type="checkbox"]), select, textarea')) return
      if (e.key === ' ' && !target.closest('button, a')) {
        e.preventDefault()
        s.togglePlay()
        return
      }
      if (e.key.toLowerCase() === 't' && !e.repeat) {
        this.tapTempo()
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
    on('#len', () => s.setStepCount(STEP_COUNTS[(STEP_COUNTS.indexOf(s.stepCount) + 1) % STEP_COUNTS.length]))
    this.root.querySelectorAll<HTMLButtonElement>('[data-bar]').forEach((b) =>
      b.addEventListener('click', () => {
        this.page = Number(b.dataset.bar)
        this.render()
      }),
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

    on('#play', () => s.play())
    this.tempoKnob = new Knob({
      label: 'Tempo',
      cap: 'cream',
      min: 60,
      max: 180,
      value: s.bpm,
      reset: 90,
      step: 1,
      format: (v) => `${Math.round(v)} BPM`,
      onInput: (v) => s.setBpm(v),
      compact: true,
      dragPixels: 360, // finer: about 3 px per BPM
    })
    $(this.root, '#tempo-knob').append(this.tempoKnob.el)
    on('#tap', () => this.tapTempo())
    on('#stop', () => s.stop())
    on('#clear', () => {
      s.clearPattern()
      this.flash('PATTERN CLEARED')
    })

    this.root.querySelectorAll<HTMLButtonElement>('[data-fx]').forEach((b) =>
      b.addEventListener('click', () => {
        s.setFxBypassed(b.dataset.fx === 'bypass')
        this.flash(s.fxBypassed ? 'FX BYPASSED' : 'FX ON')
      }),
    )
    const slowed = $<HTMLInputElement>(this.root, '#slowed-switch')
    slowed.addEventListener('change', () => {
      s.applyVibe(slowed.checked ? SLOWED_REVERB : FLAT_VIBE)
      this.flash(slowed.checked ? 'SLOWED + REVERB' : 'DRY')
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
    const seek = (e: PointerEvent) => {
      const rect = bar.getBoundingClientRect()
      s.seekSong((e.clientX - rect.left) / rect.width)
    }
    bar.addEventListener('pointerdown', (e) => {
      bar.setPointerCapture(e.pointerId)
      seek(e)
    })
    bar.addEventListener('pointermove', (e) => {
      if (bar.hasPointerCapture(e.pointerId)) seek(e)
    })
    bar.addEventListener('keydown', (e) => {
      if (!s.song) return
      const step = 5 / (s.song.frames / s.sampleRate) // 5 s per arrow press
      const now = s.engine.status().songFrame / s.song.frames
      if (e.key === 'ArrowRight') s.seekSong(now + step)
      else if (e.key === 'ArrowLeft') s.seekSong(now - step)
      else return
      e.preventDefault()
    })
    on('#song-play', () => s.togglePlay())

    on('#export', () => void this.export())
    on('#share', () => void this.share())
    on('#export-close', () => ($(this.root, '#export-result').hidden = true))
  }

  // --- Actions ----------------------------------------------------------------

  // Tap tempo: the average of the last few intervals; a 2 s pause starts over.
  private tapTempo(): void {
    const now = performance.now()
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = []
    this.taps = [...this.taps.slice(-4), now]
    const led = $(this.root, '#bpm-out')
    led.classList.remove('tap')
    void led.offsetWidth
    led.classList.add('tap')
    if (this.taps.length < 2) return
    const intervals = this.taps.slice(1).map((t, i) => t - this.taps[i])
    const average = intervals.reduce((a, b) => a + b, 0) / intervals.length
    this.studio.setBpm(60_000 / average)
  }

  private hit(i: number): void {
    this.studio.hit(i)
    this.studio.select(i)
    this.light(i, 'hit')
  }

  // Lights a pad in its row's color: 'hit' when tapped (it also presses
  // down), 'fire' when the sequencer plays it.
  private light(i: number, kind: 'hit' | 'fire'): void {
    const pad = this.pads[i]
    pad.classList.remove('hit', 'fire')
    void pad.offsetWidth // restart the animation
    pad.classList.add(kind)
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
      this.flash('EXPORT READY', 3000)
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

  flash(text: string, ms = 1800): void {
    this.message = { text, until: performance.now() + ms }
  }

  // --- Rendering ----------------------------------------------------------------

  private render(): void {
    const s = this.studio
    this.root.querySelector('.device')!.setAttribute('data-mode', s.mode)
    $(this.root, '#lcd-mode').textContent = s.mode === 'beat' ? 'BEAT' : 'SONG'
    $(this.root, '#lcd-bpm').textContent = String(s.bpm).padStart(3, '0')
    $(this.root, '#bpm-out').textContent = String(s.bpm).padStart(3, '0')
    this.tempoKnob?.set(s.bpm)
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
    this.root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.mode === s.mode)),
    )
    $(this.root, '#len').textContent = `Len ${s.stepCount}`
    // Bar tabs, each with a mini map of the selected pad's hits in that bar.
    $(this.root, '.bar-tabs').hidden = bars === 1
    this.root.querySelectorAll<HTMLButtonElement>('[data-bar]').forEach((tab) => {
      const b = Number(tab.dataset.bar)
      tab.hidden = b >= bars
      tab.setAttribute('aria-selected', String(b === this.page))
      tab.querySelectorAll('.bar-mini i').forEach((cell, j) =>
        cell.classList.toggle('on', s.pattern[s.selected][b * PAGE_STEPS + j]),
      )
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

    // The tools strip names the pad it acts on (the recording target while recording).
    const target = rec ? s.recordingPad : s.selected
    const targetName = s.pads[target]?.name ?? ''
    $(this.root, '#target-num').textContent = String(target + 1).padStart(2, '0')
    $(this.root, '#target-name').textContent = targetName
    const padLabel = `pad ${target + 1} (${targetName})`
    $(this.root, '#rec').setAttribute('aria-label', rec === 'live' ? `Stop recording ${padLabel}` : rec === 'armed' ? `Cancel recording ${padLabel}` : `Record onto ${padLabel}`)
    $(this.root, '#load').setAttribute('aria-label', `Load an audio file onto ${padLabel}`)
    $(this.root, '#reset').setAttribute('aria-label', `Reset ${padLabel} to the kit sound`)

    if (s.song) {
      $(this.root, '#song-name').textContent = s.song.name
      $(this.root, '#song-hint').textContent = `${formatTime(s.song.frames / s.sampleRate)} · tap to load another`
    }
    for (const [key, knob] of this.knobs) knob.set(s.vibe[key])
    this.levelKnob?.set(s.level)
    this.root.querySelectorAll<HTMLButtonElement>('[data-fx]').forEach((b) =>
      b.setAttribute('aria-pressed', String((b.dataset.fx === 'bypass') === s.fxBypassed)),
    )
    $<HTMLInputElement>(this.root, '#slowed-switch').checked = s.slowed
  }

  private readonly frame = () => {
    const s = this.studio
    const st = s.engine.status()

    const playing = s.mode === 'song' ? st.songPlaying : s.playing
    const play = $(this.root, '#play')
    play.classList.toggle('lit', playing)

    this.lcdSteps.forEach((dot, i) => dot.classList.toggle('now', i === st.step))
    this.steps.forEach((step, i) => step.classList.toggle('now', this.page * PAGE_STEPS + i === st.step))

    // Light the pads the sequencer just played.
    if (st.seqPlaying && st.step >= 0 && st.step !== this.litStep) {
      s.pattern.forEach((row, pad) => row[st.step] && this.light(pad, 'fire'))
    }
    this.litStep = st.seqPlaying ? st.step : -1
    this.root.querySelectorAll<HTMLElement>('[data-bar]').forEach((tab) =>
      tab.classList.toggle('playing', st.step >= 0 && Math.floor(st.step / PAGE_STEPS) === Number(tab.dataset.bar)),
    )

    // While recording, the meters show the mic input instead of the output.
    const input = s.recording?.level
    $(this.root, '#meter-l').style.setProperty('--level', String(meter(input ?? st.peakLeft)))
    $(this.root, '#meter-r').style.setProperty('--level', String(meter(input ?? st.peakRight)))
    this.root.querySelector('.device')!.classList.toggle('running', playing)

    const progress = st.songLength > 0 ? st.songFrame / st.songLength : 0
    $(this.root, '#lcd-progress').style.transform = `scaleX(${progress})`
    if (s.mode === 'song') {
      const colors = this.colors()
      this.spectrum.draw(colors.spectrum, st.songPlaying)
      this.waveform.draw(s.song?.waveform ?? null, progress, colors.wave)
      // The backdrop line rests at the device's vertical middle.
      const device = this.root.querySelector('.device')!.getBoundingClientRect()
      const middle = Math.max(80, Math.min(window.innerHeight - 80, device.top + device.height / 2))
      this.scope.draw(colors.wave.lit, st.songPlaying, middle)
    }
    $(this.root, '#song-bar').style.setProperty('--progress', String(progress))
    const songPlay = $(this.root, '#song-play')
    songPlay.classList.toggle('playing', st.songPlaying)
    songPlay.classList.toggle('lit', st.songPlaying)
    songPlay.setAttribute('aria-label', st.songPlaying ? 'Pause' : 'Play')
    $(this.root, '#song-play-label').textContent = st.songPlaying ? 'Pause' : 'Play'
    if (s.song) {
      $(this.root, '#song-now').textContent = formatTime(st.songFrame / s.sampleRate)
      $(this.root, '#song-total').textContent = formatTime(s.song.frames / s.sampleRate)
      $(this.root, '#song-bar').setAttribute('aria-valuetext', `${formatTime(st.songFrame / s.sampleRate)} of ${formatTime(s.song.frames / s.sampleRate)}`)
    }

    $(this.root, '#lcd-msg').textContent = this.lcdMessage(st.songFrame)
    $(this.root, '#lcd-status').textContent =
      s.mode === 'song'
        ? `${st.songPlaying ? '▶ PLAYING' : '■ STOPPED'}${s.fxBypassed ? '  FX BYPASS' : ''}`
        : `${playing ? '▶ PLAYING' : '■ STOPPED'}  STEP ${String(Math.max(0, st.step) + 1).padStart(2, '0')}/${s.stepCount}${s.fxBypassed ? '  FX BYPASS' : ''}`
    requestAnimationFrame(this.frame)
  }

  // Visualizer colors come from the finish's CSS tokens (the spectrum uses
  // the display's colors). Re-read twice a second so a finish switch applies.
  private colors(): { spectrum: VizColors; wave: VizColors } {
    const now = performance.now()
    if (!this.vizColors || now - this.vizColorsAt > 500) {
      const css = getComputedStyle(this.root.querySelector('.device')!)
      const v = (name: string) => css.getPropertyValue(name).trim()
      this.vizColors = {
        spectrum: { lit: v('--lcd-fg'), dim: v('--lcd-dim'), peak: '#ffffff' },
        wave: { lit: v('--accent'), dim: 'rgba(255, 255, 255, 0.16)', peak: v('--accent') },
      }
      this.vizColorsAt = now
    }
    return this.vizColors
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
