import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
  // Transform JSX in any .tsx imported by a test (e.g. canvas node components).
  // Vitest 4 transforms with oxc, which otherwise honours tsconfig's
  // `jsx: preserve` and leaves raw JSX that Vite can't parse. Tests stay
  // render-free by calling components as functions, so node env is enough; the
  // app build is unaffected (Next handles JSX itself).
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
