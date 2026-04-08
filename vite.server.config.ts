import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

/**
 * Vite config for building the renderer (React frontend) for server/Docker mode.
 * Output goes to out/renderer/ where the Express server serves it as static files.
 */
export default defineConfig({
  plugins: [react()],
  root: resolve('src/renderer'),
  base: '/',
  build: {
    outDir: resolve('out/renderer'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer'),
      '@shared': resolve('src/shared'),
    },
  },
})
