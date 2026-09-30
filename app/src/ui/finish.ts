// The device comes in two finishes (colorways), switchable on the device.
// Purely cosmetic, so the choice lives in localStorage, not the saved session.

export type Finish = 'indie' | 'putty' | 'console' | 'red'
export const FINISHES: Finish[] = ['indie', 'putty', 'console', 'red']
const KEY = 'webrack.finish'

export function loadFinish(): Finish {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved && (FINISHES as string[]).includes(saved)) return saved as Finish
  } catch {
    // Storage blocked: fall through to the default.
  }
  return 'indie'
}

export function applyFinish(finish: Finish): void {
  document.documentElement.dataset.finish = finish
  try {
    localStorage.setItem(KEY, finish)
  } catch {
    // Not persisted; fine for this visit.
  }
}
