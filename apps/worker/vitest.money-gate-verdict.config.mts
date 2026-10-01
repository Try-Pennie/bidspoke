import { defineConfig } from 'vitest/config'

/**
 * The money gate's verdict (#1704), run in Node after the two replays by
 * .github/scripts/money-gate.sh. Needs MONEY_GATE_BASE and MONEY_GATE_HEAD.
 */
export default defineConfig({
  test: {
    include: ['money-gate/verdict.gate.test.ts'],
    environment: 'node',
  },
})
