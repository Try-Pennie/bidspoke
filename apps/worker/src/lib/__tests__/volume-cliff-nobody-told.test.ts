/**
 * The volume check hands the database owner the tick's scheduled Slack, so a
 * failed read with no saved copy pages Better Stack through the tick's pager
 * (#2061). The volume check reads under the client's full deadline, so in a
 * stall its report usually lands after the minute is cut off; on a database
 * that refuses fast (an error, not a stall) it is the first to report, and that
 * report must page as the probe's and the lookups' do.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runVolumeCliffCheck } from '../volume-cliff'
import { createNobodyToldPager, NOBODY_TOLD_LINE } from '../nobody-told-page'
import { registerScheduledSlack } from '../scheduled-slack'
import { fakeTimers, tableClient, TEST_KEY } from './_scheduled-slack-doubles'

const T0 = Date.parse('2026-10-15T03:00:00Z')

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }))
})
afterEach(() => vi.restoreAllMocks())

describe('the volume check reports to the owner with the tick pager (#2061)', () => {
  it('pages Better Stack once when its Slack read fails and there is no saved copy', async () => {
    const store = new Map<string, string>()
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
    }
    const sent: { message: string; reason: string }[] = []
    const handed: Promise<unknown>[] = []
    const pager = createNobodyToldPager({
      token: 'bs-token',
      url: 'https://in.example.betterstack',
      kv,
      now: () => T0,
      delay: () => new Promise(() => {}),
      fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)))
        return new Response(null, { status: 202 })
      }) as typeof fetch,
    })
    const { client } = tableClient({ service_connections: { error: { message: 'connection refused', code: '08006' } } })
    registerScheduledSlack(client, { kv, secretKeys: TEST_KEY, pager, waitUntil: (p) => handed.push(p), sleep: fakeTimers('never').sleep })

    await runVolumeCliffCheck(client, kv as unknown as KVNamespace, 'https://app.example', 'https://self.example', TEST_KEY, undefined, () => T0)
    await Promise.all(handed)

    expect(sent.map((s) => [s.message, s.reason])).toEqual([[NOBODY_TOLD_LINE, 'no_copy']])
  })
})
