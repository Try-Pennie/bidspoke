/**
 * The sf_limits sweep (#2336, phase 6 of #1689), against injected ports.
 *
 * The list of measured orgs is proven against a real Postgres in
 * supabase-ops/supabase/tests/sf_limits_targets.test.sql, and the read itself
 * goes through connectionFetch, proven in connections/__tests__. These prove the
 * sweep's own rules: each measured org's /limits DailyApiRequests is written as
 * that org's reading, source limits; a body that cannot be read is a named
 * refusal and never a NaN (L50); each org is its own failure boundary; a
 * refusal that a later read will meet again pages at once, while a failure the
 * next read may not meet is held until the org's reading is going stale; and a
 * stamp the gateway refuses never stops the sweep (the heartbeat on the bidding
 * Worker is what catches a sweep that stops stamping).
 *
 * Every clock is injected (L524): the database clock comes with each target, the
 * Worker clock is a constant, and the deadlines are a sleep the test controls.
 */
import { describe, expect, it } from 'vitest'
import { OPS_TICK_PROBLEM_RULES, problemRuleOf, type OpsJobReport } from '../../lib/ops-gateway-contract'
import { ConnectionRefusal, CONNECTION_REFUSAL_CODES, RequeueAt } from '../connections/refusals'
import { organizationIdFrom } from '../ops-db'
import type { SfLimitsTarget } from '../ops-writes'
import {
  SF_LIMITS_EVERY_SECONDS, SF_LIMITS_HOLD_WHILE_YOUNGER_MS, SF_LIMITS_MAX_ORGS, SF_LIMITS_ORG_DEADLINE_MS, SF_LIMITS_REFUSAL_KINDS,
  parseDailyApiRequests, runSfLimitsSweep, sfLimitsUrl, type SfLimitsSweepDeps,
} from '../sf-limits'

const ORG = organizationIdFrom('6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60')
const SF_ONE = '00Dst0000000001AAA'
const SF_TWO = '00Dst0000000002AAA'
const DB_NOW = '2026-10-19T18:00:00.000Z'
const WORKER_NOW = Date.parse('2026-10-19T18:00:05.000Z')
const minutesBefore = (m: number) => new Date(Date.parse(DB_NOW) - m * 60_000).toISOString()

function target(over: Partial<SfLimitsTarget> = {}): SfLimitsTarget {
  return {
    sfOrgId: SF_ONE,
    organizationId: ORG,
    connectionId: '00000000-0000-4000-8000-0000000051a2',
    generation: 2,
    target: { instance_url: 'https://example.my.salesforce.com', client_id: 'plain-client' },
    // The last sweep's reading, four minutes ago.
    readingMeasuredAt: minutesBefore(4),
    dbNow: DB_NOW,
    ...over,
  }
}

const limitsBody = (daily: unknown = { Max: 1_680_000, Remaining: 1_205_253 }) => ({
  ActiveScratchOrgs: { Max: 3, Remaining: 3 },
  DailyApiRequests: daily,
  DailyAsyncApexExecutions: { Max: 250000, Remaining: 250000 },
})

type Read = (t: SfLimitsTarget, url: string) => Promise<Response | RequeueAt>

interface Harness {
  deps: SfLimitsSweepDeps
  reads: Array<{ sfOrgId: string; url: string }>
  recorded: Array<{ sfOrgId: string; dailyApiMax: number; dailyApiRemaining: number }>
  stamps: string[]
  reports: OpsJobReport[]
  logs: Array<Record<string, unknown>>
}

