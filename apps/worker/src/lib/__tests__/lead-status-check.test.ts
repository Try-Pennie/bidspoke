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
  LEAD_STATUS_ANSWERED_BACKLOG_REMEDY,
  LEAD_STATUS_BROKEN_REMEDY,
  LEAD_STATUS_UNCHECKED_REMEDY,
  LEAD_STATUS_PARTNERS,
  deliveredClickCounter,
  type LeadStatusDeps,
} from '../lead-status-check'
import { notifyExportFailure } from '../export-alerts'
import type { BuyerProfilesSnapshot, LoadedBuyer } from '../buyer-profile-loader'
import type { OperatingWindow } from '@bidspoke/buyer-profile'
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
function counter(answers: Record<string, PartnerAnswers>, day: Date = DAY, now: Date = NOW()) {
  const asked: string[] = []
  const count: LeadStatusDeps['count'] = async (soql) => {
    asked.push(soql)
    for (const { partner } of LEAD_STATUS_PARTNERS) {
      const q = leadStatusQueries(partner, day, now)
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
      if (soql !== leadStatusQueries(partner, day, now).backlog) continue
      const b = (answers[partner] ?? HEALTHY).backlog
      if (b instanceof Error) throw b
      return typeof b === 'number' ? backlogRows(partner, b, 0) : backlogRows(partner, b.own, b.returning)
    }
    throw new Error(`unexpected row query: ${soql}`)
  }
  return { count, rows, asked }
}

/** No enabled buyer profile at all: the seam set explicitly, never left to the real reader (L284). */
const NO_PROFILES: LeadStatusDeps['loadProfiles'] = async () => snapshotOf([])

/** Bidspoke delivered no click for anyone: the seam set explicitly, never left to the real reader (L284). */
const NO_CLICKS: LeadStatusDeps['countDeliveredClicks'] = async () => 0

function snapshotOf(buyers: LoadedBuyer[], extra: Partial<BuyerProfilesSnapshot> = {}): BuyerProfilesSnapshot {
  return { org_id: 'org-1', loaded_at: NOW().toISOString(), content_hash: 'h', served_from: 'database', buyers, ...extra }
}

/**
 * An enabled buyer as the one profile loader shapes it. The partner name is the
 * value Salesforce records as the partner (held click writes send it), which is
 * how the check finds a Salesforce partner's profile.
 */
let nextBuyerId = 0
function buyer(name: string, soldOn: 'click' | 'offer', windows: OperatingWindow[], blackoutDates: string[] = []): LoadedBuyer {
  const id = `00000000-0000-4000-8000-${String(++nextBuyerId).padStart(12, '0')}`
  return {
    partner: {
      id, slug: name.toLowerCase(), name, is_active: true, api_endpoint: null, cf_secret_key: null, outbound_field_mapping: null,
      extra_extraction: null, accept_signals: [], response_classification: null, click_url: null, external_routing_code: 4,
      duplicate_signals: [], circuit_enabled: false, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 60,
    },
    profile: {
      partnerId: id, soldOn, isEnabled: true, priority: soldOn === 'offer' ? 1 : null, allowedStates: ['NY'], debtMin: null, debtMax: null,
      loanAmountMin: null, hourlyLeadCap: null, dailyLeadCap: 50, hourlySpendCapCents: null, dailySpendCapCents: null,
      windows, blackoutDates, tiers: [],
    },
    version: 1,
    updated_at: '2026-10-01T00:00:00Z',
  }
}

/** Liberty1's hours since 2026-10-01: Monday to Friday, 09:00 to 21:00 Eastern. */
const WEEKDAYS_9_TO_9: OperatingWindow[] = [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, opensMinute: 9 * 60, closesMinute: 21 * 60 }))

/** The UTC day before a run, which is the day the check judges. */
function judgedDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
}

