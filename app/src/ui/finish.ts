// The device comes in two finishes (colorways), switchable on the device.
// Purely cosmetic, so the choice lives in localStorage, not the saved session.

export type Finish = 'console' | 'putty'
export const FINISHES: Finish[] = ['console', 'putty']
const KEY = 'webrack.finish'

export function loadFinish(): Finish {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'console' || saved === 'putty') return saved
  } catch {
    // Storage blocked: fall through to the default.
  }
  return 'console'
}

export function applyFinish(finish: Finish): void {
  document.documentElement.dataset.finish = finish
  try {
    localStorage.setItem(KEY, finish)
  } catch {
    // Not persisted; fine for this visit.
  }
}
