import { defineConfig } from 'vitest/config'
import { runnerTimeouts } from '../../vitest.runner-timeouts'

export default defineConfig({
  test: {
    // Wider only on a self-hosted runner, the shared Mac (#2768).
    ...runnerTimeouts,
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