/** The deps for one run: every seam set from the same answers, never left to the real reader (L284). */
function deps(answers: Record<string, PartnerAnswers>, extra: Partial<LeadStatusDeps> = {}): LeadStatusDeps {
  const at = (extra.now ?? NOW)()
  const c = counter(answers, judgedDay(at), at)
  return { listPartners: ONLY_CHECKED, count: c.count, rows: c.rows, now: NOW, loadProfiles: NO_PROFILES, countDeliveredClicks: NO_CLICKS, ...extra }
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
    const q = leadStatusQueries('AmOne', DAY, NOW())
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
    const q = leadStatusQueries('Tripoint', DAY, NOW())
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
    expect(alerted()).toEqual(['32 Tripoint sales are marked Completed on their Submission, but their Lead still says something else. Tripoint has no answer on record for any of them.'])
    expect(sentRemedy()).toMatchObject(LEAD_STATUS_ANSWERED_BACKLOG_REMEDY)
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
      rows: async (soql) => (soql === leadStatusQueries('Tripoint', DAY, NOW()).backlog
        ? [{ Id: 'a04Ui00000N55kzIAB', Lead__r: { Submission_Object_ID__c: null } }, { Id: 'a04Ui00000N55mbIAB', Lead__r: null }]
        : []),
    }))

    expect(r.partners.find((p) => p.partner === 'Tripoint')).toMatchObject({ backlog: 2, backlog_returning: 0 })
  })

  it('matches a Lead naming the sale by its 15 character id', async () => {
    const r = await checkLeadStatus(env, supabase, deps({}, {
      rows: async (soql) => (soql === leadStatusQueries('Tripoint', DAY, NOW()).backlog
        ? [{ Id: 'a04Ui00000N55kzIAB', Lead__r: { Submission_Object_ID__c: 'a04Ui00000N55kz' } }]
        : []),
    }))

    expect(r.partners.find((p) => p.partner === 'Tripoint')).toMatchObject({ backlog: 1, backlog_returning: 0 })
  })

  it('refuses the backlog, rather than counting part of it, when a row cannot be read', async () => {
    const r = await checkLeadStatus(env, supabase, deps({}, {
      rows: async (soql) => (soql === leadStatusQueries('AmOne', DAY, NOW()).backlog ? [{ Lead__r: { Submission_Object_ID__c: 'x' } }] : []),
    }))

    expect(r.partners.find((p) => p.partner === 'AmOne')?.backlog).toBeNull()
    expect(alerted()).toEqual([expect.stringMatching(/^The check couldn't count older AmOne sales waiting on their Lead: /)])
  })

  it('names when the waiting sales were made and what their Leads say instead, from the rows themselves', async () => {
    await checkLeadStatus(env, supabase, deps({}, {
      rows: async (soql) => (soql === leadStatusQueries('Tripoint', DAY, NOW()).backlog
        ? [
            { Id: 'a04Ui00000MnrZZIAZ', CreatedDate: '2026-09-21T15:00:00.000+0000', Lead__r: { Submission_Object_ID__c: 'a04Ui00000MnrZZIAZ', External_Exchange_Status__c: 'Pending' } },
            { Id: 'a04Ui00000MzB6jIAF', CreatedDate: '2026-09-25T15:00:00.000+0000', Lead__r: { Submission_Object_ID__c: 'a04Ui00000MzB6jIAF', External_Exchange_Status__c: 'Fail' } },
            { Id: 'a04Ui00000N55GLIAZ', CreatedDate: '2026-09-28T15:00:00.000+0000', Lead__r: { Submission_Object_ID__c: 'a04Ui00000N55GLIAZ', External_Exchange_Status__c: 'Pending' } },
          ]
        : []),
    }))

    expect(alerted()).toEqual([
      '3 Tripoint sales from Sep 21 to Sep 28 are marked Completed on their Submission, but their Lead still says Pending or Fail. Tripoint has no answer on record for any of them.',
    ])
  })

  it('writes one waiting sale in the singular, on its one day', async () => {
    await checkLeadStatus(env, supabase, deps({}, {
      rows: async (soql) => (soql === leadStatusQueries('AmOne', DAY, NOW()).backlog
        ? [{ Id: 'a04Ui00000MnrZZIAZ', CreatedDate: '2026-09-21T15:00:00.000+0000', Lead__r: { Submission_Object_ID__c: null, External_Exchange_Status__c: 'Pending' } }]
        : []),
    }))

    expect(alerted()).toEqual(['1 AmOne sale from Sep 21 is marked Completed on its Submission, but its Lead still says Pending.'])
  })

  it('asks for the date, the Lead status and what Tripoint answered for each waiting sale', () => {
    const q = leadStatusQueries('Tripoint', DAY, NOW()).backlog
    expect(q).toMatch(
      /^SELECT Id, CreatedDate, Tripoint_Response__c, Tripoint_Submit_Response__c, Lead__r\.Submission_Object_ID__c, Lead__r\.External_Exchange_Status__c FROM/,
    )
  })

  // Measured 2026-10-13 (#2019): Sub-003007872's Submission read Completed at
  // 13:01:20 UTC and its Lead at 13:01:21, and the check that read it at 13:01:21
  // counted it as left behind. A sale touched inside the grace waits for the next
  // day's run instead, so it is delayed, never lost.
  it('leaves a sale touched in the last 15 minutes to the next run, so a Lead write still in flight is not counted', () => {
    const q = leadStatusQueries('Tripoint', DAY, new Date('2026-09-25T13:00:00Z')).backlog
    expect(q).toContain('LastModifiedDate < 2026-09-25T12:45:00Z')
    // The day's own counts are untouched: a few sales mid write cannot move a share of hundreds.
    expect(leadStatusQueries('Tripoint', DAY, new Date('2026-09-25T13:00:00Z')).submissions).not.toContain('LastModifiedDate')
  })

  // #1837: on 2026-10-07 every listed sale was not one. Five were Tripoint
  // refusals flipped to Completed (#1750) and two had no Tripoint answer at all,
  // so "set the Lead to Completed" would have booked revenue on refused leads.
  it('says which waiting Tripoint sales Tripoint accepted, refused, or has no answer on record for', async () => {
    const row = (id: string, response: string | null, submit: string | null) => ({
      Id: id, CreatedDate: '2026-10-07T15:00:00.000+0000', Tripoint_Response__c: response, Tripoint_Submit_Response__c: submit,
      Lead__r: { Submission_Object_ID__c: id, External_Exchange_Status__c: 'Pending' },
    })
    await checkLeadStatus(env, supabase, deps({}, {
      rows: async (soql) => (soql === leadStatusQueries('Tripoint', DAY, NOW()).backlog
        ? [
            row('a04Ui00000N00001IA', 'Success', '200'),
            row('a04Ui00000N00002IA', 'Duplicate', null),
            row('a04Ui00000N00003IA', null, '409'),
            row('a04Ui00000N00004IA', 'Fail', null),
            row('a04Ui00000N00005IA', null, null),
          ]
        : []),
    }))
    expect(alerted()).toEqual([
      '5 Tripoint sales from Oct 7 are marked Completed on their Submission, but their Lead still says Pending. ' +
        'Tripoint accepted 1, refused 3, and has no answer on record for 1.',
    ])
  })

  it('treats a refusal as a refusal even beside an accepted code, so revenue is never booked on a refused lead', async () => {
    await checkLeadStatus(env, supabase, deps({}, {
      rows: async (soql) => (soql === leadStatusQueries('Tripoint', DAY, NOW()).backlog
        ? [{ Id: 'a04Ui00000N00001IA', CreatedDate: '2026-10-07T15:00:00.000+0000', Tripoint_Response__c: 'Duplicate', Tripoint_Submit_Response__c: '200', Lead__r: { Submission_Object_ID__c: null, External_Exchange_Status__c: 'Pending' } }]
        : []),
    }))
    expect(alerted()).toEqual([
      '1 Tripoint sale from Oct 7 is marked Completed on its Submission, but its Lead still says Pending. Tripoint refused it.',
    ])
  })

  it('says all of them when every waiting Tripoint sale had the same answer', async () => {
    const accepted = (id: string) => ({ Id: id, CreatedDate: '2026-10-07T15:00:00.000+0000', Tripoint_Submit_Response__c: '208', Lead__r: { Submission_Object_ID__c: id, External_Exchange_Status__c: 'Pending' } })
    await checkLeadStatus(env, supabase, deps({}, {
      rows: async (soql) => (soql === leadStatusQueries('Tripoint', DAY, NOW()).backlog ? [accepted('a04Ui00000N00001IA'), accepted('a04Ui00000N00002IA')] : []),
    }))
    expect(alerted()[0]).toMatch(/ Tripoint accepted both\.$/)
  })

  it('adds no Tripoint answer to another partner\'s waiting sales, which carry none', async () => {
    await checkLeadStatus(env, supabase, deps({}, {
      rows: async (soql) => (soql === leadStatusQueries('AmOne', DAY, NOW()).backlog
        ? [{ Id: 'a04Ui00000MnrZZIAZ', CreatedDate: '2026-09-21T15:00:00.000+0000', Lead__r: { Submission_Object_ID__c: null, External_Exchange_Status__c: 'Pending' } }]
        : []),
    }))
    expect(alerted()).toEqual(['1 AmOne sale from Sep 21 is marked Completed on its Submission, but its Lead still says Pending.'])
  })

  // #2019's cause is inferred from matching timestamps; nothing recorded which
  // sale the run counted. The log now does, so the next one can be proved.
  it('logs the ids of the waiting sales it counted', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await checkLeadStatus(env, supabase, deps({ Tripoint: { submissions: 1046, leads: 1046, backlog: { own: 2, returning: 1 } } }))
      const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[lead-status] day=')) ?? ''
      expect(line).toContain('Tripoint waiting=a04TriO000000000AA,a04TriO000000001AA')
      expect(line).not.toContain('a04TriR')
    } finally {
      log.mockRestore()
    }
  })

  it('says what a Lead that disagrees costs, once, beside the findings', async () => {
    await checkLeadStatus(env, supabase, deps({ Tripoint: { submissions: 1046, leads: 1046, backlog: 3 } }))

    expect(sentRemedy()?.context).toBe('Until a Lead says Completed, its External Revenue shows $0 for that sale.')
  })

  it('a backlog alone asks for each sale to be checked; a broken day asks for the Salesforce copy to be fixed', async () => {
    expect(LEAD_STATUS_BACKLOG_REMEDY.fixHint).toMatch(/real sale/)
    // Completed only for a sale the buyer accepted: a refused one is set back (#1837).
    expect(LEAD_STATUS_ANSWERED_BACKLOG_REMEDY.fixHint).toMatch(/only for a sale the buyer accepted/)
    expect(LEAD_STATUS_ANSWERED_BACKLOG_REMEDY.fixHint).toMatch(/refused/)
    expect(LEAD_STATUS_BROKEN_REMEDY.fixHint).toMatch(/Salesforce/)
    expect(LEAD_STATUS_BROKEN_REMEDY.fixHint).toMatch(/backfill/)
    for (const r of [LEAD_STATUS_BACKLOG_REMEDY, LEAD_STATUS_ANSWERED_BACKLOG_REMEDY, LEAD_STATUS_BROKEN_REMEDY, LEAD_STATUS_UNCHECKED_REMEDY]) {
      expect(`${r.title} ${r.fixHint ?? ''}`).not.toMatch(/Snowflake|exported|__c|#\d|apps\//)
    }
  })

  // The buyer-answer fix only makes sense beside lines that carry the answer:
  // AmOne and Liberty1 lines carry none (#1837 review).
  it('asks to book only accepted sales when every waiting line says what the buyer answered', async () => {
    await checkLeadStatus(env, supabase, deps({ Tripoint: { submissions: 1046, leads: 1046, backlog: 3 } }))
    expect(sentRemedy()).toMatchObject(LEAD_STATUS_ANSWERED_BACKLOG_REMEDY)
  })

  it('keeps the plain check-each-sale fix when any waiting line has no buyer answer', async () => {
    await checkLeadStatus(env, supabase, deps({ AmOne: { submissions: 600, leads: 598, backlog: 2 } }))
    expect(sentRemedy()).toMatchObject(LEAD_STATUS_BACKLOG_REMEDY)
    vi.mocked(notifyExportFailure).mockClear()
    await checkLeadStatus(env, supabase, deps({ AmOne: { submissions: 600, leads: 598, backlog: 2 }, Tripoint: { submissions: 1046, leads: 1046, backlog: 3 } }))
    expect(sentRemedy()).toMatchObject(LEAD_STATUS_BACKLOG_REMEDY)
  })

  it('a broken day outranks a backlog elsewhere in the same run, so the fix names the copy', async () => {
    await checkLeadStatus(env, supabase, deps({
      AmOne: { submissions: 55, leads: 0, backlog: 248 },
      Tripoint: { submissions: 1046, leads: 1046, backlog: 3 },
    }))

    expect(sentRemedy()?.title).toBe(LEAD_STATUS_BROKEN_REMEDY.title)
    expect(alerted()).toHaveLength(2)
    // Each partner gets its own fix (#835): the copy and a backfill for AmOne,
    // the buyer answer check for Tripoint, whose day synced.
    const fix = sentRemedy()?.fixHint ?? ''
    expect(fix).toMatch(/Lead for AmOne\. That copy needs fixing in Salesforce, and then the older AmOne sales need a backfill/)
    expect(fix).toMatch(/For Tripoint: Set the Lead's External Exchange Status to Completed in Salesforce only for a sale the buyer accepted/)
    expect(fix).not.toMatch(/this partner|Tripoint sales need a backfill/)
  })

  it('a broken day alone names its partner in the fix (#835)', async () => {
    await checkLeadStatus(env, supabase, deps({ AmOne: { submissions: 55, leads: 0, backlog: 248 } }))
    expect(sentRemedy()?.fixHint).toBe(
      'Salesforce has stopped copying Completed from the Submission to the Lead for AmOne. That copy needs fixing in Salesforce, ' +
        'and then the older AmOne sales need a backfill.',
    )
  })
})

// The alerter tells a reminder from a new problem by these keys (#1768). Measured
// in #statuspage: Oct 3 posted two Tripoint sales from Sep 25 to Sep 27, Oct 4
// one from Sep 30, Oct 5 a Liberty1 day with no sales; each was a new problem.
describe('what each finding is about, for the alerter (#1768)', () => {
  /** The meaning keys the run handed the alerter, one per finding. */
  function sentKeys(): string[] | undefined {
    const call = vi.mocked(notifyExportFailure).mock.calls.find((c) => c[1] === LEAD_STATUS_JOB)
    return (call?.[6] as { keys?: string[] } | undefined)?.keys
  }
  const backlogOn = (rows: Array<[string, string]>) => ({
    rows: async (soql: string) => (soql === leadStatusQueries('Tripoint', DAY, NOW()).backlog
      ? rows.map(([id, created]) => ({ Id: id, CreatedDate: created, Lead__r: { Submission_Object_ID__c: id, External_Exchange_Status__c: 'Fail' } }))
      : []),
  })

  it('names one key per finding', async () => {
    await checkLeadStatus(env, supabase, deps({
      AmOne: { submissions: 63, leads: 0, backlog: 4259 },
      Liberty1: { submissions: 0, leads: 0, backlog: 0 },
    }, { listPartners: async () => [{ partner: 'Acme', n: 12 }] }))

    expect(alerted()).toHaveLength(3)
    expect(sentKeys()).toEqual(['broken:AmOne', 'zero:Liberty1', 'uncovered:Acme'])
  })

  it('gives a partner with no sales the same key whatever day was judged', async () => {
    await checkLeadStatus(env, supabase, deps({ AmOne: { submissions: 0, leads: 0, backlog: 0 } }))
    const first = sentKeys()
    vi.mocked(notifyExportFailure).mockClear()
    await checkLeadStatus(env, supabase, deps({ AmOne: { submissions: 0, leads: 0, backlog: 0 } }, { now: () => new Date('2026-09-26T13:00:00Z') }))

    expect(alerted()).toEqual(['Salesforce has no Completed AmOne sales from Sep 25, so there was nothing to compare.'])
    expect(first).toEqual(['zero:AmOne'])
    expect(sentKeys()).toEqual(first)
  })

  it('names the days of the waiting sales, so a different set of sales is a new problem', async () => {
    await checkLeadStatus(env, supabase, deps({}, backlogOn([
      ['a04Ui00000MnrZZIAZ', '2026-09-25T15:00:00.000+0000'],
      ['a04Ui00000MzB6jIAF', '2026-09-27T15:00:00.000+0000'],
    ])))
    const oct3 = sentKeys()
    vi.mocked(notifyExportFailure).mockClear()
    await checkLeadStatus(env, supabase, deps({}, backlogOn([['a04Ui00000N55GLIAZ', '2026-09-30T15:00:00.000+0000']])))

    expect(oct3).toEqual(['backlog:Tripoint:Sep 25..Sep 27'])
    expect(sentKeys()).toEqual(['backlog:Tripoint:Sep 30..Sep 30'])
  })

  it('keeps the key when sales over the same days are fixed one at a time', async () => {
    await checkLeadStatus(env, supabase, deps({}, backlogOn([
      ['a04Ui00000MnrZZIAZ', '2026-09-25T15:00:00.000+0000'],
      ['a04Ui00000MzB6kIAF', '2026-09-26T15:00:00.000+0000'],
      ['a04Ui00000MzB6jIAF', '2026-09-27T15:00:00.000+0000'],
    ])))
    const three = sentKeys()
    vi.mocked(notifyExportFailure).mockClear()
    await checkLeadStatus(env, supabase, deps({}, backlogOn([
      ['a04Ui00000MnrZZIAZ', '2026-09-25T15:00:00.000+0000'],
      ['a04Ui00000MzB6jIAF', '2026-09-27T15:00:00.000+0000'],
    ])))

    expect(three).toEqual(['backlog:Tripoint:Sep 25..Sep 27'])
    expect(sentKeys()).toEqual(three)
  })
})

// Measured (#2395): Liberty1 Completed Submissions by UTC creation day against
// the Liberty1 clicks Bidspoke delivered (buyer_click_send, reason sent) by the
// click's own UTC day were Oct 12 41 and 41, Oct 13 43 and 44, Oct 14 14 and 14,
// Oct 15 24 and 24, Oct 16 16 and 17, and Oct 17 0 and 0. The Oct 18 run paged
// on that last zero because Oct 17 UTC opens at 8 PM Friday Eastern, inside
// Liberty1's hours (#1767). A click buyer's sales follow the consumer's click,
// which the hours do not bound, so the delivered clicks decide instead.
describe('checkLeadStatus on a day a click buyer has no sales (#1767, #2395)', () => {
  /** Monday 2026-10-05 at 13:02 UTC, the run #1767 was about: the day judged is Sunday Oct 4. */
  const MONDAY = () => new Date('2026-10-05T13:02:00Z')
  /** Sunday 2026-10-18 at 13:01 UTC, the run #2395 was about: the day judged is Saturday Oct 17 UTC. */
  const OCT_18 = () => new Date('2026-10-18T13:01:00Z')
  const LIBERTY1_ZERO = { Liberty1: { submissions: 0, leads: 0, backlog: 0 } }
  const liberty1Buyer = () => buyer('Liberty1', 'click', WEEKDAYS_9_TO_9)
  const liberty1Profile = () => async () => snapshotOf([liberty1Buyer()])
  const delivered = (n: number) => vi.fn(async () => n)

  /** The one line every run logs, captured without printing it. */
  async function runLogged(d: LeadStatusDeps) {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const r = await checkLeadStatus(env, supabase, d)
      const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[lead-status] day='))
      return { r, line }
    } finally {
      log.mockRestore()
    }
  }

  it('raises nothing on Oct 17 UTC, inside Liberty1\'s hours, when Bidspoke delivered no Liberty1 click either, and logs why', async () => {
    const { r, line } = await runLogged(deps(LIBERTY1_ZERO, { now: OCT_18, loadProfiles: liberty1Profile(), countDeliveredClicks: delivered(0) }))

    expect(r.day).toBe('2026-10-17')
    expect(r.alerted).toBe(false)
    expect(alerted()).toEqual([])
    expect(r.partners.find((p) => p.partner === 'Liberty1')?.no_clicks_delivered).toBe(true)
    expect(line).toContain('not reported: Liberty1 had no Completed sales and Bidspoke delivered no Liberty1 clicks that day.')
  })

  it('raises the line, with the delivered count, when Bidspoke delivered Liberty1 clicks that day and Salesforce has no sale', async () => {
    const { r, line } = await runLogged(deps(LIBERTY1_ZERO, { now: OCT_18, loadProfiles: liberty1Profile(), countDeliveredClicks: delivered(17) }))

    expect(r.alerted).toBe(true)
    expect(alerted()).toEqual([
      'Salesforce has no Completed Liberty1 sales from Oct 17, but Bidspoke delivered 17 Liberty1 clicks that day, so there was nothing to compare.',
    ])
    expect(sentRemedy()?.title).toBe(LEAD_STATUS_UNCHECKED_REMEDY.title)
    expect(r.partners.find((p) => p.partner === 'Liberty1')?.no_clicks_delivered).toBe(false)
    expect(line).not.toContain('not reported')
  })

  it('says one click in the singular', async () => {
    await checkLeadStatus(env, supabase, deps(LIBERTY1_ZERO, { now: OCT_18, loadProfiles: liberty1Profile(), countDeliveredClicks: delivered(1) }))

    expect(alerted()).toEqual([
      'Salesforce has no Completed Liberty1 sales from Oct 17, but Bidspoke delivered 1 Liberty1 click that day, so there was nothing to compare.',
    ])
  })

  it('keeps the key a no sales line always had, so a standing alert is not announced as new', async () => {
    await checkLeadStatus(env, supabase, deps(LIBERTY1_ZERO, { now: OCT_18, loadProfiles: liberty1Profile(), countDeliveredClicks: delivered(3) }))

    const call = vi.mocked(notifyExportFailure).mock.calls.find((c) => c[1] === LEAD_STATUS_JOB)
    expect((call?.[6] as { keys?: string[] } | undefined)?.keys).toEqual(['zero:Liberty1'])
  })

  it('no longer reads the hours: a Sunday outside them with clicks delivered still raises the line', async () => {
    await checkLeadStatus(env, supabase, deps(LIBERTY1_ZERO, { now: MONDAY, loadProfiles: liberty1Profile(), countDeliveredClicks: delivered(2) }))

    expect(alerted()).toEqual([
      'Salesforce has no Completed Liberty1 sales from Oct 4, but Bidspoke delivered 2 Liberty1 clicks that day, so there was nothing to compare.',
    ])
  })

  it('counts the clicks for the buyer profile\'s partner id over the judged UTC day', async () => {
    const one = liberty1Buyer()
    const countDeliveredClicks = delivered(0)
    await checkLeadStatus(env, supabase, deps(LIBERTY1_ZERO, { now: OCT_18, loadProfiles: async () => snapshotOf([one]), countDeliveredClicks }))

    expect(countDeliveredClicks).toHaveBeenCalledTimes(1)
    expect(countDeliveredClicks).toHaveBeenCalledWith(one.partner.id, new Date('2026-10-17T00:00:00Z'))
  })

  it('raises an unchecked finding, never a zero, when the delivered clicks cannot be counted (L98)', async () => {
    const r = await checkLeadStatus(env, supabase, deps(LIBERTY1_ZERO, {
      now: OCT_18,
      loadProfiles: liberty1Profile(),
      countDeliveredClicks: async () => {
        throw new Error('execution_steps count failed: canceling statement due to statement timeout')
      },
    }))

    expect(r.alerted).toBe(true)
    expect(alerted()).toEqual([
      "Salesforce has no Completed Liberty1 sales from Oct 17, and the check couldn't count the Liberty1 clicks Bidspoke delivered that day: " +
        'execution_steps count failed: canceling statement due to statement timeout',
    ])
    expect(r.partners.find((p) => p.partner === 'Liberty1')?.no_clicks_delivered).toBe(false)
  })

  it('raises an unchecked finding, never a pass, when the buyer profiles cannot be read', async () => {
    const countDeliveredClicks = delivered(0)
    const r = await checkLeadStatus(env, supabase, deps(LIBERTY1_ZERO, {
      now: MONDAY,
      countDeliveredClicks,
      loadProfiles: async () => {
        throw new Error('buyer profiles read failed for org org-1: timeout')
      },
    }))

    expect(r.alerted).toBe(true)
    expect(alerted()).toEqual([
      "Salesforce has no Completed Liberty1 sales from Oct 4, and the check couldn't read the buyer profiles to tell whether Liberty1 is sold on the click: " +
        'buyer profiles read failed for org org-1: timeout',
    ])
    expect(sentRemedy()?.title).toBe(LEAD_STATUS_UNCHECKED_REMEDY.title)
    expect(countDeliveredClicks).not.toHaveBeenCalled()
  })

  it('raises an unchecked finding when the only copy of the profiles is too old to trust', async () => {
    // The database read failed and the loader served its last good copy, saved an hour before the run.
    const stale = async () => snapshotOf([liberty1Buyer()], { served_from: 'last_good', loaded_at: '2026-10-05T12:02:00Z' })
    await checkLeadStatus(env, supabase, deps(LIBERTY1_ZERO, { now: MONDAY, loadProfiles: stale }))

    expect(alerted()).toEqual([
      "Salesforce has no Completed Liberty1 sales from Oct 4, and the check couldn't read the buyer profiles to tell whether Liberty1 is sold on the click: " +
        'the database read failed and the saved copy is 60 minutes old.',
    ])
  })

  it('raises an unchecked finding when two buyer profiles carry the partner name, rather than picking one (L521)', async () => {
    const two = async () => snapshotOf([liberty1Buyer(), buyer('Liberty1', 'click', [{ dayOfWeek: 0, opensMinute: 0, closesMinute: 1440 }])])
    await checkLeadStatus(env, supabase, deps(LIBERTY1_ZERO, { now: MONDAY, loadProfiles: two }))

    expect(alerted()).toEqual([
      "Salesforce has no Completed Liberty1 sales from Oct 4, and 2 buyer profiles are named Liberty1, so the check couldn't tell whose clicks to count.",
    ])
  })

  it('still raises the line for Tripoint with no sales, sold on offers, without counting any clicks', async () => {
    // Tripoint's profile prices it for buyer selection, but most Tripoint sales come
    // through the older Tripoint ping, which never reads the profile, and it is not
    // sold on the click, so nothing bounds when Tripoint can sell.
    const tripointOffer = async () => snapshotOf([buyer('Tripoint', 'offer', WEEKDAYS_9_TO_9), liberty1Buyer()])
    const countDeliveredClicks = delivered(0)
    const r = await checkLeadStatus(env, supabase, deps({ Tripoint: { submissions: 0, leads: 0, backlog: 0 } }, { now: MONDAY, loadProfiles: tripointOffer, countDeliveredClicks }))

    expect(alerted()).toEqual(['Salesforce has no Completed Tripoint sales from Oct 4, so there was nothing to compare.'])
    expect(r.partners.find((p) => p.partner === 'Tripoint')?.no_clicks_delivered).toBe(false)
    expect(countDeliveredClicks).not.toHaveBeenCalled()
  })

  it('keeps every other partner\'s findings when judging one buyer\'s profile throws, and names that buyer (L73)', async () => {
    // A profile that cannot be read at all: the judgement for Liberty1 throws.
    const broken = liberty1Buyer()
    Object.defineProperty(broken.profile, 'soldOn', { get: () => { throw new Error('profile unreadable') } })
    await checkLeadStatus(env, supabase, deps(
      { ...LIBERTY1_ZERO, AmOne: { submissions: 55, leads: 0, backlog: 0 } },
      { now: MONDAY, loadProfiles: async () => snapshotOf([broken]) },
    ))

    const lines = alerted()
    expect(lines).toContain(
      "Salesforce has no Completed Liberty1 sales from Oct 4, and the check couldn't judge Liberty1's buyer profile: profile unreadable",
    )
    expect(lines.some((l) => l.startsWith('Only 0 of 55 AmOne sales on Oct 4 reached their Lead'))).toBe(true)
    expect(lines.some((l) => l.startsWith('The check itself failed'))).toBe(false)
  })

  it('still raises the line for a partner with no buyer profile, as before', async () => {
    await checkLeadStatus(env, supabase, deps({ AmOne: { submissions: 0, leads: 0, backlog: 0 } }, { now: MONDAY, loadProfiles: liberty1Profile() }))

    expect(alerted()).toEqual(['Salesforce has no Completed AmOne sales from Oct 4, so there was nothing to compare.'])
  })

  it('does not read the buyer profiles or count clicks on a day every judged partner had sales, so a failed read there adds nothing', async () => {
    const loadProfiles = vi.fn(async (): Promise<BuyerProfilesSnapshot> => {
      throw new Error('should not be read')
    })
    const countDeliveredClicks = delivered(0)
    const r = await checkLeadStatus(env, supabase, deps({}, { now: MONDAY, loadProfiles, countDeliveredClicks }))

    expect(r.alerted).toBe(false)
    expect(loadProfiles).not.toHaveBeenCalled()
    expect(countDeliveredClicks).not.toHaveBeenCalled()
  })
})

