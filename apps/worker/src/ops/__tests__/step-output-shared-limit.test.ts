import { describe, expect, it, vi } from 'vitest'

/**
 * The Worker keeps answers by the shared limit itself, not an equal copy of it
 * (#2882): with the catalogue's STEP_OUTPUT_MAX_BYTES moved, what is kept moves
 * with it, so the size the canvas names is always the size applied.
 */
vi.mock('@bidspoke/service-catalogue/schema', async (original) => ({
  ...(await original<typeof import('@bidspoke/service-catalogue/schema')>()),
  STEP_OUTPUT_MAX_BYTES: 100,
}))

describe('the kept answer limit follows the shared one', () => {
  it('drops an answer over a moved limit of 100 bytes', async () => {
    const { STEP_OUTPUT_MAX_BYTES, keepOutput } = await import('../step-output')
    expect(STEP_OUTPUT_MAX_BYTES).toBe(100)
    // {"t":"..."} is 8 bytes around the text.
    expect(keepOutput({ t: 'x'.repeat(92) }).outputBytes).toBeNull()
    expect(keepOutput({ t: 'x'.repeat(93) })).toEqual({ output: null, outputBytes: 101, bytes: 101 })
  })
})
