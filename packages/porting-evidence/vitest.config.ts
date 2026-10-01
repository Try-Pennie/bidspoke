import { defineConfig } from 'vitest/config'

// Pinned to a non UTC zone so a window computed through local time accessors in
// the verdict code fails here rather than passing on a UTC runner (L504).
process.env.TZ = 'America/New_York'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
