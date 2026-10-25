import { defineConfig } from 'vitest/config'
import { runnerTimeouts } from '../../vitest.runner-timeouts'

// Pinned to a non UTC zone so a window computed through local time accessors in
// the verdict code fails here rather than passing on a UTC runner (L504).
process.env.TZ = 'America/New_York'

export default defineConfig({
  test: {
    // Wider only on a self-hosted runner, the shared Mac (#2768).
    ...runnerTimeouts,
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
