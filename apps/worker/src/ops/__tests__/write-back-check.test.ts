/**
 * The write back check (#2340, phase 10 item 4 of #1689), against injected
 * ports: on the connection_check sweep's interval the ops tick asks each ops
 * connection's ConnectionTokenObject whether it holds a login the row has not
 * taken, and lists each one pending past WRITE_BACK_PENDING_PAGE_MS for the
 * bidding Worker to page. The object's own answer is proven in workerd
 * (connection-token-object.workers.test.ts); these prove the judgement: what
 * is due, what is unknown and never quiet, and that with no ops connection
 * (today) nothing is asked and nothing is due.
 *
 * Every clock is injected (L524): the Worker clock is a constant, and the
 * deadline is a sleep the test controls.
 */
import { describe, expect, it } from 'vitest'
import { MAX_REPORT_WRITE_BACKS, OPS_TICK_PROBLEM_RULES, problemRuleOf } from '../../lib/ops-gateway-contract'
import { WRITE_BACK_RETRY_MAX_MS, WRITE_BACK_RETRY_MIN_MS } from '../connection-token-object'
import { CONNECTION_CHECK_EVERY_SECONDS } from '../connection-check'
import { organizationIdFrom } from '../ops-db'
import type { ConnectionCheckTarget } from '../ops-writes'
import {
  WRITE_BACK_PENDING_PAGE_MS, WRITE_BACK_READ_DEADLINE_MS, WRITE_BACK_START_BUDGET_MS, runWriteBackCheck, writeBackAttemptsBy, type WriteBackCheckDeps,
} from '../write-back-check'

const ORG = organizationIdFrom('6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60')
const OTHER_ORG = organizationIdFrom('7a2d3c9f-1e4b-4d2f-8b66-2c3d4e5f6071')
const CONN_A = '00000000-0000-4000-8000-0000000c2341'
const CONN_B = '00000000-0000-4000-8000-0000000c2342'
const NOW = Date.parse('2026-10-19T18:00:05.000Z')
const MIN = 60_000

function target(over: Partial<ConnectionCheckTarget> = {}): ConnectionCheckTarget {
  return {
    organizationId: ORG, connectionId: CONN_A, service: 'google_user', generation: 2, target: null, publicConfig: {}, servable: true, status: 'healthy',
    lastCheckOkAt: null, lastCheckFailedAt: null, needsReauthAt: null, needsReauthCause: null, refreshFailures: 0, refreshFailingSince: null,
    measuredIdentity: null, dbNow: '2026-10-19T18:00:00.000Z', ...over,
  }
}

const pending = (sinceMs: number | null, attempts = 6) => ({ ok: true, state: 'pending', pendingSinceMs: sinceMs, attempts })

function harness(answers: Record<string, unknown> = {}, opts: { now?: () => number; expire?: boolean } = {}) {
  const asked: Array<Record<string, unknown>> = []
  const deps: WriteBackCheckDeps = {
    read: async (t) => {
      asked.push({ organizationId: t.organizationId, connectionId: t.connectionId, service: t.service })
      const a = Object.hasOwn(answers, t.connectionId) ? answers[t.connectionId] : { ok: true, state: 'none' }
      if (a instanceof Error) throw a
      return a
    },
    now: opts.now ?? (() => NOW),
    // A deadline that ends at once when expire is set, and never otherwise.
    sleep: (ms) => (opts.expire && ms === WRITE_BACK_READ_DEADLINE_MS ? Promise.resolve() : new Promise<void>(() => undefined)),
  }
  return { deps, asked }
}

const read = (targets: ConnectionCheckTarget[], reachedLimit = false) => ({ targets, reachedLimit })