function harness(opts: {
  targets?: SfLimitsTarget[] | Error
  reachedLimit?: boolean
  read?: Read
  recordFails?: boolean
  startFails?: boolean
  completeFails?: boolean
  /** A sleep that resolves at once for the deadlines named, and never for any other. */
  expire?: number[]
} = {}): Harness {
  const reads: Harness['reads'] = []
  const recorded: Harness['recorded'] = []
  const stamps: string[] = []
  const reports: OpsJobReport[] = []
  const logs: Array<Record<string, unknown>> = []
  const deps: SfLimitsSweepDeps = {
    targets: async (limit) => {
      expect(limit).toBe(SF_LIMITS_MAX_ORGS)
      if (opts.targets instanceof Error) throw opts.targets
      return { targets: opts.targets ?? [target()], reachedLimit: opts.reachedLimit ?? false }
    },
    read: async (t, url) => {
      reads.push({ sfOrgId: t.sfOrgId, url })
      return (opts.read ?? (async () => Response.json(limitsBody())))(t, url)
    },
    record: async (sfOrgId, reading) => {
      if (opts.recordFails) throw new Error('record_sf_budget_reading did not answer within 9 s')
      recorded.push({ sfOrgId, ...reading })
      return 'recorded'
    },
    started: async () => { stamps.push('started'); if (opts.startFails) throw new Error('the bidding Worker\'s heartbeat did not answer within 15 s') },
    completed: async (report) => { stamps.push('completed'); reports.push(report); if (opts.completeFails) throw new Error('the gateway is not deployed') },
    now: () => WORKER_NOW,
    sleep: (ms) => (opts.expire?.includes(ms) ? Promise.resolve() : new Promise<void>(() => undefined)),
    log: (fields) => { logs.push(fields) },
  }
  return { deps, reads, recorded, stamps, reports, logs }
}

describe('the interval', () => {
  it('claims every 4 minutes, so a reading is renewed every 4 to 5 minutes, inside the 5 a floor refusal waits and well inside the 15 a reading is fresh for', () => {
    expect(SF_LIMITS_EVERY_SECONDS).toBe(240)
    expect(SF_LIMITS_EVERY_SECONDS).toBeLessThanOrEqual(5 * 60)
  })

  it('holds a transient failure only while the reading is younger than one renewal plus a missed tick, so a second failure in a row pages', () => {
    // One renewal is at most 5 minutes, 6 with a missed tick; two are at least 8.
    expect(SF_LIMITS_HOLD_WHILE_YOUNGER_MS).toBeGreaterThan(6 * 60_000)
    expect(SF_LIMITS_HOLD_WHILE_YOUNGER_MS).toBeLessThan(2 * SF_LIMITS_EVERY_SECONDS * 1000)
  })
})

describe('parseDailyApiRequests (the /limits body, REST API Developer Guide v68.0, "Limits")', () => {
  it('reads Max and Remaining of DailyApiRequests and nothing else', () => {
    expect(parseDailyApiRequests(limitsBody())).toEqual({ ok: true, max: 1_680_000, remaining: 1_205_253 })
  })

  it('keeps a Remaining below zero, an org past its allocation, which the floor must see', () => {
    expect(parseDailyApiRequests(limitsBody({ Max: 5000, Remaining: -12 }))).toEqual({ ok: true, max: 5000, remaining: -12 })
  })

  it.each([
    ['the body is not an object', [1, 2], 'not_an_object'],
    ['the body is null', null, 'not_an_object'],
    ['DailyApiRequests is absent', { ActiveScratchOrgs: { Max: 3, Remaining: 3 } }, 'no_daily_api_requests'],
    ['DailyApiRequests is not an object', limitsBody(5000), 'no_daily_api_requests'],
    ['Max is missing', limitsBody({ Remaining: 10 }), 'not_whole'],
    ['Remaining is a string', limitsBody({ Max: 5000, Remaining: '4937' }), 'not_whole'],
    ['Remaining is a fraction', limitsBody({ Max: 5000, Remaining: 49.5 }), 'not_whole'],
    ['Max is past the integer column', limitsBody({ Max: 2_147_483_648, Remaining: 1 }), 'out_of_range'],
    ['Remaining is past the integer column below zero', limitsBody({ Max: 5000, Remaining: -2_147_483_649 }), 'out_of_range'],
    ['Max is zero', limitsBody({ Max: 0, Remaining: 0 }), 'max_not_positive'],
    ['Remaining is above Max', limitsBody({ Max: 5000, Remaining: 5001 }), 'remaining_above_max'],
  ])('refuses by name when %s, never answering a NaN (L50)', (_label, body, refusal) => {
    expect(parseDailyApiRequests(body)).toEqual({ ok: false, refusal })
  })
})

