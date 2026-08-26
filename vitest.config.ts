import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

/**
 * Vitest config. Mirrors the `@renderer` / `@shared` path aliases used by the
 * renderer (see vite.server.config.ts and tsconfig.web.json) so tests can import
 * production modules that reference those aliases.
 *
 * Node is the default environment; component tests opt into jsdom with a
 * `@vitest-environment jsdom` docblock so the (much larger) DOM setup cost is
 * only paid by the files that need it.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
})
