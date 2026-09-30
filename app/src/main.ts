import '@fontsource/dotgothic16/latin-400.css'
import '@fontsource/geist-sans/latin-500.css'
import '@fontsource/geist-sans/latin-600.css'
import '@fontsource/geist-mono/latin-400.css'
import '@fontsource/geist-mono/latin-500.css'
import '@fontsource/doto/latin-800.css'
import '@fontsource/geist-sans/latin-800.css'
import '@fontsource/doto/latin-900.css'
import '@fontsource/unbounded/latin-500.css'
import './style.css'
import { applyFinish, loadFinish } from './ui/finish'
import { applySavedPrefs } from './ui/settings'
import { Studio } from './state/studio'
import { mountStartScreen, mountStudio } from './ui/view'

const root = document.querySelector<HTMLDivElement>('#app')!
applyFinish(loadFinish())
applySavedPrefs()

mountStartScreen(root, async (mode) => {
  const studio = await Studio.start()
  studio.setMode(mode)
  mountStudio(root, studio)
  // Song: open the file picker right away. (Browsers may block this if
  // starting took too long after the tap; the song screen is a picker too.)
  if (mode === 'song') root.querySelector<HTMLInputElement>('#song-input')?.click()
  if (import.meta.env.DEV) Object.assign(window, { studio }) // for debugging in the console
})
