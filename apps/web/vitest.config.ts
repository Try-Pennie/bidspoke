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
    // Worker threads rather than forked child processes, for BOTH projects
    // (#973). Measured over four runs each, on a settled machine:
    //
    //   forks (the default)          6.36 to 6.56s
    //   threads for the node project 5.13 to 5.32s
    //   threads for both             3.90 to 3.98s
    //
    // Identical results throughout: 167 files, 1358 tests. The saving is
    // repeatable rather than a lucky run, with an 0.08s spread on the winner.
    //
    // The jsdom project was the one to be careful about, and it is where most of
    // the saving is: the reported `environment` cost halves, 24.9s to 12.8s,
    // because a thread starts far cheaper than a process and this suite builds a
    // DOM per file. Threads for jsdom were measured rather than assumed either
    // way, which is why the node-only configuration is written down above: it
    // was tried, it was worth 1.2s, and it left the larger cost untouched.
    //
    // `isolate` stays at its default of TRUE, deliberately and permanently.
    // Turning it off is the bigger lever and it is a weakening: tests that share
    // module state start passing or failing for reasons unrelated to the code
    // under test. Threads keep a fresh module registry per file, so this is
    // faster without giving that up.
    pool: 'threads',
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
          // e2e/ holds Playwright specs (*.spec.ts, ignored here) plus the pure
          // guard logic for the teardown, which must be unit tested: it is what
          // stops a cleanup bug from deleting a production workflow.
          include: ['src/**/*.test.ts', 'e2e/**/*.test.ts'],
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
