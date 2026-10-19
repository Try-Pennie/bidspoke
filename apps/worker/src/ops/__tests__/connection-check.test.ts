/**
 * The connection_check sweep and the login states the tick reports (#2340,
 * phase 10 of #1689), against injected ports.
 *
 * The list of connections is proven against a real Postgres in
 * supabase-ops/supabase/tests/connection_check_targets.test.sql, the probe
 * goes through connectionFetch (connections/__tests__) and each service's
 * identity measurement is proven with its service (salesforce-service.test.ts,
 * snowflake-service.test.ts). These prove the sweep's own rules: each servable
 * connection's identity is probed and the result written to the last_check_*
 * columns only; a probe a later one will meet again pages at once, while one
 * the next may not meet is held until the connection's last passing check is
 * older than one interval; a full pool is not a failed check; a login failure
 * is recorded and left to the login page; each connection is its own failure
 * boundary with its own deadline; the connections of one Salesforce org are
 * probed one after another, so the purpose share of 1 is never met by the
 * sweep itself; and a stamp the gateway refuses never stops the sweep.
 *
 * Every clock is injected (L524): the database clock comes with each target,
 * the Worker clock is a constant, and the deadlines are a sleep the test controls.
 */
import { describe, expect, it } from 'vitest'
import { MAX_REPORT_LOGINS, OPS_TICK_PROBLEM_RULES, problemRuleOf, type OpsJobReport } from '../../lib/ops-gateway-contract'
import { ConnectionRefusal, CONNECTION_REFUSAL_CODES, type ConnectionRefusalCode } from '../connections/refusals'
import { IdentityMismatch, IdentityUnreadable, type MeasuredIdentity } from '../connections/identity'
import { organizationIdFrom } from '../ops-db'
import type { ConnectionCheckTarget } from '../ops-writes'
import {
  CONNECTION_CHECK_DEADLINE_MS, CONNECTION_CHECK_EVERY_SECONDS, CONNECTION_CHECK_HOLD_WHILE_YOUNGER_MS, CONNECTION_CHECK_MAX_CONNECTIONS,
  CONNECTION_CHECK_REFUSAL_KINDS, REFRESH_FAILING_PAGE_FAILURES, REFRESH_FAILING_PAGE_SPAN_MS, judgeConnectionLogins, runConnectionCheckSweep,
  type ConnectionCheckSweepDeps, type ProbeAnswer, type ProbeSeen,
} from '../connection-check'

const ORG = organizationIdFrom('6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60')
const OTHER_ORG = organizationIdFrom('7a2d3c9f-1e4b-4d2f-8b66-2c3d4e5f6071')
const CONN_A = '00000000-0000-4000-8000-0000000c2341'
const CONN_B = '00000000-0000-4000-8000-0000000c2342'
const CONN_C = '00000000-0000-4000-8000-0000000c2343'
const SF_ONE = '00Dst0000000001AAA'
const SF_TWO = '00Dst0000000002AAA'
const DB_NOW = '2026-10-19T18:00:00.000Z'
const WORKER_NOW = Date.parse('2026-10-19T18:00:05.000Z')
const minutesBefore = (m: number) => new Date(Date.parse(DB_NOW) - m * 60_000).toISOString()

function target(over: Partial<ConnectionCheckTarget> = {}): ConnectionCheckTarget {
  return {
    organizationId: ORG,
    connectionId: CONN_A,
    service: 'salesforce',
    generation: 2,
    target: { instance_url: 'https://example.my.salesforce.com', client_id: 'plain-client' },
    publicConfig: {},
    servable: true,
    status: 'healthy',
    // The last sweep's passing check, fourteen minutes ago.
    lastCheckOkAt: minutesBefore(14),
    lastCheckFailedAt: null,
    needsReauthAt: null,
    needsReauthCause: null,
    refreshFailures: 0,
    refreshFailingSince: null,
    measuredIdentity: { sfOrgId: SF_ONE, username: 'ops-one@example.com' },
    dbNow: DB_NOW,
    ...over,
  }
}

