import { defineConfig } from 'vitest/config'
import { runnerTimeouts } from '../../vitest.runner-timeouts'

/**
 * The verdict of the money gate's definition A/B mode (#2591), run in Node after
 * the two replays by .github/scripts/money-gate-swap.sh. Needs MONEY_GATE_CURRENT,
 * MONEY_GATE_CANDIDATE_TRANSCRIPT and MONEY_GATE_CANDIDATE.
 */
export default defineConfig({
  test: {
    // Wider only on a self-hosted runner, the shared Mac (#2768).
    ...runnerTimeouts,
    include: ['money-gate/swap/ab.gate.test.ts'],
    environment: 'node',
  },
})
