// The device comes in seven finishes (colorways, shown as "themes"), Red by
// default, switchable from the header.
// Purely cosmetic, so the choice lives in localStorage, not the saved session.

export type Finish = 'indie' | 'putty' | 'console' | 'red' | 'sketch' | 'noir' | 'sunset'
export const FINISHES: Finish[] = ['red', 'indie', 'putty', 'console', 'sketch', 'noir', 'sunset']
const KEY = 'webrack.finish'

export function loadFinish(): Finish {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved && (FINISHES as string[]).includes(saved)) return saved as Finish
  } catch {
    // Storage blocked: fall through to the default.
  }
  return 'red'
}

export function applyFinish(finish: Finish): void {
  document.documentElement.dataset.finish = finish
  try {
    localStorage.setItem(KEY, finish)
  } catch {
    // Not persisted; fine for this visit.
  }
}
