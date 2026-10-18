/**
 * #2149: the page for a live share that refuses every lead. From 2026-10-13
 * 16:09 to 2026-10-15 12:58 UTC every one of 60 Engine canary leads was
 * refused as missing_lead_field and nothing paged, because the outcome rate
 * check never sees enough attempts in an hour at 1 percent. The fixture is
 * those leads and the days either side, read from production (L48).
 */
import { describe, expect, it, vi } from 'vitest'
import type { AlertRemedy } from '../export-alerts'
import {
  LIVE_SHARE_REFUSALS_REMEDY,
  LIVE_SHARE_REFUSALS_UNREAD_REMEDY,
  LOOKBACK_MS,
  READ_WINDOW_MS,
  REFUSAL_RUN_FLOOR,
  judgeRun,
  leadFromRow,
  runLiveShareRefusals,
  subjectsFromWorkflows,
  type LiveShareDeps,
  type LiveShareLead,
  type LiveShareSubject,
} from '../live-share-refusals'
import measured from './fixtures/live-share-leads-2026-10.json'

const HOUR = 3_600_000
const fixture = measured as unknown as { leads: Array<[string, string]> }
const MEASURED: LiveShareLead[] = fixture.leads.map(([at, o]) => o === 'C'
  ? { at, contacted: true, refusals: [] }
  : { at, contacted: false, refusals: [{ partner: 'tripoint', reason: o }] })

/** The leads a run at `nowMs` could read, newest first, as far back as the lookback. */
const visibleAt = (nowMs: number) => MEASURED.filter((l) => Date.parse(l.at) < nowMs && Date.parse(l.at) >= nowMs - LOOKBACK_MS).reverse()

const refused = (at: string, reason = 'missing_lead_field', partner = 'tripoint'): LiveShareLead => ({ at, contacted: false, refusals: [{ partner, reason }] })
const sent = (at: string): LiveShareLead => ({ at, contacted: true, refusals: [] })

describe('the measured fixture', () => {
  it('holds the 60 refused leads of the fault and 88 leads after the fix, so the replay below is about the real days', () => {
    expect(MEASURED.filter((l) => l.refusals[0]?.reason === 'missing_lead_field')).toHaveLength(60)
    expect(MEASURED.filter((l) => l.at >= '2026-10-15T15:00:00Z')).toHaveLength(88)
  })
})

describe('judgeRun', () => {
  it('counts the refused leads since the newest lead sent to a buyer, and pages at the floor', () => {
    const leads = [...Array.from({ length: REFUSAL_RUN_FLOOR }, (_, i) => refused(`2026-10-14T${String(23 - i).padStart(2, '0')}:00:00Z`)), sent('2026-10-13T00:00:00Z')]
    const v = judgeRun(leads)
    expect(v).toMatchObject({ verdict: 'refusing', count: REFUSAL_RUN_FLOOR, since: '2026-10-14T04:00:00Z', lastContactAt: '2026-10-13T00:00:00Z' })
    expect(v.verdict === 'refusing' && v.reasons).toEqual([{ partner: 'tripoint', reason: 'missing_lead_field', count: REFUSAL_RUN_FLOOR }])
  })

  it('is ok one lead short of the floor', () => {
    const leads = [...Array.from({ length: REFUSAL_RUN_FLOOR - 1 }, (_, i) => refused(`2026-10-14T${String(23 - i).padStart(2, '0')}:00:00Z`)), sent('2026-10-13T00:00:00Z')]
    expect(judgeRun(leads).verdict).toBe('ok')
  })

  it('stops at a lead sent to a buyer: older refusals are a finished run', () => {
    const leads = [sent('2026-10-15T00:00:00Z'), ...Array.from({ length: 30 }, (_, i) => refused(`2026-10-14T${String(23 - i % 24).padStart(2, '0')}:00:00Z`))]
    expect(judgeRun(leads)).toMatchObject({ verdict: 'ok', count: 0 })
  })

  it('counts a lead every buyer refused for a reason somebody chose (closed hours, switched off, a cap) as neither sent nor refused', () => {
    const chosen = Array.from({ length: 40 }, (_, i) => refused(`2026-10-14T${String(23 - (i % 24)).padStart(2, '0')}:30:00Z`, i % 2 ? 'closed' : 'daily_lead_cap'))
    expect(judgeRun([...chosen, sent('2026-10-13T00:00:00Z')])).toMatchObject({ verdict: 'ok', count: 0 })
  })

  it('a lead with no buyer considered at all is refused, named by the step\'s own reason', () => {
    const none = (at: string): LiveShareLead => ({ at, contacted: false, refusals: [{ partner: null, reason: 'no_eligible_buyer' }] })
    const v = judgeRun(Array.from({ length: REFUSAL_RUN_FLOOR }, (_, i) => none(`2026-10-14T${String(23 - i).padStart(2, '0')}:00:00Z`)))
    expect(v.verdict).toBe('refusing')
  })

  it('is unmeasured, not ok, when the lookback holds fewer leads than the floor and none was sent', () => {
    expect(judgeRun([refused('2026-10-14T00:00:00Z')])).toMatchObject({ verdict: 'too_few', count: 1 })
    expect(judgeRun([])).toMatchObject({ verdict: 'too_few', count: 0 })
  })
})

