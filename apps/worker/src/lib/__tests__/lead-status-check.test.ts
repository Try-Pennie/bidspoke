/**
 * Does each sale's Salesforce Lead carry the Completed its Submission carries,
 * per partner (#1524, widened for #1525)?
 *
 * Drives the real check against a fake SOQL counter, so it sees the queries it
 * actually builds and the alert lines it actually sends. Counts are the ones
 * measured in the live org on 2026-09-25 (L48): same-partner shares in the week
 * before the 2026-07-08 break were Tripoint 10,940 of 10,942, AmOne 226 of 233
 * and Engine 1,132 of 5,161; for sales created 2026-09-24 they were Tripoint
 * 1,033 of 1,035, AmOne 0 of 63 and Engine 1 of 696.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../export-alerts', () => ({
  notifyExportFailure: vi.fn().mockResolvedValue(undefined),
  notifyExportRecovery: vi.fn().mockResolvedValue(undefined),
}))

import {
  checkLeadStatus,
  leadStatusQueries,
  LEAD_STATUS_JOB,
  LEAD_STATUS_REMEDY,
  LEAD_STATUS_PARTNERS,
  type LeadStatusDeps,
} from '../lead-status-check'
import { notifyExportFailure } from '../export-alerts'
import type { Env } from '../../index'
import type { SupabaseClient } from '@supabase/supabase-js'

const env = { IDEMPOTENCY: undefined } as unknown as Env
const supabase = {} as SupabaseClient
// 13:00 UTC on 2026-09-25, when the daily cron runs: the day judged is the 24th.
const NOW = () => new Date('2026-09-25T13:00:00Z')
const DAY = new Date('2026-09-24T00:00:00Z')

type Answer = number | Error
/**
 * The backlog is read as rows, so a sale whose Lead has moved on to a later
 * Submission (a returning customer) can be told from one the sync left behind.
 * A number is that many left behind; `returning` adds rows whose Lead names a
 * later Submission.
 */
type BacklogAnswer = number | Error | { own: number; returning: number }
type PartnerAnswers = { submissions: Answer; leads: Answer; backlog: BacklogAnswer }

const HEALTHY: PartnerAnswers = { submissions: 600, leads: 598, backlog: 0 }

/** Salesforce sold only to partners the check covers: the seam set explicitly, never left to the real reader (L284). */
const ONLY_CHECKED: LeadStatusDeps['listPartners'] = async () =>
  LEAD_STATUS_PARTNERS.map((p) => ({ partner: p.partner, n: 1 }))

/** Rows for a backlog: `own` whose Lead names this sale, `returning` whose Lead names a later one. */
function backlogRows(partner: string, own: number, returning: number): Array<Record<string, unknown>> {
  const id = (k: string, i: number) => `a04${partner.slice(0, 3)}${k}${String(i).padStart(9, '0')}AAA`.slice(0, 18)
  return [
    ...Array.from({ length: own }, (_, i) => ({ Id: id('O', i), Lead__r: { Submission_Object_ID__c: id('O', i) } })),
    ...Array.from({ length: returning }, (_, i) => ({ Id: id('R', i), Lead__r: { Submission_Object_ID__c: id('L', i) } })),
  ]
}

/** A counter and a row reader answering by partner and by which of that partner's three queries it was handed. */
function counter(answers: Record<string, PartnerAnswers>) {
  const asked: string[] = []
  const count: LeadStatusDeps['count'] = async (soql) => {
    asked.push(soql)
    for (const { partner } of LEAD_STATUS_PARTNERS) {
      const q = leadStatusQueries(partner, DAY)
      const a = answers[partner] ?? HEALTHY
      const hit = soql === q.submissions ? a.submissions : soql === q.leads ? a.leads : undefined
      if (hit === undefined) continue
      if (hit instanceof Error) throw hit
      return hit
    }
    throw new Error(`unexpected count query: ${soql}`)
  }
  const rows: LeadStatusDeps['rows'] = async (soql) => {
    asked.push(soql)
    for (const { partner } of LEAD_STATUS_PARTNERS) {
      if (soql !== leadStatusQueries(partner, DAY).backlog) continue
      const b = (answers[partner] ?? HEALTHY).backlog
      if (b instanceof Error) throw b
      return typeof b === 'number' ? backlogRows(partner, b, 0) : backlogRows(partner, b.own, b.returning)
    }
    throw new Error(`unexpected row query: ${soql}`)
  }
  return { count, rows, asked }
}

