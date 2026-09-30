// The Settings button in the header and its dropdown menu: theme, pad key
// letters, resetting the kit and pattern, and a line of audio info. On the
// start screen (no studio yet) the menu shows only the themes.

import type { Studio } from '../state/studio'
import { FINISHES, applyFinish, type Finish } from './finish'

const KEYS_PREF = 'webrack.keyLetters'

const SWATCHES: Record<Finish, string> = {
  red: 'linear-gradient(135deg, #c1312a, #861b16)',
  indie: 'linear-gradient(135deg, #ededea, #c6c6c1)',
  putty: 'linear-gradient(135deg, #e7e2d8, #c3bcaf)',
  console: 'linear-gradient(135deg, #2a2c29, #151714)',
  sketch: 'linear-gradient(135deg, #f2c230 50%, #efebdd 50%)',
  noir: 'radial-gradient(circle at 50% 50%, #fff 0 22%, #000 26%)',
  sunset: 'linear-gradient(135deg, #ff3fa4, #ff7a59 55%, #c8ff3d)',
}

/** Applies saved preferences that affect the whole page (before first render). */
export function applySavedPrefs(): void {
  let keys = 'on'
  try {
    keys = localStorage.getItem(KEYS_PREF) ?? 'on'
  } catch {
    // Storage blocked: default.
  }
  document.documentElement.dataset.keyLetters = keys
}

export function settingsControl(inStudio: boolean): string {
  return `
    <div class="settings-wrap">
      <button class="key key-small key-icon" id="settings" aria-label="Settings" aria-haspopup="menu" aria-expanded="false" aria-controls="settings-pop">
        <svg class="gear" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="7.6" fill="none" stroke="currentColor" stroke-width="4" stroke-dasharray="3.4 2.57" />
          <circle cx="12" cy="12" r="6.2" fill="currentColor" />
          <circle cx="12" cy="12" r="2.4" class="gear-hole" />
        </svg>
      </button>
      <div class="menu settings-pop" id="settings-pop" role="menu" aria-label="Settings" hidden>
        <div class="menu-label">Theme</div>
        ${FINISHES.map((f) => `
          <button class="menu-item" role="menuitemradio" data-swatch="${f}">
            <i class="chip" style="background:${SWATCHES[f]}"></i><span>${f}</span><b class="check" aria-hidden="true">✓</b>
          </button>`).join('')}
        ${inStudio ? `
        <hr />
        <button class="menu-item" role="menuitemcheckbox" id="set-keys">
          <i class="chip chip-empty"></i><span>Show key letters on pads</span><b class="check" aria-hidden="true">✓</b>
        </button>
        <hr />
        <button class="menu-item menu-danger" role="menuitem" id="set-reset">
          <i class="chip chip-empty"></i><span>Reset kit &amp; pattern…</span>
        </button>
        <div class="menu-foot" id="set-audio"></div>` : ''}
      </div>
    </div>`
}

export function bindSettings(root: HTMLElement, studio: Studio | null, flash: (msg: string) => void = () => {}): void {
  const button = root.querySelector<HTMLButtonElement>('#settings')!
  const pop = root.querySelector<HTMLElement>('#settings-pop')!
  const reset = root.querySelector<HTMLButtonElement>('#set-reset')
  let confirmTimer: ReturnType<typeof setTimeout> | undefined

  const setOpen = (open: boolean) => {
    pop.hidden = !open
    button.setAttribute('aria-expanded', String(open))
    if (open) refresh()
    else if (reset) {
      clearTimeout(confirmTimer)
      reset.querySelector('span')!.textContent = 'Reset kit & pattern…'
      delete reset.dataset.armed
    }
  }

  const refresh = () => {
    const current = document.documentElement.dataset.finish
    pop.querySelectorAll<HTMLButtonElement>('[data-swatch]').forEach((b) =>
      b.setAttribute('aria-checked', String(b.dataset.swatch === current)),
    )
    pop.querySelector('.menu-foot')?.toggleAttribute('hidden', !studio)
    root.querySelector('#set-keys')?.setAttribute('aria-checked', String(document.documentElement.dataset.keyLetters !== 'off'))
    const audio = root.querySelector<HTMLElement>('#set-audio')
    if (audio && studio) {
      const c = studio.context
      const latency = ((c.baseLatency ?? 0) + (c.outputLatency ?? 0)) * 1000
      audio.textContent = `${(c.sampleRate / 1000).toFixed(1)} kHz · ${latency.toFixed(0)} ms output · C++/WASM engine`
    }
  }

  button.addEventListener('click', () => setOpen(!!pop.hidden))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) setOpen(false)
  })
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !(e.target as Element).closest('.settings-wrap')) setOpen(false)
  })

  pop.querySelectorAll<HTMLButtonElement>('[data-swatch]').forEach((b) =>
    b.addEventListener('click', () => {
      applyFinish(b.dataset.swatch as Finish)
      refresh()
    }),
  )

  root.querySelector('#set-keys')?.addEventListener('click', () => {
    const on = document.documentElement.dataset.keyLetters === 'off'
    document.documentElement.dataset.keyLetters = on ? 'on' : 'off'
    refresh()
    try {
      localStorage.setItem(KEYS_PREF, on ? 'on' : 'off')
    } catch {
      // Not persisted; fine for this visit.
    }
  })

  // Reset asks for a second tap within 3 s.
  reset?.addEventListener('click', async () => {
    if (!studio) return
    if (!reset.dataset.armed) {
      reset.dataset.armed = 'true'
      reset.querySelector('span')!.textContent = 'Click again to reset'
      confirmTimer = setTimeout(() => {
        reset.querySelector('span')!.textContent = 'Reset kit & pattern…'
        delete reset.dataset.armed
      }, 3000)
      return
    }
    clearTimeout(confirmTimer)
    await studio.resetAll()
    setOpen(false)
    flash('KIT & PATTERN RESET')
  })
}