// The acceptance test the issue asks for: replay every hourly run from
// 2026-10-11 to the last measured lead. It pages inside the 45 hour gap and at
// no other time.
describe('replayed hourly over the measured days', () => {
  const start = Date.parse('2026-10-11T01:00:00Z')
  const end = Date.parse('2026-10-18T18:00:00Z')
  const runs: Array<{ at: string; verdict: string }> = []
  for (let t = start; t <= end; t += HOUR) runs.push({ at: new Date(t).toISOString(), verdict: judgeRun(visibleAt(t)).verdict })
  const paged = runs.filter((r) => r.verdict === 'refusing').map((r) => r.at)

  it('would have paged at 2026-10-14 11:00 UTC, 19 hours into the gap rather than never, and every hour until a lead was sent again', () => {
    expect(paged[0]).toBe('2026-10-14T11:00:00.000Z')
    expect(paged[paged.length - 1]).toBe('2026-10-15T15:00:00.000Z')
    expect(paged).toHaveLength(29)
  })

  it('stays quiet before the fault and on every hour since, with Tripoint refusing about half of all leads for loans under 2,000', () => {
    expect(runs.filter((r) => r.at < '2026-10-14T11:00:00.000Z' && r.verdict === 'refusing')).toEqual([])
    expect(runs.filter((r) => r.at > '2026-10-15T15:00:00.000Z' && r.verdict === 'refusing')).toEqual([])
  })
})

describe('leadFromRow', () => {
  it('reads a sold or declined row as sent, and a refused one as its buyers\' reasons', () => {
    expect(leadFromRow({ started_at: 't1', sale: { skipped: false }, considered: [{ partner: 'tripoint', outcome: 'sold' }], reason: 'sold' })).toEqual({ at: 't1', contacted: true, refusals: [] })
    expect(leadFromRow({ started_at: 't2', sale: { skipped: true }, considered: [{ partner: 'tripoint', outcome: 'ineligible', reason: 'missing_lead_field' }], reason: 'no_eligible_buyer' }))
      .toEqual({ at: 't2', contacted: false, refusals: [{ partner: 'tripoint', reason: 'missing_lead_field' }] })
  })

  it('names the step\'s own reason when no buyer was considered, and refuses a row it cannot read rather than guessing', () => {
    expect(leadFromRow({ started_at: 't3', sale: { skipped: true }, considered: [], reason: 'profiles_unavailable' }))
      .toEqual({ at: 't3', contacted: false, refusals: [{ partner: null, reason: 'profiles_unavailable' }] })
    expect(leadFromRow({ started_at: 't4', sale: null, considered: null, reason: null })).toBeNull()
  })
})

describe('subjectsFromWorkflows', () => {
  it('watches each live buyer_select step of a switched on workflow, and nothing else', () => {
    const rows = [
      { id: 'wf-engine', organization_id: 'org-1', name: 'Engine Bidding Workflow', is_active: true, definition: { nodes: [
        { type: 'buyer_select', namespace: 'buyer_select', label: 'Buyer select', config: { mode: 'live', live_percent_env: 'BUYER_SELECT_ENGINE_PERCENT' } },
        { type: 'buyer_select', namespace: 'rehearsal', config: { mode: 'decide_only' } },
        { type: 'code', namespace: 'tripoint_ping', config: {} },
      ] } },
      { id: 'wf-off', organization_id: 'org-1', name: 'Off', is_active: false, definition: { nodes: [{ type: 'buyer_select', namespace: 'buyer_select', config: { mode: 'live' } }] } },
    ]
    expect(subjectsFromWorkflows(rows)).toEqual([
      { orgId: 'org-1', workflowId: 'wf-engine', workflowName: 'Engine Bidding Workflow', namespace: 'buyer_select', label: 'Buyer select', livePercentEnv: 'BUYER_SELECT_ENGINE_PERCENT' },
    ])
  })
})