/** The deps for one run: both Salesforce seams set from the same answers, never left to the real reader (L284). */
function deps(answers: Record<string, PartnerAnswers>, extra: Partial<LeadStatusDeps> = {}): LeadStatusDeps {
  const c = counter(answers)
  return { listPartners: ONLY_CHECKED, count: c.count, rows: c.rows, now: NOW, ...extra }
}

function alerted(): string[] {
  return vi
    .mocked(notifyExportFailure)
    .mock.calls.filter((c) => c[1] === LEAD_STATUS_JOB)
    .flatMap((c) => c[2] as string[])
}

beforeEach(() => {
  vi.mocked(notifyExportFailure).mockClear()
})

describe('leadStatusQueries', () => {
  it('judges the whole UTC day before, on sales whose Lead names the same partner', () => {
    const q = leadStatusQueries('AmOne', DAY)
    for (const soql of [q.submissions, q.leads]) {
      expect(soql).toContain('CreatedDate >= 2026-09-24T00:00:00Z')
      expect(soql).toContain('CreatedDate < 2026-09-25T00:00:00Z')
      expect(soql).toContain("External_Partner_Name__c = 'AmOne'")
      expect(soql).toContain("External_Exchange_Status__c = 'Completed'")
      // A consumer re-sold to another partner has a Lead naming that partner;
      // their newer sale is judged under that partner, not this one.
      expect(soql).toContain("Lead__r.ExternalPartnerName__c = 'AmOne'")
    }
    expect(q.leads).toContain("Lead__r.External_Exchange_Status__c = 'Completed'")
    expect(q.submissions).not.toContain("Lead__r.External_Exchange_Status__c")
  })

  it('counts the backlog from the day the sync broke, on the same partner', () => {
    const q = leadStatusQueries('Tripoint', DAY)
    expect(q.backlog).toContain('CreatedDate >= 2026-07-08T00:00:00Z')
    expect(q.backlog).toContain("Lead__r.ExternalPartnerName__c = 'Tripoint'")
    expect(q.backlog).toContain("Lead__r.External_Exchange_Status__c != 'Completed'")
    expect(q.backlog).not.toContain('CreatedDate <')
  })

  it('covers every partner a Lead can be sold to, and judges only those with a healthy share on record', () => {
    expect(LEAD_STATUS_PARTNERS.map((p) => p.partner).sort()).toEqual(['AmOne', 'Engine', 'Tripoint'])
    expect(LEAD_STATUS_PARTNERS.filter((p) => p.judged).map((p) => p.partner).sort()).toEqual(['AmOne', 'Tripoint'])
  })
})

