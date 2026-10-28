import { describe, expect, it } from 'vitest'
import { STEP_OUTPUT_MAX_BYTES as SHARED_LIMIT } from '@bidspoke/service-catalogue/schema'
import { STEP_OUTPUT_MAX_BYTES, byteLength, keepOutput } from '../step-output'

/**
 * The size ops keeps a step's answer to is the one shared limit (#2882): the
 * catalogue's schema entry holds it, so the canvas names the same number this
 * Worker applies, never a copy typed twice (docs/design/insert-too-big-answer.html, D2).
 */
describe('the kept answer limit', () => {
  it('is the shared limit, still 160,000 bytes', () => {
    expect(STEP_OUTPUT_MAX_BYTES).toBe(SHARED_LIMIT)
    expect(SHARED_LIMIT).toBe(160_000)
  })

  it('keeps an answer of exactly the limit and drops one a byte over it, naming its size', () => {
    // {"t":"..."} is 8 bytes around the text.
    const atLimit = { t: 'x'.repeat(SHARED_LIMIT - 8) }
    expect(byteLength(atLimit)).toBe(SHARED_LIMIT)
    expect(keepOutput(atLimit)).toEqual({ output: atLimit, outputBytes: null, bytes: SHARED_LIMIT })
    const over = { t: 'x'.repeat(SHARED_LIMIT - 7) }
    expect(keepOutput(over)).toEqual({ output: null, outputBytes: SHARED_LIMIT + 1, bytes: SHARED_LIMIT + 1 })
  })
})