/**
 * The real delivered click reader, against a recording query double: it must
 * count rather than fetch rows, prune to the judged day's partition by the
 * partition key, and refuse rather than read a zero from a failed or empty answer.
 */
describe('deliveredClickCounter (#2395)', () => {
  type Answer = { count: number | null; error: unknown; status?: number; statusText?: string }
  function recordingSupabase(answer: Answer) {
    const calls: Array<[string, ...unknown[]]> = []
    const query: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gte', 'lt']) {
      query[m] = (...args: unknown[]) => {
        calls.push([m, ...args])
        return query
      }
    }
    query.then = (resolve: (a: Answer) => unknown) => resolve(answer)
    const client = {
      from: (table: string) => {
        calls.push(['from', table])
        return query
      },
    } as unknown as SupabaseClient
    return { client, calls }
  }
  const PARTNER = '4ed89cc6-b25b-4537-8b3d-5bf1fc237cc3'
  const OCT_17 = new Date('2026-10-17T00:00:00Z')

  it('counts the non test buyer_click_send steps that sent for this buyer, started inside the judged UTC day', async () => {
    const { client, calls } = recordingSupabase({ count: 4, error: null })
    await expect(deliveredClickCounter(client)(PARTNER, OCT_17)).resolves.toBe(4)

    expect(calls).toEqual([
      ['from', 'execution_steps'],
      ['select', 'id', { count: 'exact', head: true }],
      ['eq', 'step_type', 'buyer_click_send'],
      ['eq', 'is_test', false],
      ['eq', 'output->>reason', 'sent'],
      ['eq', 'output->>partner_id', PARTNER],
      ['gte', 'started_at', '2026-10-17T00:00:00.000Z'],
      ['lt', 'started_at', '2026-10-18T00:00:00.000Z'],
    ])
  })

  it('throws, naming the status, when the count fails, so it is never read as no clicks', async () => {
    const { client } = recordingSupabase({ count: null, error: { message: '' }, status: 500, statusText: 'Internal Server Error' })
    await expect(deliveredClickCounter(client)(PARTNER, OCT_17)).rejects.toThrow(/500/)
  })

  it('throws when the answer carries no count at all, rather than reading it as zero (L90)', async () => {
    const { client } = recordingSupabase({ count: null, error: null })
    await expect(deliveredClickCounter(client)(PARTNER, OCT_17)).rejects.toThrow(/no count/)
  })
})