const sfIdentity = (sfOrgId = SF_ONE, username = 'ops-one@example.com'): MeasuredIdentity => ({ kind: 'salesforce', sfOrgId, username })
const snowflakeTarget = (over: Partial<ConnectionCheckTarget> = {}) => target({
  connectionId: CONN_C, organizationId: OTHER_ORG, service: 'snowflake', target: { account: 'plain-account', user: 'PLAIN_USER' }, measuredIdentity: null, ...over,
})

type Probe = (t: ConnectionCheckTarget, seen: ProbeSeen) => Promise<ProbeAnswer>

interface Harness {
  deps: ConnectionCheckSweepDeps
  probes: string[]
  recorded: Array<{ connectionId: string; result: { ok: true } | { ok: false; cause: string } }>
  stamps: string[]
  reports: OpsJobReport[]
  logs: Array<Record<string, unknown>>
}

function harness(opts: {
  targets?: ConnectionCheckTarget[] | Error
  reachedLimit?: boolean
  probe?: Probe
  recordFails?: boolean
  recordAnswer?: 'recorded' | 'connection_removed'
  startFails?: boolean
  completeFails?: boolean
  /** A sleep that resolves at once for the deadlines named, and never for any other. */
  expire?: number[]
  /** With expire: end only this many of those waits, in call order; the rest never end. */
  expireFirst?: number
} = {}): Harness {
  const probes: string[] = []
  const recorded: Harness['recorded'] = []
  const stamps: string[] = []
  const reports: OpsJobReport[] = []
  const logs: Array<Record<string, unknown>> = []
  let expired = 0
  const deps: ConnectionCheckSweepDeps = {
    targets: async (limit) => {
      expect(limit).toBe(CONNECTION_CHECK_MAX_CONNECTIONS)
      if (opts.targets instanceof Error) throw opts.targets
      return { targets: opts.targets ?? [target()], reachedLimit: opts.reachedLimit ?? false }
    },
    probe: async (t, seen) => {
      probes.push(t.connectionId)
      return (opts.probe ?? (async () => ({ kind: 'measured', identity: sfIdentity() }) as const))(t, seen)
    },
    record: async (t, result) => {
      if (opts.recordFails) throw new Error('record_connection_check did not answer within 9 s')
      recorded.push({ connectionId: t.connectionId, result })
      return opts.recordAnswer ?? 'recorded'
    },
    started: async () => { stamps.push('started'); if (opts.startFails) throw new Error('the bidding Worker\'s heartbeat did not answer within 15 s') },
    completed: async (report) => { stamps.push('completed'); reports.push(report); if (opts.completeFails) throw new Error('the gateway is not deployed') },
    now: () => WORKER_NOW,
    sleep: (ms) => {
      if (!opts.expire?.includes(ms)) return new Promise<void>(() => undefined)
      if (opts.expireFirst !== undefined && expired++ >= opts.expireFirst) return new Promise<void>(() => undefined)
      return Promise.resolve()
    },
    log: (fields) => { logs.push(fields) },
  }
  return { deps, probes, recorded, stamps, reports, logs }
}

const refusing = (code: ConnectionRefusalCode): Probe => async () => { throw new ConnectionRefusal(code, `refused as ${code} with words nobody should see`) }

describe('the interval', () => {
  it('claims every 14 minutes, so a connection is proved every 14 to 15 minutes, 16 with a missed tick', () => {
    expect(CONNECTION_CHECK_EVERY_SECONDS).toBe(14 * 60)
  })

  it('holds a transient failure only while the last passing check is younger than one interval with a missed tick, so a second in a row pages', () => {
    expect(CONNECTION_CHECK_HOLD_WHILE_YOUNGER_MS).toBeGreaterThan(16 * 60_000)
    expect(CONNECTION_CHECK_HOLD_WHILE_YOUNGER_MS).toBeLessThan(2 * CONNECTION_CHECK_EVERY_SECONDS * 1000)
  })

  it('bounds one connection inside the minute the tick rides', () => {
    expect(CONNECTION_CHECK_DEADLINE_MS).toBeLessThan(60_000)
  })
})

