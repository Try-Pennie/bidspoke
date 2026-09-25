/**
 * Does a Tripoint sale's Salesforce Lead carry the Completed its Submission
 * carries (#1524)?
 *
 * Drives the real check against a fake SOQL counter, so it sees the queries it
 * actually builds and the alert lines it actually sends. The counts in the
 * fixtures are the ones measured in the live org on 2026-09-24 (L48): 409
 * Completed submissions created on 2026-09-23, 2 of them with a Completed Lead,
 * 21,331 mismatched since 2026-07-08.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../export-alerts', () => ({
  notifyExportFailure: vi.fn().mockResolvedValue(undefined),
  notifyExportRecovery: vi.fn().mockResolvedValue(undefined),
}))

import {
  checkTripointLeadStatus,
  leadStatusQueries,
  TRIPOINT_LEAD_STATUS_JOB,
  TRIPOINT_LEAD_STATUS_REMEDY,
  type LeadStatusDeps,
} from '../tripoint-lead-status-check'
import { notifyExportFailure } from '../export-alerts'
import type { Env } from '../../index'
import type { SupabaseClient } from '@supabase/supabase-js'

const env = { IDEMPOTENCY: undefined } as unknown as Env
const supabase = {} as SupabaseClient
// 13:00 UTC on 2026-09-24, when the daily cron runs: the day judged is the 23rd.
const NOW = () => new Date('2026-09-24T13:00:00Z')

/** A counter answering by which of the three queries it was handed. */
function counter(answers: { submissions: number | Error; leads: number | Error; backlog: number | Error }) {
  const asked: string[] = []
  const q = leadStatusQueries(new Date('2026-09-23T00:00:00Z'))
  const count: LeadStatusDeps['count'] = async (soql) => {
    asked.push(soql)
    const a = soql === q.submissions ? answers.submissions : soql === q.leads ? answers.leads : soql === q.backlog ? answers.backlog : new Error(`unexpected query: ${soql}`)
    if (a instanceof Error) throw a
    return a
  }
  return { count, asked, q }
}

function alerted(): string[] {
  return vi
    .mocked(notifyExportFailure)
    .mock.calls.filter((c) => c[1] === TRIPOINT_LEAD_STATUS_JOB)
    .flatMap((c) => c[2] as string[])
}

beforeEach(() => {
  vi.mocked(notifyExportFailure).mockClear()
})

describe('leadStatusQueries', () => {
  it('judges the whole UTC day before, keyed on when the submission was created', () => {
    const q = leadStatusQueries(new Date('2026-09-23T00:00:00Z'))
    for (const soql of [q.submissions, q.leads]) {
      expect(soql).toContain('CreatedDate >= 2026-09-23T00:00:00Z')
      expect(soql).toContain('CreatedDate < 2026-09-24T00:00:00Z')
      expect(soql).toContain("External_Partner_Name__c = 'Tripoint'")
      expect(soql).toContain("Tripoint_Response__c = 'Success'")
      expect(soql).toContain("External_Exchange_Status__c = 'Completed'")
    }
    expect(q.leads).toContain("Lead__r.External_Exchange_Status__c = 'Completed'")
    expect(q.submissions).not.toContain('Lead__r')
  })

  it('counts the backlog from the day the sync broke, not from the day judged', () => {
    const q = leadStatusQueries(new Date('2026-09-23T00:00:00Z'))
    expect(q.backlog).toContain('CreatedDate >= 2026-07-08T00:00:00Z')
    expect(q.backlog).toContain("Lead__r.External_Exchange_Status__c != 'Completed'")
    expect(q.backlog).not.toContain('CreatedDate <')
  })

  it('leaves out a Lead a later submission re-routed to another partner', () => {
    // Measured 2026-09-25 after the backfill: 1,426 of the 1,458 left had a
    // Lead now naming Engine or AmOne and pointing at a newer submission. The
    // Lead records the consumer's latest sale, so it is right not to read
    // Tripoint Completed, and counting it would keep the alert up for ever.
    const q = leadStatusQueries(new Date('2026-09-23T00:00:00Z'))
    expect(q.backlog).toContain("Lead__r.ExternalPartnerName__c = 'Tripoint'")
  })
})

