import { defineConfig } from 'vitest/config'

/**
 * The verdict of the money gate's definition A/B mode (#2591), run in Node after
 * the two replays by .github/scripts/money-gate-swap.sh. Needs MONEY_GATE_CURRENT,
 * MONEY_GATE_CANDIDATE_TRANSCRIPT and MONEY_GATE_CANDIDATE.
 */
export default defineConfig({
  test: {
    include: ['money-gate/swap/ab.gate.test.ts'],
    environment: 'node',
  },
})
