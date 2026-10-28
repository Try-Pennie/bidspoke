import { describe, expect, it, vi } from 'vitest'

/**
 * Decision D2 of docs/design/insert-too-big-answer.html (#2882): the size the
 * Insert list names for an answer too big to keep is the ops Worker's own
 * limit, never a second copy of it. With the shared limit moved, the sentence
 * moves with it, which a number typed into the sentence could not do.
 */
vi.mock('@bidspoke/service-catalogue/schema', async (original) => ({
  ...(await original<typeof import('@bidspoke/service-catalogue/schema')>()),
  STEP_OUTPUT_MAX_BYTES: 250_000,
}))

describe('the too big to keep sentence follows the shared limit', () => {
  it('names 250 KB when the limit is 250,000 bytes', async () => {
    const { TOO_BIG_TO_KEEP_SENTENCE } = await import('../app-action-display')
    expect(TOO_BIG_TO_KEEP_SENTENCE).toBe('Its last test answered more than 250 KB, too much to keep, so it has no values.')
  })
})