describe('the sweep', () => {
  it('with no ops connection (today), stamps both ends, probes nothing, records nothing and reports nothing', async () => {
    const h = harness({ targets: [] })
    const out = await runConnectionCheckSweep(h.deps)
    expect(out.problems).toEqual([])
    expect(h.probes).toEqual([])
    expect(h.recorded).toEqual([])
    expect(h.stamps).toEqual(['started', 'completed'])
    expect(h.reports[0]).toEqual({ started_at: new Date(WORKER_NOW).toISOString(), finished_at: new Date(WORKER_NOW).toISOString(), counts: { connection_check_connections: 0 } })
  })

  it('probes each servable connection\'s identity and records a passing check, the counts in its report', async () => {
    const h = harness({
      targets: [target(), snowflakeTarget()],
      probe: async (t) => (t.service === 'snowflake'
        ? { kind: 'measured', identity: { kind: 'snowflake', accountLocator: 'PL12345', organizationName: null, accountName: null, user: 'PLAIN_USER' } }
        : { kind: 'measured', identity: sfIdentity() }),
    })
    const out = await runConnectionCheckSweep(h.deps)
    expect(out.problems).toEqual([])
    expect(h.recorded).toEqual([{ connectionId: CONN_A, result: { ok: true } }, { connectionId: CONN_C, result: { ok: true } }])
    expect(out.counts).toEqual({ connection_check_connections: 2, connection_check_passed: 2 })
    expect(h.reports[0].counts).toEqual(out.counts)
  })

  it('accepts the measured Salesforce identity in its 15 character form and another case of the username', async () => {
    const h = harness({ probe: async () => ({ kind: 'measured', identity: sfIdentity(SF_ONE.slice(0, 15), 'OPS-ONE@example.com') }) })
    const out = await runConnectionCheckSweep(h.deps)
    expect(out.problems).toEqual([])
    expect(h.recorded).toEqual([{ connectionId: CONN_A, result: { ok: true } }])
  })

  it('probes a connection in refresh_failing, whose login may work again, but not one in needs_reauth or past its serve window', async () => {
    const h = harness({
      targets: [
        target({ status: 'refresh_failing', refreshFailures: 2, refreshFailingSince: minutesBefore(3) }),
        target({ connectionId: CONN_B, status: 'needs_reauth', needsReauthAt: minutesBefore(5), needsReauthCause: 'login_refused: invalid_grant' }),
        target({ connectionId: CONN_C, servable: false }),
      ],
    })
    const out = await runConnectionCheckSweep(h.deps)
    expect(h.probes).toEqual([CONN_A])
    expect(h.recorded.map((r) => r.connectionId)).toEqual([CONN_A])
    expect(out.counts).toMatchObject({ connection_check_passed: 1, connection_check_skipped_reauth: 1, connection_check_not_servable: 1 })
    expect(out.problems).toEqual([])
  })

  it('counts a service with no identity probe on this Worker and records nothing for it', async () => {
    const h = harness({ probe: async () => ({ kind: 'unprobed' }) })
    const out = await runConnectionCheckSweep(h.deps)
    expect(h.recorded).toEqual([])
    expect(out.counts.connection_check_unprobed).toBe(1)
    expect(out.problems).toEqual([])
  })

  describe('a probe the next one will meet again, paged at once', () => {
    it('a Salesforce credential that measures as another identity than verify measured', async () => {
      const h = harness({ probe: async () => ({ kind: 'measured', identity: sfIdentity(SF_TWO, 'somebody@example.com') }) })
      const out = await runConnectionCheckSweep(h.deps)
      expect(out.problems.map((p) => p.key)).toEqual([`connection_check_refused:${CONN_A}`])
      expect(out.problems[0].text).toMatch(/identity_changed/)
      expect(out.problems[0].text).not.toMatch(/somebody/)
      expect(h.recorded).toEqual([{ connectionId: CONN_A, result: { ok: false, cause: 'identity_changed' } }])
    })

    it('a Snowflake credential that authenticates as another user than its target declares', async () => {
      const h = harness({ targets: [snowflakeTarget()], probe: async () => { throw new IdentityMismatch('the credential authenticates as another Snowflake user than its target declares') } })
      const out = await runConnectionCheckSweep(h.deps)
      expect(out.problems.map((p) => p.key)).toEqual([`connection_check_refused:${CONN_C}`])
      expect(h.recorded).toEqual([{ connectionId: CONN_C, result: { ok: false, cause: 'identity_mismatch' } }])
    })

    it('an identity endpoint that answered 403', async () => {
      const h = harness({ probe: async (_t, seen) => { seen.lastStatus = 403; throw new IdentityUnreadable('Salesforce userinfo answered HTTP 403') } })
      const out = await runConnectionCheckSweep(h.deps)
      expect(out.problems.map((p) => p.key)).toEqual([`connection_check_refused:${CONN_A}`])
      expect(h.recorded).toEqual([{ connectionId: CONN_A, result: { ok: false, cause: 'http_403' } }])
      expect(problemRuleOf(out.problems[0].key)).toBe('at_once')
    })

    it('a refusal by rule, named by its code alone, never its message', async () => {
      const h = harness({ probe: refusing('sf_cap_unset') })
      const out = await runConnectionCheckSweep(h.deps)
      expect(out.problems.map((p) => p.key)).toEqual([`connection_check_refused:${CONN_A}`])
      expect(out.problems[0].text).toMatch(/sf_cap_unset/)
      expect(out.problems[0].text).not.toMatch(/nobody should see/)
      expect(h.recorded).toEqual([{ connectionId: CONN_A, result: { ok: false, cause: 'sf_cap_unset' } }])
    })

    it('a probe that fails without a named refusal, by the error\'s name alone', async () => {
      const h = harness({ probe: async () => { throw new TypeError('carrying something nobody chose to show') } })
      const out = await runConnectionCheckSweep(h.deps)
      expect(out.problems.map((p) => p.key)).toEqual([`connection_check_refused:${CONN_A}`])
      expect(out.problems[0].text).toMatch(/TypeError/)
      expect(JSON.stringify([out, h.recorded])).not.toMatch(/nobody chose/)
    })

    it('an identity answer that cannot be read, as unreadable', async () => {
      const h = harness({ probe: async (_t, seen) => { seen.lastStatus = 200; throw new IdentityUnreadable('Salesforce userinfo named no 18 character org id') } })
      const out = await runConnectionCheckSweep(h.deps)
      expect(out.problems.map((p) => p.key)).toEqual([`connection_check_unreadable:${CONN_A}`])
      expect(h.recorded).toEqual([{ connectionId: CONN_A, result: { ok: false, cause: 'identity_unreadable' } }])
    })
  })

  it.each([
    ['refused', 'connection_needs_reauth'],
    ['unavailable, adding to the refresh streak', 'connection_auth_unavailable'],
  ] as const)('records a login that was %s as a failed check and leaves the page to the login state', async (_label, code) => {
    const h = harness({ probe: refusing(code) })
    const out = await runConnectionCheckSweep(h.deps)
    expect(out.problems).toEqual([])
    expect(h.recorded).toEqual([{ connectionId: CONN_A, result: { ok: false, cause: code } }])
    expect(out.counts.connection_check_login_failed).toBe(1)
  })

  it('counts a connection removed between the list and its probe, and reports nothing about it', async () => {
    const h = harness({ probe: refusing('connection_removed') })
    const out = await runConnectionCheckSweep(h.deps)
    expect(out.problems).toEqual([])
    expect(h.recorded).toEqual([])
    expect(out.counts.connection_check_gone).toBe(1)
  })

  describe('a probe the next one may not meet', () => {
    const failed: Array<[string, Probe, string]> = [
      ['timed out inside connectionFetch', refusing('connection_timeout'), 'connection_timeout'],
      ['failed below HTTP', refusing('connection_network_error'), 'connection_network_error'],
      ['answered 503', async (_t, seen) => { seen.lastStatus = 503; throw new IdentityUnreadable('Salesforce userinfo answered HTTP 503') }, 'http_503'],
    ]
    const notRun: Array<[string, Probe]> = [
      ['found the pool busy', refusing('sf_pool_busy')],
      ['found the org below its budget floor', refusing('sf_budget_floor')],
      ['was rate limited', refusing('connection_rate_limited')],
      ['could not read the copy', refusing('connection_copy_unreadable')],
    ]

    it.each(failed)('is recorded as a failed check and held when it %s while the last passing check is young', async (_label, probe, cause) => {
      const h = harness({ probe })
      const out = await runConnectionCheckSweep(h.deps)
      expect(out.problems).toEqual([])
      expect(h.recorded).toEqual([{ connectionId: CONN_A, result: { ok: false, cause } }])
      expect(out.counts.connection_check_held).toBe(1)
      expect(h.logs).toEqual([expect.objectContaining({ event: 'ops_tick', step: 'connection_check_held', connection_id: CONN_A, cause })])
    })

    it.each(notRun)('is not a failed check, records nothing, and is held when it %s while the last passing check is young', async (_label, probe) => {
      const h = harness({ probe })
      const out = await runConnectionCheckSweep(h.deps)
      expect(out.problems).toEqual([])
      expect(h.recorded).toEqual([])
      expect(out.counts).toMatchObject({ connection_check_held: 1, connection_check_not_run: 1 })
    })

    it.each([...failed.map(([l, p]) => [l, p] as const), ...notRun])('pages when it %s and the last passing check is older than one interval', async (_label, probe) => {
      const h = harness({ probe, targets: [target({ lastCheckOkAt: minutesBefore(29) })] })
      const out = await runConnectionCheckSweep(h.deps)
      expect(out.problems.map((p) => p.key)).toEqual([`connection_check_unavailable:${CONN_A}`])
      expect(out.problems[0].text).toMatch(/29 minutes ago/)
      expect(problemRuleOf(out.problems[0].key)).toBe('at_once')
    })

    it('pages at once for a connection that has never passed a check', async () => {
      const h = harness({ probe: refusing('connection_timeout'), targets: [target({ status: 'unchecked', lastCheckOkAt: null })] })
      const out = await runConnectionCheckSweep(h.deps)
      expect(out.problems.map((p) => p.key)).toEqual([`connection_check_unavailable:${CONN_A}`])
      expect(out.problems[0].text).toMatch(/never passed/)
    })

    it('holds a passing probe whose check the ops database did not take the same way', async () => {
      expect((await runConnectionCheckSweep(harness({ recordFails: true }).deps)).counts.connection_check_held).toBe(1)
      const old = await runConnectionCheckSweep(harness({ recordFails: true, targets: [target({ lastCheckOkAt: minutesBefore(30) })] }).deps)
      expect(old.problems.map((p) => p.key)).toEqual([`connection_check_unavailable:${CONN_A}`])
      expect(old.problems[0].text).toMatch(/record_failed/)
    })

    it('bounds one connection by its own deadline, so a probe that never answers is a failure of that connection alone', async () => {
      const h = harness({
        targets: [target({ lastCheckOkAt: minutesBefore(30) }), snowflakeTarget()],
        // The other answers a macrotask later, as a real probe would: only its own deadline may end it.
        probe: (t) => (t.connectionId === CONN_A
          ? new Promise<ProbeAnswer>(() => undefined)
          : new Promise<ProbeAnswer>((r) => setTimeout(() => r({ kind: 'measured', identity: { kind: 'snowflake', accountLocator: 'PL1', organizationName: null, accountName: null, user: 'PLAIN_USER' } }), 0))),
        expire: [CONNECTION_CHECK_DEADLINE_MS],
        expireFirst: 1,
      })
      const out = await runConnectionCheckSweep(h.deps)
      expect(out.problems.map((p) => p.key)).toEqual([`connection_check_unavailable:${CONN_A}`])
      expect(out.problems[0].text).toMatch(/deadline/)
      expect(h.recorded).toHaveLength(2)
      expect(h.recorded).toEqual(expect.arrayContaining([
        { connectionId: CONN_C, result: { ok: true } },
        { connectionId: CONN_A, result: { ok: false, cause: `deadline of ${CONNECTION_CHECK_DEADLINE_MS / 1000} s` } },
      ]))
    })
  })

  it('still reports a refusal whose failed check the ops database did not take, and counts it', async () => {
    const h = harness({ probe: refusing('sf_cap_unset'), recordFails: true })
    const out = await runConnectionCheckSweep(h.deps)
    expect(out.problems.map((p) => p.key)).toEqual([`connection_check_refused:${CONN_A}`])
    expect(out.counts.connection_check_record_failed).toBe(1)
  })

  it('reports nothing about a connection the record says was removed meanwhile', async () => {
    const h = harness({ probe: refusing('sf_cap_unset'), recordAnswer: 'connection_removed' })
    const out = await runConnectionCheckSweep(h.deps)
    expect(out.problems).toEqual([])
    expect(out.counts.connection_check_gone).toBe(1)
  })

  it('probes the connections of one Salesforce org one after another, and those of different orgs at once', async () => {
    const events: string[] = []
    const releases = new Map<string, () => void>()
    const h = harness({
      targets: [target(), target({ connectionId: CONN_B }), target({ connectionId: CONN_C, measuredIdentity: { sfOrgId: SF_TWO, username: 'ops-two@example.com' } })],
      probe: (t) => new Promise<ProbeAnswer>((resolve) => {
        events.push(`start:${t.connectionId}`)
        releases.set(t.connectionId, () => {
          events.push(`end:${t.connectionId}`)
          resolve({ kind: 'measured', identity: t.connectionId === CONN_C ? sfIdentity(SF_TWO, 'ops-two@example.com') : sfIdentity() })
        })
      }),
    })
    const done = runConnectionCheckSweep(h.deps)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    // A and C (different orgs) are out together; B waits for A, its org's other connection.
    expect(events).toEqual([`start:${CONN_A}`, `start:${CONN_C}`])
    releases.get(CONN_A)!()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(events).toContain(`start:${CONN_B}`)
    expect(events.indexOf(`start:${CONN_B}`)).toBeGreaterThan(events.indexOf(`end:${CONN_A}`))
    releases.get(CONN_B)!()
    releases.get(CONN_C)!()
    const out = await done
    expect(out.counts.connection_check_passed).toBe(3)
  })

  it('every refusal code connectionFetch can throw is classified, so a new one is a compile and a test failure', () => {
    expect(Object.keys(CONNECTION_CHECK_REFUSAL_KINDS).sort()).toEqual([...CONNECTION_REFUSAL_CODES].sort())
    // A full pool or a budget refusal is not a failed check (Dan, #2340).
    expect(CONNECTION_CHECK_REFUSAL_KINDS.sf_pool_busy).toBe('not_run')
    expect(CONNECTION_CHECK_REFUSAL_KINDS.sf_budget_floor).toBe('not_run')
    expect(CONNECTION_CHECK_REFUSAL_KINDS.connection_needs_reauth).toBe('login')
    expect(CONNECTION_CHECK_REFUSAL_KINDS.connection_timeout).toBe('failed')
  })

  it('reports a failed read of the connections by name, at once: the sweep is not tried again for 14 minutes', async () => {
    const h = harness({ targets: new Error('connection_check_targets did not answer within 9 s') })
    const out = await runConnectionCheckSweep(h.deps)
    expect(out.problems.map((p) => p.key)).toEqual(['connection_check_failed'])
    expect(problemRuleOf('connection_check_failed')).toBe('at_once')
    expect(h.stamps).toEqual(['started', 'completed'])
  })

  it('says so when it reads as many connections as its limit, so any past it are named rather than skipped in silence', async () => {
    const out = await runConnectionCheckSweep(harness({ reachedLimit: true }).deps)
    expect(out.problems.map((p) => p.key)).toEqual(['connection_check_limit'])
  })

  it('goes on when the started stamp fails, and counts it, since the heartbeat is what pages a sweep that stops stamping', async () => {
    const h = harness({ startFails: true })
    const out = await runConnectionCheckSweep(h.deps)
    expect(h.recorded).toHaveLength(1)
    expect(out.problems).toEqual([])
    expect(out.counts.connection_check_stamps_failed).toBe(1)
    expect(h.stamps).toEqual(['started', 'completed'])
  })

  it('keeps its result when the completed stamp fails', async () => {
    const out = await runConnectionCheckSweep(harness({ completeFails: true }).deps)
    expect(out.counts).toMatchObject({ connection_check_passed: 1, connection_check_stamps_failed: 1 })
  })

  it('names each of its problem kinds in the rules table, so none pages by the unknown kind fallback', () => {
    for (const kind of ['connection_check_failed', 'connection_check_limit', 'connection_check_refused', 'connection_check_unreadable', 'connection_check_unavailable']) {
      expect(OPS_TICK_PROBLEM_RULES[kind as keyof typeof OPS_TICK_PROBLEM_RULES], kind).toBe('at_once')
    }
  })
})

