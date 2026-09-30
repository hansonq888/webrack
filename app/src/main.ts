import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/vt323/400.css'
import './style.css'
import { Studio } from './state/studio'
import { mountStartScreen, mountStudio } from './ui/view'

const root = document.querySelector<HTMLDivElement>('#app')!

mountStartScreen(root, async () => {
  const studio = await Studio.start()
  mountStudio(root, studio)
  if (import.meta.env.DEV) Object.assign(window, { studio }) // for debugging in the console
})
