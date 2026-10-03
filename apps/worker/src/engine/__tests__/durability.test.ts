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
    const res = await writeOutcome('lead_sightings.insert', async () => ({ error: null }), deps(kv))
    expect(res.error).toBeNull()
    expect(sendOutcomeDeadLetterAlert).not.toHaveBeenCalled()
  })

  // #599: a success must NOT reset the window loss counter. A partial outage
  // interleaves successes with losses; clearing on success is exactly what let
  // the old streak counter collapse to "1 in a row".
  it('leaves the window loss counter untouched on success', async () => {
    const kv = fakeKv()
    kv.store.set('outcome-deadletter-window:org-1:lead_sightings.insert', '5')
    await writeOutcome('lead_sightings.insert', async () => ({ error: null }), deps(kv))
    expect(kv.store.get('outcome-deadletter-window:org-1:lead_sightings.insert')).toBe('5')
  })

  it('records a dead-letter alert when the write fails after retries', async () => {
    const kv = fakeKv()
    const res = await writeOutcome('lead_sightings.insert', async () => ({ error: PERMANENT }), deps(kv))
    expect(res.error).toBe(PERMANENT)
    expect(sendOutcomeDeadLetterAlert).toHaveBeenCalledTimes(1)
  })

  it('treats a duplicate (23505) as success (no dead-letter, window untouched)', async () => {
    const kv = fakeKv()
    kv.store.set('outcome-deadletter-window:org-1:lead_sightings.insert', '2')
    const dup = { code: '23505', message: 'duplicate key' }
    const res = await writeOutcome('lead_sightings.insert', async () => ({ error: dup }), deps(kv))
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
    await writeOutcome(label, async () => ({ error: null }), deps(kv))
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
    await writeOutcome('lead_sightings.insert', async () => ({ error: PERMANENT }), deps(kv))

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