describe('runLiveShareRefusals', () => {
  const subject: LiveShareSubject = { orgId: 'org-1', workflowId: 'wf-engine', workflowName: 'Engine Bidding Workflow', namespace: 'buyer_select', label: 'Buyer select', livePercentEnv: 'BUYER_SELECT_ENGINE_PERCENT' }
  const deps = (nowIso: string, over: Partial<Omit<LiveShareDeps, 'notify'>> = {}): LiveShareDeps & { notify: ReturnType<typeof vi.fn>; reads: Array<[number, number]> } => {
    const reads: Array<[number, number]> = []
    const notify = vi.fn(async (_lines: string[], _keys: string[], _remedy: AlertRemedy) => {})
    return {
      reads,
      notify,
      listSubjects: async () => [subject],
      readLeads: async (_s, fromMs, toMs) => {
        reads.push([fromMs, toMs])
        return MEASURED.filter((l) => Date.parse(l.at) >= fromMs && Date.parse(l.at) < toMs)
      },
      now: () => Date.parse(nowIso),
      localDev: false,
      appUrl: 'https://app.test',
      ...over,
    }
  }

  it('pages one line naming the workflow, the step, the run, the reason, the live share variable and where to look', async () => {
    const d = deps('2026-10-14T11:00:00Z')
    const s = await runLiveShareRefusals(d)
    expect(s.subjects).toEqual([expect.objectContaining({ workflow_id: 'wf-engine', namespace: 'buyer_select', verdict: 'refusing', count: 21 })])
    expect(d.notify).toHaveBeenCalledTimes(1)
    const [lines] = d.notify.mock.calls[0] as unknown as [string[], string[]]
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('Engine Bidding Workflow, step Buyer select')
    expect(lines[0]).toContain('none of its last 21 leads')
    expect(lines[0]).toContain('tripoint on 21, a lead field the profile needs is missing or unreadable')
    expect(lines[0]).toContain('BUYER_SELECT_ENGINE_PERCENT')
    expect(lines[0]).toContain('https://app.test/workflows/wf-engine')
    expect(lines[0]).toMatch(/EDT/)
  })

  it('stands the page down with an empty call once a lead is sent, so the alerter clears it', async () => {
    const d = deps('2026-10-16T12:00:00Z')
    const s = await runLiveShareRefusals(d)
    expect(s.subjects[0].verdict).toBe('ok')
    expect(d.notify).toHaveBeenCalledWith([], [], LIVE_SHARE_REFUSALS_REMEDY)
  })

  it('reads one window at a time and stops at the first window holding a sent lead', async () => {
    const d = deps('2026-10-16T12:00:00Z')
    await runLiveShareRefusals(d)
    expect(d.reads).toEqual([[Date.parse('2026-10-16T12:00:00Z') - READ_WINDOW_MS, Date.parse('2026-10-16T12:00:00Z')]])
  })

  it('never reads past the lookback during a fault', async () => {
    const d = deps('2026-10-15T12:00:00Z')
    await runLiveShareRefusals(d)
    expect(Math.min(...d.reads.map(([from]) => from))).toBe(Date.parse('2026-10-15T12:00:00Z') - LOOKBACK_MS)
  })

  it('a read that fails is a line of its own and an unmeasured subject, never a quiet one', async () => {
    const d = deps('2026-10-14T11:00:00Z', { readLeads: async () => { throw new Error('execution_steps: canceling statement due to statement timeout') } })
    const s = await runLiveShareRefusals(d)
    expect(s.subjects[0].verdict).toBe('unmeasured')
    const [lines, , remedy] = d.notify.mock.calls[0] as unknown as [string[], string[], AlertRemedy]
    expect(lines[0]).toContain('could not be read')
    expect(remedy).toBe(LIVE_SHARE_REFUSALS_UNREAD_REMEDY)
  })

  it('skips under local dev, which reads production', async () => {
    const d = deps('2026-10-14T11:00:00Z', { localDev: true })
    expect(await runLiveShareRefusals(d)).toMatchObject({ skipped: 'local_dev' })
    expect(d.notify).not.toHaveBeenCalled()
  })
})
