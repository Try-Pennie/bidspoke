import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isDrainStalled, runDrainStallCheck, DRAIN_STALL_THRESHOLD } from '../drain-stall'
import { alertRowsAnswer } from '../../__tests__/helpers/slack-alert-read'

describe('isDrainStalled', () => {
  it('is false below the threshold and true at/above it', () => {
    expect(isDrainStalled(DRAIN_STALL_THRESHOLD - 1)).toBe(false)
    expect(isDrainStalled(0)).toBe(false)
    expect(isDrainStalled(DRAIN_STALL_THRESHOLD)).toBe(true)
    expect(isDrainStalled(DRAIN_STALL_THRESHOLD + 1000)).toBe(true)
  })
})

// Table-aware Supabase mock: the lead_sightings count query resolves { count },
// service_connections resolves the org list (then) and the per-org slack config
// (the alert row read's limit, for getSlackConnection).
function makeSupabase(
  strandedCount: number,
  /**
   * How the count fails, reproduced from what prod returned on 2026-08-24 rather
   * than invented: this is a `head: true` count, and a HEAD response carries no
   * body, so PostgREST's error text never arrives and supabase-js builds
   * `{ message: '' }` from the empty body. Only the status says anything.
   */
  countFailure?: { status: number; statusText: string; error: unknown },
) {
  function chainFor(table: string): unknown {
    return new Proxy({}, {
      get(_t, prop) {
        if (prop === 'limit') {
          return alertRowsAnswer(async () => ({ data: { config: { bot_token: 'xoxb', default_channel: '#alerts' } }, error: null }))
        }
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve(
              table === 'lead_sightings'
                ? countFailure === undefined
                  ? { count: strandedCount, error: null }
                  : { count: null, error: countFailure.error, status: countFailure.status, statusText: countFailure.statusText }
                : { data: [{ organization_id: 'org-1' }], error: null },
            )
        }
        return () => chainFor(table)
      },
    })
  }
  return { from: (table: string) => chainFor(table) }
}

function makeKv(cooldownSet = false) {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (k: string) => (cooldownSet ? '1' : store.get(k) ?? null)),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
  } as unknown as KVNamespace & { put: ReturnType<typeof vi.fn> }
}

describe('runDrainStallCheck', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.2' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('stays quiet when the stranded backlog is below the threshold (drain is healthy)', async () => {
    const res = await runDrainStallCheck(makeSupabase(0) as never, makeKv())
    expect(res.stranded).toBe(0)
    expect(res.alerted).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('alerts and sets the cooldown when the backlog is over the threshold (drain stalled)', async () => {
    const kv = makeKv()
    const res = await runDrainStallCheck(makeSupabase(DRAIN_STALL_THRESHOLD + 4000) as never, kv)
    expect(res.stranded).toBe(DRAIN_STALL_THRESHOLD + 4000)
    expect(res.alerted).toBe(true)
    expect(fetchMock).toHaveBeenCalled()
    expect((kv as unknown as { put: ReturnType<typeof vi.fn> }).put).toHaveBeenCalledWith(
      'drain-stall:alerted', '1', expect.anything(),
    )
  })

  it('stays quiet within the cooldown even when still stalled', async () => {
    const res = await runDrainStallCheck(makeSupabase(DRAIN_STALL_THRESHOLD + 4000) as never, makeKv(true))
    expect(res.alerted).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

/**
 * The watchdog's own failure must be legible (L520, L71).
 *
 * This check throws when its count fails, which is right: a watchdog that cannot
 * measure the backlog must not report a healthy one. But it rendered the reason
 * as `error.message`, and on a HEAD failure that string is EMPTY, so the thrown
 * error read `drain-stall count query failed: ` and stopped. Same defect class as
 * #1040, in a daily alerting path.
 */
describe('a failed drain-stall count says what failed', () => {
  it('names the HTTP status when the error body is empty', async () => {
    await expect(
      runDrainStallCheck(
        makeSupabase(0, { status: 500, statusText: 'Internal Server Error', error: { message: '' } }) as never,
        makeKv(),
      ),
    ).rejects.toThrow(/500/)
  })

  it('explains the empty body rather than trailing off after the colon', async () => {
    // Asserting on the SPECIFIC failure, not merely that something threw: a test
    // that only checked for a throw would pass on the blank message too (L140).
    let message = ''
    try {
      await runDrainStallCheck(
        makeSupabase(0, { status: 500, statusText: 'Internal Server Error', error: { message: '' } }) as never,
        makeKv(),
      )
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).not.toMatch(/failed:\s*$/)
    expect(message).toMatch(/HEAD/)
    expect(message).toMatch(/statement timeout|57014/)
  })

  it('keeps a real error payload intact', async () => {
    let message = ''
    try {
      await runDrainStallCheck(
        makeSupabase(0, {
          status: 400,
          statusText: 'Bad Request',
          error: { code: '42703', message: 'column "nope" does not exist', details: null, hint: null },
        }) as never,
        makeKv(),
      )
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain('column "nope" does not exist')
    expect(message).toContain('42703')
    expect(message).not.toMatch(/HEAD/)
  })
})