describe('the bound', () => {
  it('pages a write back pending 30 minutes: by then six tries have failed and the retry has reached its 15 minute ceiling, so it is no blip', () => {
    expect(WRITE_BACK_PENDING_PAGE_MS).toBe(30 * MIN)
    // Tries at 0, 0.5, 1.5, 3.5, 7.5 and 15.5 minutes; the seventh at 30.5.
    expect(writeBackAttemptsBy(WRITE_BACK_PENDING_PAGE_MS)).toBe(6)
    expect(WRITE_BACK_RETRY_MIN_MS * 2 ** (writeBackAttemptsBy(WRITE_BACK_PENDING_PAGE_MS) - 1)).toBeGreaterThanOrEqual(WRITE_BACK_RETRY_MAX_MS)
    // A blip of a deploy's length (a few minutes) is retried well inside it.
    expect(writeBackAttemptsBy(5 * MIN)).toBe(4)
  })

  it('is read on the connection check\'s interval, so a write back is paged by 30 to 46 minutes pending', () => {
    expect(CONNECTION_CHECK_EVERY_SECONDS * 1000).toBeLessThan(WRITE_BACK_PENDING_PAGE_MS)
  })

  it('bounds each read and starts none past its budget, inside the minute the tick rides', () => {
    expect(WRITE_BACK_START_BUDGET_MS + WRITE_BACK_READ_DEADLINE_MS).toBeLessThan(60_000)
  })
})

