export interface KnobOptions {
  label: string
  cap: 'yellow' | 'blue' | 'red' | 'green' | 'cream'
  min: number
  max: number
  value: number
  reset: number
  step?: number
  format: (v: number) => string
  onInput: (v: number) => void
  /** Hide the printed label and value (the caller shows them elsewhere). */
  compact?: boolean
  /** Full range per vertical drag, in pixels. */
  dragPixels?: number
}

const DRAG_PIXELS = 180 // full range per vertical drag
const SWEEP_DEG = 270

// A console-style rotary knob: drag up/down (or use arrow keys), double-click
// to reset. Exposed to assistive tech as a slider.
export class Knob {
  readonly el: HTMLElement
  private readonly cap: HTMLElement
  private readonly readout: HTMLElement
  private value: number
  private readonly o: KnobOptions

  constructor(o: KnobOptions) {
    this.o = o
    this.value = o.value
    this.el = document.createElement('div')
    this.el.className = o.compact ? 'knob knob-compact' : 'knob'
    this.el.innerHTML = `
      <div class="knob-dial" role="slider" tabindex="0" aria-label="${o.label}"
           aria-valuemin="${o.min}" aria-valuemax="${o.max}">
        <div class="knob-ticks"></div>
        <div class="knob-cap cap-${o.cap}"><i class="knob-pointer"></i></div>
      </div>
      <div class="knob-label">${o.label}</div>
      <div class="knob-value"></div>`
    const dial = this.el.querySelector<HTMLElement>('.knob-dial')!
    this.cap = this.el.querySelector('.knob-cap')!
    this.readout = this.el.querySelector('.knob-value')!

    let startY = 0
    let startValue = 0
    dial.addEventListener('pointerdown', (e) => {
      dial.setPointerCapture(e.pointerId)
      startY = e.clientY
      startValue = this.value
      this.el.classList.add('active')
    })
    dial.addEventListener('pointermove', (e) => {
      if (!dial.hasPointerCapture(e.pointerId)) return
      const fine = e.shiftKey ? 0.2 : 1
      const delta = ((startY - e.clientY) / (o.dragPixels ?? DRAG_PIXELS)) * (o.max - o.min) * fine
      this.input(startValue + delta)
    })
    const end = () => this.el.classList.remove('active')
    dial.addEventListener('pointerup', end)
    dial.addEventListener('pointercancel', end)
    dial.addEventListener('dblclick', () => this.input(o.reset))
    dial.addEventListener('keydown', (e) => {
      const step = (o.step ?? (o.max - o.min) / 100) * (e.shiftKey ? 10 : 1)
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') this.input(this.value + step)
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') this.input(this.value - step)
      else return
      e.preventDefault()
    })
    this.render()
  }

  set(value: number): void {
    this.value = value
    this.render()
  }

  private input(raw: number): void {
    const stepped = this.o.step ? Math.round(raw / this.o.step) * this.o.step : raw
    const v = Math.max(this.o.min, Math.min(this.o.max, stepped))
    if (v === this.value) return
    this.value = v
    this.render()
    this.o.onInput(v)
  }

  private render(): void {
    const t = (this.value - this.o.min) / (this.o.max - this.o.min)
    this.cap.style.transform = `rotate(${-SWEEP_DEG / 2 + t * SWEEP_DEG}deg)`
    const text = this.o.format(this.value)
    this.readout.textContent = text
    const dial = this.el.querySelector('.knob-dial')!
    dial.setAttribute('aria-valuenow', String(this.value))
    dial.setAttribute('aria-valuetext', text)
  }
}
