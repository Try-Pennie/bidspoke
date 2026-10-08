/**
 * #309 Phase 2 — the durability seam. Two tiers named at the call site:
 *  - writeOutcome: tier-2 must-not-lose Supabase ops (retry + dead-letter alert)
 *  - writeObservability: tier-1 best-effort (no retry, no alert)
 *  - recordOutcomeDeadLetter: shared dead-letter handler, also called directly
 *    for the tier-3 external (Salesforce) writeback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/slack', () => ({
  getSlackConnection: vi.fn(),
  sendOutcomeDeadLetterAlert: vi.fn(),
}))

import { getSlackConnection, sendOutcomeDeadLetterAlert } from '../../lib/slack'
import { writeOutcome, writeObservability, recordOutcomeDeadLetter } from '../durability'
import { PostResponseBudget, POST_RESPONSE_BUDGET_MS, DEAD_LETTER_RESERVE_MS } from '../../lib/post-response-budget'
import { DB_WRITE_RETRY_DELAYS_MS, READ_BACK_MISSING_CODE } from '../../lib/db-retry'
import { VirtualClock } from '../../lib/__tests__/_virtual-clock'
import { UNCONFIRMED_WRITE_PREFIX, type ReadBack } from '../unconfirmed-writes'

const SIGHTING: ReadBack = { kind: 'sighting_present', sighting_id: 's-1', execution_started_at_utc: '2026-10-08T12:20:10.000Z' }

const PERMANENT = { code: '23502', message: 'not-null violation' } // permanent → no retry sleeps
const supabase = {} as never

function fakeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
}

function deps(kv: ReturnType<typeof fakeKv>) {
  return { kv, supabase, orgId: 'org-1', appUrl: 'https://app.test' }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSlackConnection).mockResolvedValue({ config_alerts_enabled: true } as never)
  vi.mocked(sendOutcomeDeadLetterAlert).mockResolvedValue(true)
})

describe('writeObservability (tier 1)', () => {
  it('returns the op result without retrying on error', async () => {
    const op = vi.fn(async () => ({ error: PERMANENT }))
    const res = await writeObservability('execution_steps.insert', op)
    expect(op).toHaveBeenCalledTimes(1)
    expect(res.error).toBe(PERMANENT)
  })
})

describe('writeOutcome (tier 2)', () => {
  it('returns success without alerting', async () => {
    const kv = fakeKv()
    const res = await writeOutcome('lead_sightings.insert', async () => ({ error: null }), deps(kv), SIGHTING)
    expect(res.error).toBeNull()
    expect(sendOutcomeDeadLetterAlert).not.toHaveBeenCalled()
  })

  // #599: a success must NOT reset the window loss counter. A partial outage
  // interleaves successes with losses; clearing on success is exactly what let
  // the old streak counter collapse to "1 in a row".
  it('leaves the window loss counter untouched on success', async () => {
    const kv = fakeKv()
    kv.store.set('outcome-deadletter-window:org-1:lead_sightings.insert', '5')
    await writeOutcome('lead_sightings.insert', async () => ({ error: null }), deps(kv), SIGHTING)
    expect(kv.store.get('outcome-deadletter-window:org-1:lead_sightings.insert')).toBe('5')
  })

  it('records a dead-letter alert when the write fails after retries', async () => {
    const kv = fakeKv()
    const res = await writeOutcome('lead_sightings.insert', async () => ({ error: PERMANENT }), deps(kv), SIGHTING)
    expect(res.error).toBe(PERMANENT)
    expect(sendOutcomeDeadLetterAlert).toHaveBeenCalledTimes(1)
  })

  it('treats a duplicate (23505) as success (no dead-letter, window untouched)', async () => {
    const kv = fakeKv()
    kv.store.set('outcome-deadletter-window:org-1:lead_sightings.insert', '2')
    const dup = { code: '23505', message: 'duplicate key' }
    const res = await writeOutcome('lead_sightings.insert', async () => ({ error: dup }), deps(kv), SIGHTING)
    expect(res.error).toBe(dup)
    expect(sendOutcomeDeadLetterAlert).not.toHaveBeenCalled()
    expect(kv.store.get('outcome-deadletter-window:org-1:lead_sightings.insert')).toBe('2')
  })
})

describe('recordOutcomeDeadLetter', () => {
  it('hands the run behind the loss to the alert, so it can name and link it', async () => {
    const kv = fakeKv()
    const run = { workflow_id: 'wf-1', workflow_name: 'Engine Bidding Workflow', execution_id: 'ex-1', at: '2026-10-03T05:01:03Z' }
    await recordOutcomeDeadLetter('sf_writeback', new Error('boom'), deps(kv), run)
    expect(vi.mocked(sendOutcomeDeadLetterAlert).mock.calls[0][1]).toMatchObject({ run })
  })

  const cooldownKeyFor = (label: string) => `outcome-deadletter-cooldown:org-1:${label}`
  const lossCount = (callIndex = -1) =>
    (vi.mocked(sendOutcomeDeadLetterAlert).mock.calls.at(callIndex)![1] as unknown as { window_loss_count: number })
      .window_loss_count

  it('alerts on the first exhausted loss, then suppresses within the cooldown', async () => {
    const kv = fakeKv()
    await recordOutcomeDeadLetter('sf_writeback', new Error('boom'), deps(kv))
    await recordOutcomeDeadLetter('sf_writeback', new Error('boom'), deps(kv))
    expect(sendOutcomeDeadLetterAlert).toHaveBeenCalledTimes(1)
  })

  // The bug (#599): the alert reported a consecutive-failure streak cleared on
  // every success, so a partial outage (successes interleaved with losses) always
  // said "1 in a row" even when hundreds were lost. The windowed counter must
  // accumulate ALL losses in the window, across suppressed alerts and across
  // interleaved successes, and report that total at the next alert.
  it('reports the total losses in the window, not just consecutive ones', async () => {
    const kv = fakeKv()
    const label = 'lead_sightings.finalize'

    // 1st loss: alerts (window=1), starts the cooldown.
    await recordOutcomeDeadLetter(label, new Error('x'), deps(kv))
    // 2nd loss inside the cooldown: suppressed but counted (window=2).
    await recordOutcomeDeadLetter(label, new Error('x'), deps(kv))
    // a SUCCESS in between must NOT reset the window counter.
    await writeOutcome(label, async () => ({ error: null }), deps(kv), SIGHTING)
    // 3rd loss inside the cooldown: suppressed but counted (window=3).
    await recordOutcomeDeadLetter(label, new Error('x'), deps(kv))

    // cooldown expires...
    kv.store.delete(cooldownKeyFor(label))

    // 4th loss: alerts again, reporting the full accumulated count.
    await recordOutcomeDeadLetter(label, new Error('x'), deps(kv))

    expect(sendOutcomeDeadLetterAlert).toHaveBeenCalledTimes(2)
    expect(lossCount(0)).toBe(1)
    expect(lossCount(-1)).toBe(4)
  })

  it('does not alert when config alerts are disabled', async () => {
    vi.mocked(getSlackConnection).mockResolvedValue({ config_alerts_enabled: false } as never)
    const kv = fakeKv()
    const sent = await recordOutcomeDeadLetter('lead_sightings.finalize', new Error('x'), deps(kv))
    expect(sent).toBe(false)
    expect(sendOutcomeDeadLetterAlert).not.toHaveBeenCalled()
  })

  it('passes the label and error message to the alert', async () => {
    const kv = fakeKv()
    await recordOutcomeDeadLetter('lead_sighting_bids.insert', new Error('db down'), deps(kv))
    expect(sendOutcomeDeadLetterAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ label: 'lead_sighting_bids.insert', error_message: 'db down' }),
      'https://app.test',
    )
  })

  // A DbError is a plain object, not an Error, and it is what writeOutcome (the
  // dominant caller) actually passes. String()-ing it yielded "[object Object]",
  // which named no failure and blanked every tier-2 alert in production.
  it('renders a plain DbError cause, not [object Object]', async () => {
    const kv = fakeKv()
    const dbError = { code: 'BIDSPOKE_NO_ROW_MATCHED', message: 'lead_sightings.finalize: write matched zero rows' }
    await recordOutcomeDeadLetter('lead_sightings.finalize', dbError, deps(kv))

    const { error_message } = vi.mocked(sendOutcomeDeadLetterAlert).mock.calls[0][1]
    expect(error_message).not.toContain('[object Object]')
    expect(error_message).toContain('write matched zero rows')
    expect(error_message).toContain('BIDSPOKE_NO_ROW_MATCHED')
  })

  it('renders a DbError that reaches the alert through writeOutcome', async () => {
    const kv = fakeKv()
    await writeOutcome('lead_sightings.insert', async () => ({ error: PERMANENT }), deps(kv), SIGHTING)

    const { error_message } = vi.mocked(sendOutcomeDeadLetterAlert).mock.calls[0][1]
    expect(error_message).not.toContain('[object Object]')
    expect(error_message).toContain('not-null violation')
  })

  // #600: the alert copy is gated on the SQLSTATE / PostgREST code, so the code
  // must reach the alert payload, not just the rendered message string.
  it('threads the DbError code into the alert payload for cause-specific guidance', async () => {
    const kv = fakeKv()
    const dbError = { code: 'BIDSPOKE_NO_ROW_MATCHED', message: 'write matched zero rows' }
    await recordOutcomeDeadLetter('lead_sightings.finalize', dbError, deps(kv))

    expect(sendOutcomeDeadLetterAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ error_code: 'BIDSPOKE_NO_ROW_MATCHED' }),
      'https://app.test',
    )
  })
})

// #1850: a tier-2 write that loses its row must still be dead-lettered before
// Cloudflare cancels the request's waitUntil work, 30 seconds after the answer.
describe('writeOutcome inside the post-response budget (#1850)', () => {
  const DOWN = { code: 'PGRST002', message: 'schema cache' }

  function budgetedDeps(kv: ReturnType<typeof fakeKv>) {
    const clock = new VirtualClock()
    const budget = new PostResponseBudget(clock)
    budget.arm()
    // The moment the window counter is written is the moment the loss is recorded.
    const putAt: number[] = []
    const put = kv.put
    kv.put = vi.fn(async (k: string, v: string) => {
      putAt.push(clock.now())
      await put(k, v)
    })
    return { clock, putAt, d: { ...deps(kv), timing: { clock, budget, reserveMs: DEAD_LETTER_RESERVE_MS } } }
  }

  it('dead-letters a database down for the whole window before the deadline', async () => {
    const kv = fakeKv()
    const { clock, putAt, d } = budgetedDeps(kv)
    const op = vi.fn(async () => ({ error: DOWN }))

    const p = writeOutcome('lead_sightings.insert', op, d, SIGHTING)
    await clock.run()

    expect((await p).error).toEqual(DOWN)
    expect(clock.sleeps).toEqual(DB_WRITE_RETRY_DELAYS_MS)
    expect(putAt.length).toBeGreaterThan(0)
    expect(Math.max(...putAt)).toBeLessThanOrEqual(POST_RESPONSE_BUDGET_MS - DEAD_LETTER_RESERVE_MS)
  })

  it('lands without a dead letter when the database comes back halfway', async () => {
    const kv = fakeKv()
    const { clock, putAt, d } = budgetedDeps(kv)
    const op = vi.fn(async () => (clock.now() < 5_000 ? { error: DOWN } : { error: null }))

    const p = writeOutcome('lead_sightings.insert', op, d, SIGHTING)
    await clock.run()

    expect((await p).error).toBeNull()
    expect(putAt).toEqual([])
  })

  // #1880: a write that only TIMED OUT is not a lost write. On 2026-10-08 a 90
  // second stall dead-lettered 20 runs' records as lost and every one of them
  // had landed. It is recorded as unconfirmed, naming what to read back, and
  // the minute sweep decides later whether it was lost.
  it('records a write that never answers as unconfirmed, not as a dead letter', async () => {
    const kv = fakeKv()
    const { clock, d } = budgetedDeps(kv)
    const op = vi.fn(() => clock.hang())
    const readBack = { kind: 'sighting_finalized' as const, sighting_id: 's-1', execution_started_at_utc: '2026-10-08T12:20:10.000Z' }
    const run = { workflow_id: 'wf-1', workflow_name: 'Engine Bidding Workflow', execution_id: 'ex-1' }

    const p = writeOutcome('lead_sightings.finalize', op, { ...d, run }, readBack)
    await clock.run()

    const { error } = await p
    expect(error?.message).toContain('may still land')
    expect(sendOutcomeDeadLetterAlert).not.toHaveBeenCalled()
    expect([...kv.store.keys()].filter((k) => k.startsWith('outcome-deadletter-window:'))).toEqual([])
    const entries = [...kv.store.entries()].filter(([k]) => k.startsWith(UNCONFIRMED_WRITE_PREFIX))
    expect(entries).toHaveLength(1)
    const entry = JSON.parse(entries[0][1])
    expect(entry).toMatchObject({ label: 'lead_sightings.finalize', org_id: 'org-1', read_back: readBack, run })
    expect(typeof entry.first_seen_at).toBe('string')
  })

  it('still dead-letters a write that came back with an error, at once', async () => {
    const kv = fakeKv()
    const { clock, d } = budgetedDeps(kv)
    const op = vi.fn(async () => ({ error: PERMANENT }))
    const p = writeOutcome('lead_sightings.insert', op, d, SIGHTING)
    await clock.run()
    expect((await p).error).toBe(PERMANENT)
    expect(sendOutcomeDeadLetterAlert).toHaveBeenCalledTimes(1)
    expect([...kv.store.keys()].some((k) => k.startsWith(UNCONFIRMED_WRITE_PREFIX))).toBe(false)
  })

  it('falls back to the dead letter when the unconfirmed entry itself cannot be written', async () => {
    const kv = fakeKv()
    const { clock, d } = budgetedDeps(kv)
    const put = kv.put
    kv.put = vi.fn(async (k: string, v: string) => {
      if (k.startsWith(UNCONFIRMED_WRITE_PREFIX)) throw new Error('kv down')
      await put(k, v)
    })
    const p = writeOutcome('lead_sightings.finalize', () => clock.hang(), d, SIGHTING)
    await clock.run()
    await p
    expect(sendOutcomeDeadLetterAlert).toHaveBeenCalledTimes(1)
  })
})

// #1881: the cooldown lived in KV, which is eventually consistent across
// isolates, so the dead letters of one burst all read no cooldown and each
// posted (Dan saw counts 11, 12, 13 inside a minute on 2026-10-08). The atomic
// AlertClaim decides who posts instead.
describe('the dead letter cooldown on the alert claim (#1881)', () => {
  function claimsDouble() {
    const held = new Set<string>()
    const keys: string[] = []
    const released: string[] = []
    return {
      keys,
      released,
      async claim(key: string) {
        keys.push(key)
        if (held.has(key)) return false
        held.add(key)
        return true
      },
      async release(key: string) {
        released.push(key)
        held.delete(key)
      },
    }
  }

  it('a burst of concurrent dead letters for one label sends exactly one alert', async () => {
    const kv = fakeKv()
    const claims = claimsDouble()
    await Promise.all(
      Array.from({ length: 6 }, () => recordOutcomeDeadLetter('execution_finalize', PERMANENT, { ...deps(kv), claims })),
    )
    expect(sendOutcomeDeadLetterAlert).toHaveBeenCalledTimes(1)
  })

  it('without the claim the same burst posts more than once, which is the defect', async () => {
    const kv = fakeKv()
    await Promise.all(
      Array.from({ length: 6 }, () => recordOutcomeDeadLetter('execution_finalize', PERMANENT, deps(kv))),
    )
    expect(vi.mocked(sendOutcomeDeadLetterAlert).mock.calls.length).toBeGreaterThan(1)
  })

  it('frees the claim when the alert did not deliver, so the next loss can post', async () => {
    const kv = fakeKv()
    const claims = claimsDouble()
    vi.mocked(sendOutcomeDeadLetterAlert).mockResolvedValueOnce(false)
    await recordOutcomeDeadLetter('lead_sightings.insert', PERMANENT, { ...deps(kv), claims })
    await recordOutcomeDeadLetter('lead_sightings.insert', PERMANENT, { ...deps(kv), claims })
    expect(sendOutcomeDeadLetterAlert).toHaveBeenCalledTimes(2)
    expect(claims.released).toHaveLength(1)
  })

  it('keys the claim on the cause, so a returned error still alerts beside a read back loss of the same label', async () => {
    const kv = fakeKv()
    const claims = claimsDouble()
    await recordOutcomeDeadLetter('lead_sightings.insert', { code: READ_BACK_MISSING_CODE, message: 'read back missing' }, { ...deps(kv), claims })
    await recordOutcomeDeadLetter('lead_sightings.insert', PERMANENT, { ...deps(kv), claims })
    await recordOutcomeDeadLetter('lead_sightings.insert', PERMANENT, { ...deps(kv), claims })
    expect(sendOutcomeDeadLetterAlert).toHaveBeenCalledTimes(2)
    expect(new Set(claims.keys).size).toBe(2)
  })

  it('still counts every loss into the window while the claim suppresses the alert', async () => {
    const kv = fakeKv()
    const claims = claimsDouble()
    for (let i = 0; i < 3; i++) await recordOutcomeDeadLetter('lead_sightings.finalize', PERMANENT, { ...deps(kv), claims })
    expect(kv.store.get('outcome-deadletter-window:org-1:lead_sightings.finalize')).toBe('3')
  })
})
