import '@fontsource/chakra-petch/latin-500.css'
import '@fontsource/chakra-petch/latin-600.css'
import '@fontsource/space-mono/latin-400.css'
import '@fontsource/dotgothic16/latin-400.css'
import '@fontsource/geist-sans/latin-500.css'
import '@fontsource/geist-sans/latin-600.css'
import '@fontsource/geist-mono/latin-400.css'
import '@fontsource/geist-mono/latin-500.css'
import '@fontsource/doto/latin-800.css'
import './style.css'
import { applyFinish, loadFinish } from './ui/finish'
import { Studio } from './state/studio'
import { mountStartScreen, mountStudio } from './ui/view'

const root = document.querySelector<HTMLDivElement>('#app')!
applyFinish(loadFinish())

mountStartScreen(root, async () => {
  const studio = await Studio.start()
  mountStudio(root, studio)
  if (import.meta.env.DEV) Object.assign(window, { studio }) // for debugging in the console
})