describe('checkLeadStatus', () => {
  it('names the partner whose Leads stopped carrying Completed, with both counts, as measured on 2026-09-24', async () => {
    const r = await checkLeadStatus(env, supabase, deps({
        Tripoint: { submissions: 1035, leads: 1033, backlog: 0 },
        AmOne: { submissions: 63, leads: 0, backlog: 4259 },
        Engine: { submissions: 696, leads: 1, backlog: 73000 },
      }))

    expect(r.day).toBe('2026-09-24')
    expect(r.alerted).toBe(true)
    const lines = alerted()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^AmOne: 0 of 63/)
    expect(lines[0]).toContain('4,259')
    expect(r.partners.find((p) => p.partner === 'Engine')).toMatchObject({ submissions_completed: 696, leads_completed: 1, backlog: 73000 })
  })

  it('reports Engine without alerting on it, since it has no healthy share to judge against', async () => {
    const r = await checkLeadStatus(env, supabase, deps({ Engine: { submissions: 696, leads: 1, backlog: 73000 } }))

    expect(r.alerted).toBe(false)
    expect(alerted()).toEqual([])
    expect(r.partners.find((p) => p.partner === 'Engine')?.judged).toBe(false)
  })

  it('still refuses by name when an unjudged partner cannot be counted', async () => {
    const r = await checkLeadStatus(env, supabase, deps({ Engine: { submissions: new Error('query failed (500)'), leads: 1, backlog: 0 } }))

    expect(r.alerted).toBe(true)
    expect(alerted()).toEqual([expect.stringMatching(/^Engine: .*could not be counted.*500/)])
  })

  it('sends an empty list when every judged partner is healthy, which is what clears a standing alert', async () => {
    const r = await checkLeadStatus(env, supabase, deps({}))

    expect(r.alerted).toBe(false)
    expect(vi.mocked(notifyExportFailure)).toHaveBeenCalledTimes(1)
    expect(alerted()).toEqual([])
  })

  it('stays quiet at the threshold and speaks just under it', async () => {
    const at = await checkLeadStatus(env, supabase, deps({ Tripoint: { submissions: 100, leads: 90, backlog: 0 } }))
    expect(at.alerted).toBe(false)
    const under = await checkLeadStatus(env, supabase, deps({ Tripoint: { submissions: 100, leads: 89, backlog: 0 } }))
    expect(under.alerted).toBe(true)
  })

  it('reports the backlog while it remains, even on a day the sync is healthy', async () => {
    const r = await checkLeadStatus(env, supabase, deps({ Tripoint: { submissions: 1035, leads: 1033, backlog: 32 } }))

    expect(r.alerted).toBe(true)
    expect(alerted()).toEqual([expect.stringMatching(/^Tripoint: 32 Completed sales since 2026-07-08/)])
  })

  it('says so when a judged partner had nothing to compare, rather than reading it as agreement', async () => {
    const r = await checkLeadStatus(env, supabase, deps({ AmOne: { submissions: 0, leads: 0, backlog: 0 } }))

    expect(r.alerted).toBe(true)
    expect(alerted()[0]).toMatch(/^AmOne: no .*created on 2026-09-24 reads Completed/)
  })

  it('does not judge a share on too few sales', async () => {
    const r = await checkLeadStatus(env, supabase, deps({ AmOne: { submissions: 5, leads: 3, backlog: 0 } }))

    expect(r.alerted).toBe(false)
  })

  it('refuses, naming the partner and the count, when Salesforce cannot be read', async () => {
    const r = await checkLeadStatus(env, supabase, deps({ Tripoint: { submissions: new Error('query failed (401): INVALID_SESSION_ID'), leads: 2, backlog: 0 } }))

    expect(r.alerted).toBe(true)
    expect(r.partners.find((p) => p.partner === 'Tripoint')?.submissions_completed).toBeNull()
    const lines = alerted()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^Tripoint: .*could not be counted.*INVALID_SESSION_ID/)
  })

  it('still judges the day when only the backlog count fails, and says the backlog is unknown', async () => {
    const r = await checkLeadStatus(env, supabase, deps({ AmOne: { submissions: 600, leads: 590, backlog: new Error('timeout') } }))

    expect(r.partners.find((p) => p.partner === 'AmOne')?.backlog).toBeNull()
    expect(alerted()).toEqual([expect.stringMatching(/^AmOne: .*backlog/)])
  })

  it('never throws, even when the alerter itself fails', async () => {
    vi.mocked(notifyExportFailure).mockRejectedValueOnce(new Error('slack down'))

    await expect(
      checkLeadStatus(env, supabase, deps({ AmOne: { submissions: 63, leads: 0, backlog: 1 } })),
    ).resolves.toMatchObject({ alerted: true })
  })

  it('names a partner Salesforce sold to that the check does not cover, so a new one is never silently exempt', async () => {
    const r = await checkLeadStatus(env, supabase, deps({}, { listPartners: async () => [
        { partner: 'Tripoint', n: 1035 },
        { partner: 'Engine', n: 696 },
        { partner: 'Liberty1', n: 12 },
      ] }))

    expect(r.alerted).toBe(true)
    expect(alerted()).toEqual([expect.stringMatching(/^Liberty1: 12 sales created on 2026-09-24 read Completed, and this check does not cover/)])
  })

  it('does not report sales with no partner, which have no Lead partner to compare', async () => {
    const r = await checkLeadStatus(env, supabase, deps({}, { listPartners: async () => [{ partner: null, n: 4 }, { partner: 'AmOne', n: 63 }] }))

    expect(r.alerted).toBe(false)
  })

  it('refuses by name when the partners sold to cannot be listed', async () => {
    const r = await checkLeadStatus(env, supabase, deps({}, { listPartners: async () => {
        throw new Error('query failed (503)')
      } }))

    expect(r.alerted).toBe(true)
    expect(alerted()).toEqual([expect.stringMatching(/partners .*could not be listed.*503/)])
  })

  it('asks for the partners sold to over the same UTC day it judges', async () => {
    const days: Date[] = []
    await checkLeadStatus(env, supabase, deps({}, { listPartners: async (dayStart) => {
        days.push(dayStart)
        return []
      } }))

    expect(days.map((d) => d.toISOString())).toEqual(['2026-09-24T00:00:00.000Z'])
  })

  // Measured 2026-09-29: of Tripoint's 56 backlog sales, 53 have a Lead whose
  // current Submission is a later visit by the same customer, so no backfill of
  // this sale can change that Lead (#1525). Only the other 3 were left behind.
  it('leaves out a sale whose Lead has moved on to a later Submission, and says how many were left out', async () => {
    const r = await checkLeadStatus(env, supabase, deps({ Tripoint: { submissions: 1046, leads: 1046, backlog: { own: 3, returning: 53 } } }))

    expect(r.partners.find((p) => p.partner === 'Tripoint')).toMatchObject({ backlog: 3, backlog_returning: 53 })
    const lines = alerted()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^Tripoint: 3 Completed sales since 2026-07-08/)
    expect(lines[0]).toMatch(/53 more .*later Submission/)
  })

  it('clears when the only sales left are returning customers, since no backfill can change them', async () => {
    const r = await checkLeadStatus(env, supabase, deps({ Tripoint: { submissions: 1046, leads: 1046, backlog: { own: 0, returning: 53 } } }))

    expect(r.alerted).toBe(false)
    expect(alerted()).toEqual([])
    expect(r.partners.find((p) => p.partner === 'Tripoint')?.backlog_returning).toBe(53)
  })

  it('counts a sale whose Lead names no Submission at all as left behind, since nothing shows the Lead moved on', async () => {
    const r = await checkLeadStatus(env, supabase, deps({}, {
      rows: async (soql) => (soql === leadStatusQueries('Tripoint', DAY).backlog
        ? [{ Id: 'a04Ui00000N55kzIAB', Lead__r: { Submission_Object_ID__c: null } }, { Id: 'a04Ui00000N55mbIAB', Lead__r: null }]
        : []),
    }))

    expect(r.partners.find((p) => p.partner === 'Tripoint')).toMatchObject({ backlog: 2, backlog_returning: 0 })
  })

  it('matches a Lead naming the sale by its 15 character id', async () => {
    const r = await checkLeadStatus(env, supabase, deps({}, {
      rows: async (soql) => (soql === leadStatusQueries('Tripoint', DAY).backlog
        ? [{ Id: 'a04Ui00000N55kzIAB', Lead__r: { Submission_Object_ID__c: 'a04Ui00000N55kz' } }]
        : []),
    }))

    expect(r.partners.find((p) => p.partner === 'Tripoint')).toMatchObject({ backlog: 1, backlog_returning: 0 })
  })

  it('refuses the backlog, rather than counting part of it, when a row cannot be read', async () => {
    const r = await checkLeadStatus(env, supabase, deps({}, {
      rows: async (soql) => (soql === leadStatusQueries('AmOne', DAY).backlog ? [{ Lead__r: { Submission_Object_ID__c: 'x' } }] : []),
    }))

    expect(r.partners.find((p) => p.partner === 'AmOne')?.backlog).toBeNull()
    expect(alerted()).toEqual([expect.stringMatching(/^AmOne: the backlog .*could not be counted/)])
  })

  // The 2026-09-29 alert said Tripoint's sales created on 09-28 "are carrying
  // over" on a day that synced 1,046 of 1,046. A healthy day says so instead.
  it('on a healthy day, says the day synced and that the backlog is older sales for a backfill', async () => {
    await checkLeadStatus(env, supabase, deps({ Tripoint: { submissions: 1046, leads: 1046, backlog: 3 } }))

    const [line] = alerted()
    expect(line).not.toMatch(/carrying over/)
    expect(line).toMatch(/1,046 of 1,046 sales created on 2026-09-24 did reach the Lead/)
    expect(line).toMatch(/backfill/)
  })

  // AmOne on 2026-09-28: 0 of 55. That is the ongoing copy broken, which no
  // backfill fixes, and the alert has to say which of the two it is.
  it('on a failing day, says new sales are not reaching the Lead, which a backfill alone does not fix', async () => {
    await checkLeadStatus(env, supabase, deps({ AmOne: { submissions: 55, leads: 0, backlog: 248 } }))

    const [line] = alerted()
    expect(line).toMatch(/^AmOne: 0 of 55 sales created on 2026-09-24 have a Lead reading Completed \(0%\)/)
    expect(line).toMatch(/new sales are not reaching the Lead/)
    expect(line).toMatch(/248/)
  })

  it('tells the reader this is Salesforce and that Submission based reporting is right', () => {
    expect(LEAD_STATUS_REMEDY.consequence).toMatch(/ExternalRevenue__c/)
    expect(LEAD_STATUS_REMEDY.consequence).toMatch(/Submission__c/)
    expect(LEAD_STATUS_REMEDY.consequence).not.toMatch(/Snowflake|exported/i)
    expect(LEAD_STATUS_REMEDY.fixHint).toMatch(/lead-status-check/)
  })
})
