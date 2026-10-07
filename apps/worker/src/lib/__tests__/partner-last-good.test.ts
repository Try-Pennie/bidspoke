import { describe, it, expect, vi } from 'vitest'
import { forgetPartnerLastGoodMemory, rememberPartnerLastGood } from '../partner-last-good'

/**
 * The outage drill (#1305) resets storage between runs, but this isolate's record
 * of the stamps it wrote survives that, so without forgetting it a warm run skips
 * the copy a previous fixture wrote and reset() removed.
 */
describe('forgetPartnerLastGoodMemory', () => {
  it('lets the next read write the copy again for a stamp already written', async () => {
    const kv = { put: vi.fn().mockResolvedValue(undefined) } as unknown as KVNamespace
    const row = { id: 'p-forget', updated_at: '2026-10-07T10:00:00+00:00' }
    // One instant for all three writes, so only the forgetting can allow the third.
    const NOW = Date.parse('2026-10-07T10:01:00Z')
    await rememberPartnerLastGood(kv, row, NOW)
    await rememberPartnerLastGood(kv, row, NOW)
    expect(kv.put).toHaveBeenCalledTimes(1)
    forgetPartnerLastGoodMemory()
    await rememberPartnerLastGood(kv, row, NOW)
    expect(kv.put).toHaveBeenCalledTimes(2)
  })
})