describe('runWriteBackCheck', () => {
  it('with no ops connection (today), asks no object, and reports a complete list of nothing pending', async () => {
    const h = harness()
    const out = await runWriteBackCheck(h.deps, read([]))
    expect(h.asked).toEqual([])
    expect(out.report).toEqual({ complete: true, pending: [] })
    expect(out.problems).toEqual([])
  })

  it('asks each connection\'s object about that connection, and lists nothing for none, landed or a write back younger than the bound', async () => {
    const h = harness({ [CONN_A]: { ok: true, state: 'landed' }, [CONN_B]: pending(NOW - 29 * MIN, 5) })
    const out = await runWriteBackCheck(h.deps, read([target(), target({ connectionId: CONN_B, organizationId: OTHER_ORG, service: 'microsoft_user' })]))
    expect(h.asked).toEqual([
      { organizationId: ORG, connectionId: CONN_A, service: 'google_user' },
      { organizationId: OTHER_ORG, connectionId: CONN_B, service: 'microsoft_user' },
    ])
    expect(out.report).toEqual({ complete: true, pending: [] })
    expect(out.problems).toEqual([])
    expect(out.counts).toMatchObject({ write_backs_asked: 2, write_backs_landed: 1, write_backs_pending_young: 1 })
  })

  it('lists a write back pending past the bound with its connection, organization, service, time and tries', async () => {
    const h = harness({ [CONN_A]: pending(NOW - 31 * MIN, 6) })
    const out = await runWriteBackCheck(h.deps, read([target()]))
    expect(out.report).toEqual({
      complete: true,
      pending: [{ organization_id: ORG, connection_id: CONN_A, service: 'google_user', since: new Date(NOW - 31 * MIN).toISOString(), attempts: 6 }],
    })
    expect(out.problems).toEqual([])
  })

  it('lists one pending since a time the object never recorded (stored before the time was kept) at once, as unknown, never as fresh', async () => {
    const h = harness({ [CONN_A]: pending(null, 2) })
    const out = await runWriteBackCheck(h.deps, read([target()]))
    expect(out.report.pending).toEqual([{ organization_id: ORG, connection_id: CONN_A, service: 'google_user', since: null, attempts: 2 }])
  })

  it('asks the object of a connection past its serve window or in needs_reauth too: bidding being down is when a write back stays pending', async () => {
    const h = harness({ [CONN_A]: pending(NOW - 45 * MIN), [CONN_B]: pending(NOW - 45 * MIN) })
    const out = await runWriteBackCheck(h.deps, read([target({ servable: false }), target({ connectionId: CONN_B, status: 'needs_reauth' })]))
    expect(out.report.pending.map((p) => p.connection_id)).toEqual([CONN_A, CONN_B])
  })

  describe('an object that cannot say is unknown: never nothing pending, and paged', () => {
    it.each([
      ['an object that cannot be reached', new Error('the CONNECTION_TOKENS binding is missing from this deploy')],
      ['an object that answered failed', { ok: false, reason: 'failed' }],
      ['an object that refused the read', { ok: false, reason: 'refused' }],
      ['an answer this code cannot read', { ok: true, state: 'perhaps' }],
      ['an answer in a state this code does not know, however well formed', { ok: true, state: 'perhaps', pendingSinceMs: NOW - 40 * MIN, attempts: 1 }],
    ])('%s', async (_what, answer) => {
      const h = harness({ [CONN_A]: answer, [CONN_B]: pending(NOW - 40 * MIN) })
      const out = await runWriteBackCheck(h.deps, read([target(), target({ connectionId: CONN_B })]))
      // The list is not complete, so no all clear is sent for any connection; the one that answered still pages.
      expect(out.report.complete).toBe(false)
      expect(out.report.pending.map((p) => p.connection_id)).toEqual([CONN_B])
      expect(out.problems.map((p) => p.key)).toEqual([`write_back_unreadable:${CONN_A}`])
      expect(problemRuleOf(out.problems[0].key)).toBe('at_once')
      expect(out.problems[0].text).toMatch(/google_user connection/)
      expect(out.problems[0].text).toMatch(/not known/)
    })

    it('an object that does not answer within its deadline', async () => {
      const h = harness({}, { expire: true })
      h.deps.read = () => new Promise(() => undefined)
      const out = await runWriteBackCheck(h.deps, read([target()]))
      expect(out.report.complete).toBe(false)
      expect(out.problems[0].text).toMatch(/did not answer within 10 seconds/)
    })

    it('one not asked because the read\'s budget was spent', async () => {
      let t = NOW
      const h = harness({ [CONN_A]: pending(NOW - 40 * MIN) }, { now: () => t })
      const inner = h.deps.read
      h.deps.read = async (x) => { const a = await inner(x); t += WRITE_BACK_START_BUDGET_MS; return a }
      const out = await runWriteBackCheck({ ...h.deps, concurrency: 1 }, read([target(), target({ connectionId: CONN_B })]))
      expect(h.asked.map((a) => a.connectionId)).toEqual([CONN_A])
      expect(out.report.complete).toBe(false)
      expect(out.problems.map((p) => p.key)).toEqual([`write_back_unreadable:${CONN_B}`])
      expect(out.counts.write_backs_deferred).toBe(1)
    })
  })

  it('a list that reached its read limit is not complete, and says so', async () => {
    const h = harness()
    const out = await runWriteBackCheck(h.deps, read([target()], true))
    expect(out.report.complete).toBe(false)
    expect(out.problems.map((p) => p.key)).toEqual(['write_back_limit'])
  })

  it('more due than one report carries is not complete, and the rest are said to be left out', async () => {
    const ids = Array.from({ length: MAX_REPORT_WRITE_BACKS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const answers = Object.fromEntries(ids.map((id) => [id, pending(NOW - 60 * MIN)]))
    const h = harness(answers)
    const out = await runWriteBackCheck(h.deps, read(ids.map((id) => target({ connectionId: id }))))
    expect(out.report.pending).toHaveLength(MAX_REPORT_WRITE_BACKS)
    expect(out.report.complete).toBe(false)
    expect(out.problems.map((p) => p.key)).toEqual(['write_back_limit'])
  })

  it('names every kind it reports, each paged at once: it runs on the sweep\'s interval, so no kind can be reported by three ticks in a row', () => {
    expect(OPS_TICK_PROBLEM_RULES.write_back_unreadable).toBe('at_once')
    expect(OPS_TICK_PROBLEM_RULES.write_back_limit).toBe('at_once')
    expect(OPS_TICK_PROBLEM_RULES.write_back_check_failed).toBe('at_once')
  })
})