describe('judgeConnectionLogins (the login states the tick reports every minute)', () => {
  const read = (targets: ConnectionCheckTarget[], reachedLimit = false) => ({ targets, reachedLimit })

  it('with no ops connection (today), reports a complete list of nothing', () => {
    expect(judgeConnectionLogins(read([]))).toEqual({ complete: true, logins: [] })
  })

  it.each([
    ['login_refused: invalid_grant', 'login_refused'],
    ['request_refused_after_renew', 'refused_after_renew'],
    ['refresh_failing_exhausted: token_endpoint_5xx', 'refresh_exhausted'],
    ['something an older release wrote', 'other'],
  ])('lists a connection in needs_reauth at once, its cause %s read as %s and never forwarded', (cause, reason) => {
    const out = judgeConnectionLogins(read([target({ status: 'needs_reauth', needsReauthAt: minutesBefore(1), needsReauthCause: cause })]))
    expect(out).toEqual({
      complete: true,
      logins: [{ organization_id: ORG, connection_id: CONN_A, service: 'salesforce', state: 'needs_reauth', reason, since: minutesBefore(1), failures: null }],
    })
    expect(JSON.stringify(out)).not.toContain(cause.includes(':') ? cause.split(':')[1].trim() : cause)
  })

  it('lists one in needs_reauth even while its copy is past its serve window, so bidding being down does not read as cleared', () => {
    expect(judgeConnectionLogins(read([target({ servable: false, status: 'needs_reauth', needsReauthAt: minutesBefore(1), needsReauthCause: 'login_refused: x' })])).logins).toHaveLength(1)
  })

  it('lists refresh_failing only once decision 2\'s bound is met: the failures and the age of the first, on the database clock', () => {
    const failing = (failures: number, startedMinutesAgo: number) => target({ status: 'refresh_failing', refreshFailures: failures, refreshFailingSince: minutesBefore(startedMinutesAgo) })
    const spanMinutes = REFRESH_FAILING_PAGE_SPAN_MS / 60_000
    expect(judgeConnectionLogins(read([failing(REFRESH_FAILING_PAGE_FAILURES, spanMinutes)])).logins).toEqual([
      { organization_id: ORG, connection_id: CONN_A, service: 'salesforce', state: 'refresh_failing', reason: null, since: minutesBefore(spanMinutes), failures: REFRESH_FAILING_PAGE_FAILURES },
    ])
    // One failure short, however old: Dan's decision 2 holds both bounds.
    expect(judgeConnectionLogins(read([failing(REFRESH_FAILING_PAGE_FAILURES - 1, 120)])).logins).toEqual([])
    // Enough failures in a burst, but the first is not yet old enough.
    expect(judgeConnectionLogins(read([failing(12, spanMinutes - 1)])).logins).toEqual([])
  })

  it('judges a streak whose start cannot be read as old, the side that pages (L50)', () => {
    expect(judgeConnectionLogins(read([target({ status: 'refresh_failing', refreshFailures: 5, refreshFailingSince: 'not a time' })])).logins).toHaveLength(1)
  })

  it('lists no other status', () => {
    for (const status of ['healthy', 'check_failing', 'unchecked', 'a status from a later release']) {
      expect(judgeConnectionLogins(read([target({ status })])).logins, status).toEqual([])
    }
  })

  it('says the list is not complete when the read reached its limit, so no all clear is sent for a connection past it', () => {
    expect(judgeConnectionLogins(read([target()], true)).complete).toBe(false)
  })

  it('carries at most the report\'s limit and then says it is not complete', () => {
    const many = Array.from({ length: MAX_REPORT_LOGINS + 1 }, (_, i) => target({
      connectionId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, status: 'needs_reauth', needsReauthAt: minutesBefore(1), needsReauthCause: 'login_refused: x',
    }))
    const out = judgeConnectionLogins(read(many))
    expect(out.logins).toHaveLength(MAX_REPORT_LOGINS)
    expect(out.complete).toBe(false)
  })
})