describe('sfLimitsUrl', () => {
  it('is the Limits resource of the connection\'s declared instance', () => {
    expect(sfLimitsUrl({ instance_url: 'https://example.my.salesforce.com/', client_id: 'plain-client' })).toBe('https://example.my.salesforce.com/services/data/v60.0/limits')
  })

  it('refuses a target that does not declare a Salesforce instance, by name', () => {
    expect(() => sfLimitsUrl({ instance_url: 'https://example.com' })).toThrow(ConnectionRefusal)
    expect(() => sfLimitsUrl(null)).toThrow(/connection_target_invalid/)
  })
})

describe('the sweep', () => {
  it('with no measured org (today), stamps both ends, reads nothing and reports nothing', async () => {
    const h = harness({ targets: [] })
    const out = await runSfLimitsSweep(h.deps)
    expect(out.problems).toEqual([])
    expect(h.reads).toEqual([])
    expect(h.stamps).toEqual(['started', 'completed'])
    expect(h.reports[0]).toEqual({ started_at: new Date(WORKER_NOW).toISOString(), finished_at: new Date(WORKER_NOW).toISOString(), counts: { sf_limits_orgs: 0 } })
  })

  it('writes each measured org\'s daily API remaining as its reading, from the body, keyed on the measured org', async () => {
    const h = harness({
      targets: [target(), target({ sfOrgId: SF_TWO, connectionId: '00000000-0000-4000-8000-0000000051a8' })],
      read: async (t) => Response.json(limitsBody(t.sfOrgId === SF_TWO ? { Max: 15000, Remaining: 14000 } : undefined)),
    })
    const out = await runSfLimitsSweep(h.deps)
    expect(out.problems).toEqual([])
    expect(h.reads.map((r) => r.url)).toEqual(['https://example.my.salesforce.com/services/data/v60.0/limits', 'https://example.my.salesforce.com/services/data/v60.0/limits'])
    expect(h.recorded).toEqual([
      { sfOrgId: SF_ONE, dailyApiMax: 1_680_000, dailyApiRemaining: 1_205_253 },
      { sfOrgId: SF_TWO, dailyApiMax: 15000, dailyApiRemaining: 14000 },
    ])
    expect(out.counts).toEqual({ sf_limits_orgs: 2, sf_limits_recorded: 2 })
    expect(h.reports[0].counts).toEqual(out.counts)
  })

  it('reports a malformed DailyApiRequests by name and records nothing for that org, while the other org is recorded', async () => {
    const h = harness({
      targets: [target(), target({ sfOrgId: SF_TWO })],
      read: async (t) => Response.json(limitsBody(t.sfOrgId === SF_ONE ? { Max: 5000 } : undefined)),
    })
    const out = await runSfLimitsSweep(h.deps)
    expect(h.recorded.map((r) => r.sfOrgId)).toEqual([SF_TWO])
    expect(out.problems.map((p) => p.key)).toEqual([`sf_limits_unreadable:${SF_ONE}`])
    expect(out.problems[0].text).toMatch(/not_whole/)
    expect(out.problems[0].text).not.toMatch(/NaN/)
  })

  it.each([
    ['a body that is not JSON', () => new Response('<html>maintenance</html>', { status: 200 }), 'not_json'],
    ['a body past the size a limits answer has', () => new Response(`{"x":"${'a'.repeat(1_100_000)}"}`, { status: 200 }), 'too_large'],
  ])('reports %s as unreadable by name', async (_label, answer, refusal) => {
    const h = harness({ read: async () => answer() })
    const out = await runSfLimitsSweep(h.deps)
    expect(out.problems.map((p) => p.key)).toEqual([`sf_limits_unreadable:${SF_ONE}`])
    expect(out.problems[0].text).toContain(refusal)
    expect(h.recorded).toEqual([])
  })

  it('pages at once a read the org refused, which the next read will meet again (a user without View Setup and Configuration answers 403)', async () => {
    const h = harness({ read: async () => new Response('[{"errorCode":"INSUFFICIENT_ACCESS"}]', { status: 403 }) })
    const out = await runSfLimitsSweep(h.deps)
    expect(out.problems.map((p) => p.key)).toEqual([`sf_limits_refused:${SF_ONE}`])
    expect(out.problems[0].text).toMatch(/http_403/)
    expect(problemRuleOf(out.problems[0].key)).toBe('at_once')
  })

  it('pages at once a refusal connectionFetch names that waiting will not change', async () => {
    const h = harness({ read: async () => { throw new ConnectionRefusal('sf_cap_unset', 'the ops Salesforce pool answered sf_cap_unset') } })
    const out = await runSfLimitsSweep(h.deps)
    expect(out.problems.map((p) => p.key)).toEqual([`sf_limits_refused:${SF_ONE}`])
    expect(out.problems[0].text).toMatch(/sf_cap_unset/)
  })

  it('pages a read that fails without a named refusal by the error\'s name alone, never its message', async () => {
    const h = harness({ read: async () => { throw new TypeError('carrying something nobody chose to show') } })
    const out = await runSfLimitsSweep(h.deps)
    expect(out.problems.map((p) => p.key)).toEqual([`sf_limits_refused:${SF_ONE}`])
    expect(out.problems[0].text).toMatch(/TypeError/)
    expect(out.problems[0].text).not.toMatch(/nobody chose/)
  })

  describe('a failure the next read may not meet', () => {
    const transient: Array<[string, Read]> = [
      ['timed out inside connectionFetch', async () => { throw new ConnectionRefusal('connection_timeout', 'the GET request passed connectionFetch\'s deadline') }],
      ['found the pool busy', async () => { throw new ConnectionRefusal('sf_pool_busy', 'the ops Salesforce pool answered purpose_share_full') }],
      ['answered 503', async () => new Response('busy', { status: 503 })],
      ['was rate limited', async () => new RequeueAt(new Date(WORKER_NOW + 60_000), 'rate_limited')],
    ]

    it.each(transient)('is held, logged and counted when it %s while the reading is still young', async (_label, read) => {
      const h = harness({ read })
      const out = await runSfLimitsSweep(h.deps)
      expect(out.problems).toEqual([])
      expect(out.counts.sf_limits_held).toBe(1)
      expect(h.logs).toEqual([expect.objectContaining({ event: 'ops_tick', step: 'sf_limits_held', sf_org_id: SF_ONE })])
    })

    it.each(transient)('pages when it %s again, the reading now older than one renewal', async (_label, read) => {
      const h = harness({ read, targets: [target({ readingMeasuredAt: minutesBefore(8) })] })
      const out = await runSfLimitsSweep(h.deps)
      expect(out.problems.map((p) => p.key)).toEqual([`sf_limits_read_failed:${SF_ONE}`])
      expect(out.problems[0].text).toMatch(/8 minutes old/)
      expect(problemRuleOf(out.problems[0].key)).toBe('at_once')
    })

    it('pages at once for an org with no reading at all, whose every ops call is already refused', async () => {
      const h = harness({ read: transient[0][1], targets: [target({ readingMeasuredAt: null })] })
      const out = await runSfLimitsSweep(h.deps)
      expect(out.problems.map((p) => p.key)).toEqual([`sf_limits_read_failed:${SF_ONE}`])
      expect(out.problems[0].text).toMatch(/has no budget reading/)
    })

    it('holds a reading write the ops database did not take the same way', async () => {
      expect((await runSfLimitsSweep(harness({ recordFails: true }).deps)).counts.sf_limits_held).toBe(1)
      const old = await runSfLimitsSweep(harness({ recordFails: true, targets: [target({ readingMeasuredAt: minutesBefore(9) })] }).deps)
      expect(old.problems.map((p) => p.key)).toEqual([`sf_limits_read_failed:${SF_ONE}`])
      expect(old.problems[0].text).toMatch(/record_failed/)
    })

    it('bounds one org\'s read by its own deadline, so a read that never answers is a failure of that org alone', async () => {
      const h = harness({
        targets: [target({ readingMeasuredAt: minutesBefore(8) }), target({ sfOrgId: SF_TWO })],
        read: (t) => (t.sfOrgId === SF_ONE ? new Promise<Response>(() => undefined) : Promise.resolve(Response.json(limitsBody()))),
        expire: [SF_LIMITS_ORG_DEADLINE_MS],
      })
      const out = await runSfLimitsSweep(h.deps)
      expect(out.problems.map((p) => p.key)).toEqual([`sf_limits_read_failed:${SF_ONE}`])
      expect(out.problems[0].text).toMatch(/deadline/)
      expect(h.recorded.map((r) => r.sfOrgId)).toEqual([SF_TWO])
    })
  })

  it('every refusal code connectionFetch can throw is classified, so a new one is a compile and a test failure', () => {
    expect(Object.keys(SF_LIMITS_REFUSAL_KINDS).sort()).toEqual([...CONNECTION_REFUSAL_CODES].sort())
    expect(SF_LIMITS_REFUSAL_KINDS.connection_timeout).toBe('transient')
    expect(SF_LIMITS_REFUSAL_KINDS.connection_needs_reauth).toBe('refused')
  })

  it('reports a failed read of the measured orgs by name, at once: the sweep is not tried again for 4 minutes', async () => {
    const h = harness({ targets: new Error('sf_limits_targets did not answer within 9 s') })
    const out = await runSfLimitsSweep(h.deps)
    expect(out.problems.map((p) => p.key)).toEqual(['sf_limits_failed'])
    expect(problemRuleOf('sf_limits_failed')).toBe('at_once')
    expect(h.stamps).toEqual(['started', 'completed'])
  })

  it('says so when it reads as many orgs as its limit, so any past it are named rather than skipped in silence', async () => {
    const out = await runSfLimitsSweep(harness({ reachedLimit: true }).deps)
    expect(out.problems.map((p) => p.key)).toEqual(['sf_limits_orgs_limit'])
  })

  it('goes on when the started stamp fails, and counts it, since the heartbeat is what pages a sweep that stops stamping', async () => {
    const h = harness({ startFails: true })
    const out = await runSfLimitsSweep(h.deps)
    expect(h.recorded).toHaveLength(1)
    expect(out.problems).toEqual([])
    expect(out.counts.sf_limits_stamps_failed).toBe(1)
    expect(h.stamps).toEqual(['started', 'completed'])
  })

  it('keeps its result when the completed stamp fails', async () => {
    const out = await runSfLimitsSweep(harness({ completeFails: true }).deps)
    expect(out.counts).toMatchObject({ sf_limits_recorded: 1, sf_limits_stamps_failed: 1 })
  })

  it('names each of its problem kinds in the rules table, so none pages by the unknown kind fallback', () => {
    for (const kind of ['sf_limits_failed', 'sf_limits_orgs_limit', 'sf_limits_refused', 'sf_limits_unreadable', 'sf_limits_read_failed']) {
      expect(Object.hasOwn(OPS_TICK_PROBLEM_RULES, kind), kind).toBe(true)
    }
  })
})