describe('checkTripointLeadStatus', () => {
  it('alerts with both counts when the Lead stops carrying Completed, as measured on 2026-09-23', async () => {
    const c = counter({ submissions: 409, leads: 2, backlog: 21331 })

    const r = await checkTripointLeadStatus(env, supabase, { count: c.count, now: NOW })

    expect(r).toMatchObject({ day: '2026-09-23', submissions_completed: 409, leads_completed: 2, backlog: 21331, alerted: true })
    const lines = alerted()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('2 of 409')
    expect(lines[0]).toContain('2026-09-23')
    expect(lines[0]).toContain('21,331')
  })

  it('sends an empty list on a healthy day, which is what clears a standing alert', async () => {
    const c = counter({ submissions: 600, leads: 590, backlog: 0 })

    const r = await checkTripointLeadStatus(env, supabase, { count: c.count, now: NOW })

    expect(r.alerted).toBe(false)
    expect(vi.mocked(notifyExportFailure)).toHaveBeenCalledTimes(1)
    expect(alerted()).toEqual([])
  })

  it('stays quiet at the threshold and speaks just under it', async () => {
    const at = await checkTripointLeadStatus(env, supabase, { count: counter({ submissions: 100, leads: 90, backlog: 0 }).count, now: NOW })
    expect(at.alerted).toBe(false)
    const under = await checkTripointLeadStatus(env, supabase, { count: counter({ submissions: 100, leads: 89, backlog: 0 }).count, now: NOW })
    expect(under.alerted).toBe(true)
  })

  it('reports the backlog while it remains, even on a day the sync is healthy', async () => {
    // After the fix ships, new days recover but the July 8 onward Leads stay
    // Pending until they are backfilled. That is still a disagreement between
    // two records, and the check is how anyone learns the backfill finished.
    const r = await checkTripointLeadStatus(env, supabase, {
      count: counter({ submissions: 600, leads: 598, backlog: 20000 }).count,
      now: NOW,
    })

    expect(r.alerted).toBe(true)
    const lines = alerted()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('20,000')
    expect(lines[0]).toContain('2026-07-08')
  })

  it('says so when there was nothing to compare, rather than reading it as agreement', async () => {
    const r = await checkTripointLeadStatus(env, supabase, { count: counter({ submissions: 0, leads: 0, backlog: 0 }).count, now: NOW })

    expect(r.alerted).toBe(true)
    expect(alerted()[0]).toMatch(/no Tripoint submission created on 2026-09-23 reads Completed/)
  })

  it('does not judge a ratio on too few submissions', async () => {
    const r = await checkTripointLeadStatus(env, supabase, { count: counter({ submissions: 5, leads: 3, backlog: 0 }).count, now: NOW })

    expect(r.alerted).toBe(false)
  })

  it('refuses, naming the count, when Salesforce cannot be read', async () => {
    const r = await checkTripointLeadStatus(env, supabase, {
      count: counter({ submissions: new Error('query failed (401): INVALID_SESSION_ID'), leads: 2, backlog: 0 }).count,
      now: NOW,
    })

    expect(r.alerted).toBe(true)
    expect(r.submissions_completed).toBeNull()
    const lines = alerted()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('could not be counted')
    expect(lines[0]).toContain('INVALID_SESSION_ID')
  })

  it('still judges the day when only the backlog count fails, and says the backlog is unknown', async () => {
    const r = await checkTripointLeadStatus(env, supabase, {
      count: counter({ submissions: 600, leads: 590, backlog: new Error('timeout') }).count,
      now: NOW,
    })

    expect(r.backlog).toBeNull()
    expect(r.alerted).toBe(true)
    expect(alerted()).toEqual([expect.stringContaining('backlog')])
  })

  it('never throws, even when the alerter itself fails', async () => {
    vi.mocked(notifyExportFailure).mockRejectedValueOnce(new Error('slack down'))

    await expect(
      checkTripointLeadStatus(env, supabase, { count: counter({ submissions: 409, leads: 2, backlog: 1 }).count, now: NOW }),
    ).resolves.toMatchObject({ alerted: true })
  })

  it('tells the reader this is Salesforce and that Submission based reporting is right', () => {
    expect(TRIPOINT_LEAD_STATUS_REMEDY.consequence).toMatch(/ExternalRevenue__c/)
    expect(TRIPOINT_LEAD_STATUS_REMEDY.consequence).toMatch(/Submission__c/)
    expect(TRIPOINT_LEAD_STATUS_REMEDY.consequence).not.toMatch(/Snowflake|exported/i)
    expect(TRIPOINT_LEAD_STATUS_REMEDY.fixHint).toMatch(/tripoint-lead-status-check/)
  })
})
