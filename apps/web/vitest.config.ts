import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  // Transform JSX in any .tsx imported by a test. Vitest 4 transforms with oxc,
  // which otherwise honours tsconfig's `jsx: preserve` and leaves raw JSX that
  // Vite can't parse. The app build is unaffected (Next handles JSX itself).
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // Two projects so the fast pure-logic suite keeps running in node while
    // component tests get a real DOM (issue #157). Both inherit the oxc/resolve
    // config above via `extends: true`.
    projects: [
      {
        extends: true,
        test: {
          name: 'lib',
          // Pure-logic tests (src/lib + render-free component helpers called as
          // plain functions). Stay in node for speed.
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'components',
          // Real component render tests: jsdom + React Testing Library.
          include: ['src/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./vitest.setup.ts'],
        },
      },
    ],
  },
})
