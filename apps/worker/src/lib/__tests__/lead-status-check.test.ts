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
  LEAD_STATUS_BACKLOG_REMEDY,
  LEAD_STATUS_BROKEN_REMEDY,
  LEAD_STATUS_UNCHECKED_REMEDY,
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

type SentRemedy = { title?: string; context?: string; fixHint?: string }

function sentRemedy(): SentRemedy | undefined {
  const call = vi.mocked(notifyExportFailure).mock.calls.find((c) => c[1] === LEAD_STATUS_JOB)
  return call?.[4] as SentRemedy | undefined
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
    // Liberty1 went live 2026-09-30 and 43 of 43 of that day's sales reached
    // their Lead, which is the healthy share it is judged by.
    expect(LEAD_STATUS_PARTNERS.map((p) => p.partner).sort()).toEqual(['AmOne', 'Engine', 'Liberty1', 'Tripoint'])
    expect(LEAD_STATUS_PARTNERS.filter((p) => p.judged).map((p) => p.partner).sort()).toEqual(['AmOne', 'Liberty1', 'Tripoint'])
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
    expect(lines[0]).toBe(
      'Only 0 of 63 AmOne sales on Sep 24 reached their Lead (0%). Normally 97% do, so new sales aren\'t syncing. ' +
        '4,259 older AmOne sales are also waiting.',
    )
    expect(sentRemedy()?.title).toBe(LEAD_STATUS_BROKEN_REMEDY.title)
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
    expect(alerted()).toEqual(["The check couldn't count Engine sales in Salesforce: query failed (500)"])
    expect(sentRemedy()?.title).toBe(LEAD_STATUS_UNCHECKED_REMEDY.title)
    expect(sentRemedy()?.fixHint).toBeUndefined()
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
    expect(alerted()).toEqual(['32 Tripoint sales are marked Completed on their Submission, but their Lead still says something else.'])
    expect(sentRemedy()).toMatchObject(LEAD_STATUS_BACKLOG_REMEDY)
  })

  it('says so when a judged partner had nothing to compare, rather than reading it as agreement', async () => {
    const r = await checkLeadStatus(env, supabase, deps({ AmOne: { submissions: 0, leads: 0, backlog: 0 } }))

    expect(r.alerted).toBe(true)
    expect(alerted()).toEqual(['Salesforce has no Completed AmOne sales from Sep 24, so there was nothing to compare.'])
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
    expect(lines[0]).toBe("The check couldn't count Tripoint sales in Salesforce: query failed (401): INVALID_SESSION_ID")
  })

  it('still judges the day when only the backlog count fails, and says the backlog is unknown', async () => {
    const r = await checkLeadStatus(env, supabase, deps({ AmOne: { submissions: 600, leads: 590, backlog: new Error('timeout') } }))

    expect(r.partners.find((p) => p.partner === 'AmOne')?.backlog).toBeNull()
    expect(alerted()).toEqual(["The check couldn't count older AmOne sales waiting on their Lead: timeout"])
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
        { partner: 'Acme', n: 12 },
      ] }))

    expect(r.alerted).toBe(true)
    expect(alerted()).toEqual(["Salesforce had 12 Acme sales on Sep 24, but this check doesn't cover Acme yet, so their Leads weren't checked."])
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
    expect(alerted()).toEqual(["The check couldn't list which partners had sales on Sep 24, so a new partner would go unnoticed: query failed (503)"])
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
  it('leaves out a sale whose Lead has moved on to a later Submission', async () => {
    const r = await checkLeadStatus(env, supabase, deps({ Tripoint: { submissions: 1046, leads: 1046, backlog: { own: 3, returning: 53 } } }))

    expect(r.partners.find((p) => p.partner === 'Tripoint')).toMatchObject({ backlog: 3, backlog_returning: 53 })
    const lines = alerted()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^3 Tripoint sales are marked Completed/)
    // Returning customers never change, so naming them in the alert only adds a
    // number nobody can act on; the result still carries it.
    expect(lines[0]).not.toContain('53')
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
    expect(alerted()).toEqual([expect.stringMatching(/^The check couldn't count older AmOne sales waiting on their Lead: /)])
  })

  it('names when the waiting sales were made and what their Leads say instead, from the rows themselves', async () => {
    await checkLeadStatus(env, supabase, deps({}, {
      rows: async (soql) => (soql === leadStatusQueries('Tripoint', DAY).backlog
        ? [
            { Id: 'a04Ui00000MnrZZIAZ', CreatedDate: '2026-09-21T15:00:00.000+0000', Lead__r: { Submission_Object_ID__c: 'a04Ui00000MnrZZIAZ', External_Exchange_Status__c: 'Pending' } },
            { Id: 'a04Ui00000MzB6jIAF', CreatedDate: '2026-09-25T15:00:00.000+0000', Lead__r: { Submission_Object_ID__c: 'a04Ui00000MzB6jIAF', External_Exchange_Status__c: 'Fail' } },
            { Id: 'a04Ui00000N55GLIAZ', CreatedDate: '2026-09-28T15:00:00.000+0000', Lead__r: { Submission_Object_ID__c: 'a04Ui00000N55GLIAZ', External_Exchange_Status__c: 'Pending' } },
          ]
        : []),
    }))

    expect(alerted()).toEqual([
      '3 Tripoint sales from Sep 21 to Sep 28 are marked Completed on their Submission, but their Lead still says Pending or Fail.',
    ])
  })

  it('writes one waiting sale in the singular, on its one day', async () => {
    await checkLeadStatus(env, supabase, deps({}, {
      rows: async (soql) => (soql === leadStatusQueries('AmOne', DAY).backlog
        ? [{ Id: 'a04Ui00000MnrZZIAZ', CreatedDate: '2026-09-21T15:00:00.000+0000', Lead__r: { Submission_Object_ID__c: null, External_Exchange_Status__c: 'Pending' } }]
        : []),
    }))

    expect(alerted()).toEqual(['1 AmOne sale from Sep 21 is marked Completed on its Submission, but its Lead still says Pending.'])
  })

  it('asks for the date and the Lead status of each waiting sale', () => {
    const q = leadStatusQueries('Tripoint', DAY).backlog
    expect(q).toMatch(/^SELECT Id, CreatedDate, Lead__r\.Submission_Object_ID__c, Lead__r\.External_Exchange_Status__c FROM/)
  })

  it('says what a Lead that disagrees costs, once, beside the findings', async () => {
    await checkLeadStatus(env, supabase, deps({ Tripoint: { submissions: 1046, leads: 1046, backlog: 3 } }))

    expect(sentRemedy()?.context).toBe('Until a Lead says Completed, its External Revenue shows $0 for that sale.')
  })

  it('a backlog alone asks for each sale to be checked; a broken day asks for the Salesforce copy to be fixed', async () => {
    expect(LEAD_STATUS_BACKLOG_REMEDY.fixHint).toMatch(/real sale/)
    expect(LEAD_STATUS_BROKEN_REMEDY.fixHint).toMatch(/Salesforce/)
    expect(LEAD_STATUS_BROKEN_REMEDY.fixHint).toMatch(/backfill/)
    for (const r of [LEAD_STATUS_BACKLOG_REMEDY, LEAD_STATUS_BROKEN_REMEDY, LEAD_STATUS_UNCHECKED_REMEDY]) {
      expect(`${r.title} ${r.fixHint ?? ''}`).not.toMatch(/Snowflake|exported|__c|#\d|apps\//)
    }
  })

  it('a broken day outranks a backlog elsewhere in the same run, so the fix names the copy', async () => {
    await checkLeadStatus(env, supabase, deps({
      AmOne: { submissions: 55, leads: 0, backlog: 248 },
      Tripoint: { submissions: 1046, leads: 1046, backlog: 3 },
    }))

    expect(sentRemedy()?.title).toBe(LEAD_STATUS_BROKEN_REMEDY.title)
    expect(sentRemedy()?.fixHint).toBe(LEAD_STATUS_BROKEN_REMEDY.fixHint)
    expect(alerted()).toHaveLength(2)
  })
})
