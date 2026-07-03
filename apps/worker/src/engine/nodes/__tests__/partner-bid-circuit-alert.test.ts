/**
 * Circuit-breaker trip alerting (audit finding 1.2): when a partner's breaker
 * trips on a real outage, ops must get a Slack page. Previously `sendCircuitAlert`
 * had zero callers and `recordBreakerOutcome` discarded the `tripped` flag, so a
 * partner could be excluded from all bidding for hours with no signal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/slack', () => ({ sendCircuitAlert: vi.fn() }))

import { recordBreakerOutcome, alertIfTripped } from '../partner-bid'
import { sendCircuitAlert } from '../../../lib/slack'
import type { ExecutionContext } from '../../../types'

const ctx = { trigger: { trace_id: 't', workflow_id: 'wf', org_id: 'org-1' } } as unknown as ExecutionContext
const supabase = {} as never

describe('recordBreakerOutcome — returns the call result', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the value the breaker call resolves to (so the tripped flag survives)', async () => {
    const outcome = await recordBreakerOutcome(ctx, 'sofi', 'error', async () => ({ ok: true, state: 'open', tripped: true }))
    expect(outcome).toEqual({ ok: true, state: 'open', tripped: true })
  })

  it('returns undefined when every attempt throws (record dropped, not surfaced as tripped)', async () => {
    const outcome = await recordBreakerOutcome(ctx, 'sofi', 'error', async () => { throw new Error('DO down') })
    expect(outcome).toBeUndefined()
  })
})

describe('alertIfTripped', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(sendCircuitAlert).mockResolvedValue(undefined)
  })

  it('fires a circuit alert when the outcome tripped', async () => {
    const alerted = await alertIfTripped(supabase, 'org-1', 'sofi', { ok: true, state: 'open', tripped: true })
    expect(alerted).toBe(true)
    expect(vi.mocked(sendCircuitAlert)).toHaveBeenCalledTimes(1)
    const [, orgId, channel, payload] = vi.mocked(sendCircuitAlert).mock.calls[0]
    expect(orgId).toBe('org-1')
    expect(channel).toBeNull()
    expect(payload).toMatchObject({ service_name: 'sofi', state: 'opened' })
  })

  it('does nothing when the outcome did not trip', async () => {
    const alerted = await alertIfTripped(supabase, 'org-1', 'sofi', { ok: true, state: 'closed', tripped: false })
    expect(alerted).toBe(false)
    expect(vi.mocked(sendCircuitAlert)).not.toHaveBeenCalled()
  })

  it('does nothing when the breaker record was dropped (undefined outcome)', async () => {
    const alerted = await alertIfTripped(supabase, 'org-1', 'sofi', undefined)
    expect(alerted).toBe(false)
    expect(vi.mocked(sendCircuitAlert)).not.toHaveBeenCalled()
  })

  it('never throws if the alert delivery fails (off the critical path)', async () => {
    vi.mocked(sendCircuitAlert).mockRejectedValueOnce(new Error('slack down'))
    const alerted = await alertIfTripped(supabase, 'org-1', 'sofi', { ok: true, state: 'open', tripped: true })
    expect(alerted).toBe(true)
  })

  it('does not page Slack when running under local wrangler dev, even on a real trip (shares the real org Slack connection)', async () => {
    const alerted = await alertIfTripped(supabase, 'org-1', 'sofi', { ok: true, state: 'open', tripped: true }, true)
    expect(alerted).toBe(false)
    expect(vi.mocked(sendCircuitAlert)).not.toHaveBeenCalled()
  })
})
