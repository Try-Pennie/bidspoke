import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Worker threads rather than forked child processes (#973). Measured on this
    // suite: 4.14 to 5.45s on forks, 3.16 to 3.36s on threads, over three runs
    // each, with identical results (236 files, 3338 tests). A thread starts far
    // cheaper than a process, and this suite is 236 small files, so startup
    // dominates.
    //
    // `isolate` stays at its default of true, deliberately and permanently.
    // Turning it off is the bigger lever and it is a WEAKENING: tests sharing
    // module state start passing or failing for reasons unrelated to the code
    // under test. Threads keep a fresh module registry per file, so this is
    // faster without giving that up.
    pool: 'threads',
  },
})
