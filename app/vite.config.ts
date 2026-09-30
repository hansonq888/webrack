import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Cross-origin isolation (COOP + COEP) unlocks SharedArrayBuffer, which the
// lock-free queues between the UI and the audio thread depend on. The same
// headers are set for production in vercel.json.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  // Two pages: the app, and the engine benchmark at /bench/.
  build: {
    rollupOptions: {
      input: { main: resolve(import.meta.dirname, 'index.html'), bench: resolve(import.meta.dirname, 'bench/index.html') },
    },
  },
})
