/**
 * The ops tick's problem keys and the rule each kind pages by (#2506, Dan's
 * decision 2026-10-19): a problem a passing tick would clear pages only once
 * three ticks in a row report it; a problem no later tick can report again, or
 * one that is not transient, pages at once. The table is written out here, so
 * moving a kind from one rule to the other is a visible change to this file.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_REPORT_LOGINS, MAX_REPORT_PROBLEMS, MAX_REPORT_WRITE_BACKS, OPS_TICK_PROBLEM_RULES, OPS_TICK_PROBLEM_SWEEPS, capTickProblems, parseOpsTickReport,
  problemRuleOf, sweepOfProblemKey, tickProblem,
} from '../ops-gateway-contract'
import { OPS_SWEEPS } from '../../ops/run-vocabulary'

const THREE_IN_A_ROW = [
  'start_stamp', 'db_clock', 'sweep_claim_failed', 'sweep_failed', 'workflows_fetch_failed', 'workflows_save_failed',
  'copies_read_failed', 'schedule_plan_failed', 'claim_depth_failed', 'probe_failed', 'connections_fetch_failed',
  'connections_save_failed', 'tombstone_record_failed', 'problems_left_out',
  // The login states (#2340), read every tick, so the next tick asks again.
  'connection_logins_failed',
  // The sf_limits sweep's passing failure while the org's reading is still
  // young (#2340): three runs of the sweep in a row, not three ticks.
  'sf_limits_read_failing',
]
const AT_ONCE = [
  'db_not_configured', 'not_configured', 'secrets_unchecked', 'agreement_check_failed', 'queue_disagreement', 'workflow_refused',
  'workflows_too_many', 'copies_read_limit', 'schedule_refused', 'schedule_no_version', 'slot_missed', 'dispatch_failed',
  'connections_list_unreadable', 'connection_refused', 'connections_too_many', 'connection_copies_expired', 'connections_step_failed',
  'report_unreadable', 'unkeyed',
  // The sf_limits sweep (#2336), judged by its runs (#2340); its passing failure while the reading is young is sf_limits_read_failing, above.
  'sf_limits_failed', 'sf_limits_orgs_limit', 'sf_limits_refused', 'sf_limits_unreadable', 'sf_limits_read_failed',
  // The connection_check sweep (#2340): it runs every fourteenth tick, so the same holds.
  'connection_check_failed', 'connection_check_limit', 'connection_check_refused', 'connection_check_unreadable', 'connection_check_unavailable',
  'connection_logins_limit',
  // The write back check (#2340 phase 10 item 4): it rides the connection_check sweep's interval, so the same holds.
  'write_back_unreadable', 'write_back_limit', 'write_back_check_failed',
]

describe('the rule each kind of tick problem pages by', () => {
  it('holds every transient kind for three ticks in a row and pages every other kind at once', () => {
    const rules = OPS_TICK_PROBLEM_RULES as Record<string, string>
    expect(Object.keys(rules).filter((k) => rules[k] === 'three_in_a_row').sort()).toEqual([...THREE_IN_A_ROW].sort())
    expect(Object.keys(rules).filter((k) => rules[k] === 'at_once').sort()).toEqual([...AT_ONCE].sort())
  })

  it('reads the kind before the subject', () => {
    expect(problemRuleOf('sweep_failed:run_expiry')).toBe('three_in_a_row')
    expect(problemRuleOf('slot_missed:00000000-0000-4000-8000-0000000019a1')).toBe('at_once')
    expect(problemRuleOf('not_configured:OPS_CONNECTIONS_PRIVATE_KEY')).toBe('at_once')
  })

  // A kind this Worker has no rule for comes from an ops release newer than it,
  // and holding it could hold a problem that never repeats for ever (L50).
  it('pages a kind it has no rule for at once', () => {
    expect(problemRuleOf('a_kind_from_a_newer_release')).toBe('at_once')
    expect(problemRuleOf('')).toBe('at_once')
    expect(problemRuleOf('toString')).toBe('at_once')
  })

  it('keys a problem by its kind and subject, never its sentence', () => {
    expect(tickProblem('sweep_failed', 'The run_expiry sweep failed: claim_ops_sweep passed its 9000 ms deadline.', 'run_expiry'))
      .toEqual({ key: 'sweep_failed:run_expiry', text: 'The run_expiry sweep failed: claim_ops_sweep passed its 9000 ms deadline.' })
    expect(tickProblem('db_clock', 'The ops tick could not read the database clock.').key).toBe('db_clock')
  })
})

// #2340: the sf_limits sweep runs every fourth tick, so a problem it reports is
// judged by the sweep's runs. A tick that did not run it neither counts the
// problem nor ends it, so the problem stands, and is not stood down, between runs.
describe('the kinds counted by the runs of their sweep (#2340)', () => {
  it('counts every kind of the sf_limits sweep by that sweep\'s runs, and no other kind', () => {
    expect(OPS_TICK_PROBLEM_SWEEPS).toEqual({
      sf_limits_failed: 'sf_limits', sf_limits_orgs_limit: 'sf_limits', sf_limits_refused: 'sf_limits',
      sf_limits_unreadable: 'sf_limits', sf_limits_read_failed: 'sf_limits', sf_limits_read_failing: 'sf_limits',
    })
  })

  it('names only kinds the rules table has and sweeps the tick claims', () => {
    for (const [kind, sweep] of Object.entries(OPS_TICK_PROBLEM_SWEEPS)) {
      expect(Object.hasOwn(OPS_TICK_PROBLEM_RULES, kind), kind).toBe(true)
      expect(OPS_SWEEPS as readonly string[]).toContain(sweep)
    }
  })

  it('reads the sweep from a key\'s kind, and null for a kind counted by ticks or one with no rule', () => {
    expect(sweepOfProblemKey('sf_limits_read_failing:00Dst0000000001AAA')).toBe('sf_limits')
    expect(sweepOfProblemKey('sf_limits_failed')).toBe('sf_limits')
    expect(sweepOfProblemKey('sweep_failed:run_expiry')).toBeNull()
    expect(sweepOfProblemKey('sweep_claim_failed:sf_limits')).toBeNull()
    expect(sweepOfProblemKey('toString')).toBeNull()
    expect(sweepOfProblemKey('')).toBeNull()
  })
})

describe('the sweeps a report says its tick ran (#2340)', () => {
  const report = (over: Record<string, unknown>) => ({
    tick_id: 't', mode: 'observe', scheduled_time: null, started_at: '2026-10-19T18:36:00Z', finished_at: '2026-10-19T18:36:10Z',
    db_now: null, outcome: 'ok', problems: [], problem_keys: [], counts: {}, ...over,
  })

  it('reads a report from an ops release before it as null: not known, never read as no sweep run', () => {
    expect(parseOpsTickReport(report({})).sweeps_run).toBeNull()
    expect(parseOpsTickReport(report({ sweeps_run: null })).sweeps_run).toBeNull()
  })

  it('keeps the sweeps named, a name from a newer release among them', () => {
    expect(parseOpsTickReport(report({ sweeps_run: ['lease_expiry', 'sf_limits', 'a_newer_sweep'] })).sweeps_run).toEqual(['lease_expiry', 'sf_limits', 'a_newer_sweep'])
    expect(parseOpsTickReport(report({ sweeps_run: [] })).sweeps_run).toEqual([])
  })

  it.each([
    ['not a list', { sweeps_run: 'sf_limits' }],
    ['a name that is not text', { sweeps_run: [7] }],
    ['a name with a space in it', { sweeps_run: ['sf limits'] }],
    ['too long a list', { sweeps_run: Array.from({ length: 21 }, (_, i) => `s${i}`) }],
  ])('refuses a report whose sweeps run are %s, so it pages as unreadable', (_label, over) => {
    expect(() => parseOpsTickReport(report(over))).toThrow(/sweeps run/)
  })
})

describe('capping a keyed problem list', () => {
  it('keeps a short list as it is, keys beside sentences', () => {
    expect(capTickProblems([tickProblem('db_clock', 'a'), tickProblem('probe_failed', 'b')])).toEqual({ problems: ['a', 'b'], problem_keys: ['db_clock', 'probe_failed'] })
  })

  // A broad outage reports one transient problem per schedule. Were the
  // sentence saying how many were left out paged at once, one bad tick with
  // many schedules would page. So it is held like them, and every problem that
  // pages at once is kept ahead of it, never left out.
  it('keeps every problem that pages at once ahead of the ones left out, and holds the left out sentence', () => {
    const many = Array.from({ length: 30 }, (_, i) => tickProblem('schedule_plan_failed', `plan ${i}`, `wf${i}`))
    const capped = capTickProblems([...many, tickProblem('slot_missed', 'missed', 'wfx')])
    expect(capped.problems).toHaveLength(MAX_REPORT_PROBLEMS)
    expect(capped.problem_keys).toHaveLength(MAX_REPORT_PROBLEMS)
    expect(capped.problem_keys[0]).toBe('slot_missed:wfx')
    expect(capped.problems[0]).toBe('missed')
    expect(capped.problem_keys.at(-1)).toBe('problems_left_out')
    expect(capped.problems.at(-1)).toMatch(/12 more problems were left out/)
  })
})

describe('the problem keys in a report', () => {
  const report = (over: Record<string, unknown>) => ({
    tick_id: 't', mode: 'observe', scheduled_time: null, started_at: '2026-10-19T18:36:00Z', finished_at: '2026-10-19T18:36:10Z',
    db_now: null, outcome: 'problems', problems: ['a'], counts: {}, ...over,
  })

  it('reads a report from an ops release before #2506, which keys nothing, as null', () => {
    expect(parseOpsTickReport(report({})).problem_keys).toBeNull()
    expect(parseOpsTickReport(report({ problem_keys: null })).problem_keys).toBeNull()
  })

  it('keeps one key per sentence', () => {
    expect(parseOpsTickReport(report({ problem_keys: ['sweep_failed:run_expiry'] })).problem_keys).toEqual(['sweep_failed:run_expiry'])
  })

  it.each([
    ['one key short', { problems: ['a', 'b'], problem_keys: ['db_clock'] }],
    ['a key that is not text', { problem_keys: [7] }],
    ['a key with a space in it', { problem_keys: ['sweep failed'] }],
    ['not a list', { problem_keys: 'db_clock' }],
  ])('refuses a report whose keys are %s, so it pages as unreadable', (_label, over) => {
    expect(() => parseOpsTickReport(report(over))).toThrow(/problem keys/)
  })

  it('caps the keys with the sentences, so they stay side by side', () => {
    const problems = Array.from({ length: 25 }, (_, i) => `plan ${i}`)
    const keys = problems.map((_, i) => `schedule_plan_failed:wf${i}`)
    const parsed = parseOpsTickReport(report({ problems, problem_keys: keys }))
    expect(parsed.problems).toHaveLength(MAX_REPORT_PROBLEMS)
    expect(parsed.problem_keys).toHaveLength(MAX_REPORT_PROBLEMS)
    expect(parsed.problem_keys?.[0]).toBe('schedule_plan_failed:wf0')
    expect(parsed.problem_keys?.at(-1)).toBe('problems_left_out')
  })
})

describe('the connection logins in a report (#2340)', () => {
  const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
  const CONN = '00000000-0000-4000-8000-0000000c2341'
  const report = (over: Record<string, unknown>) => ({
    tick_id: 't', mode: 'observe', scheduled_time: null, started_at: '2026-10-19T18:36:00Z', finished_at: '2026-10-19T18:36:10Z',
    db_now: '2026-10-19T18:36:00Z', outcome: 'ok', problems: [], problem_keys: [], counts: {}, ...over,
  })
  const needs = { organization_id: ORG, connection_id: CONN, service: 'salesforce', state: 'needs_reauth', reason: 'login_refused', since: '2026-10-19T18:30:00Z', failures: null }
  const failing = { ...needs, state: 'refresh_failing', reason: null, failures: 5 }

  it('reads a report from an ops release before #2340, or one that judged no login, as null: unjudged, never all clear', () => {
    expect(parseOpsTickReport(report({})).connection_logins).toBeNull()
    expect(parseOpsTickReport(report({ connection_logins: null })).connection_logins).toBeNull()
  })

  it('keeps a list of logins due to page, and whether it is complete', () => {
    expect(parseOpsTickReport(report({ connection_logins: { complete: true, logins: [needs, failing] } })).connection_logins).toEqual({ complete: true, logins: [needs, failing] })
    expect(parseOpsTickReport(report({ connection_logins: { complete: false, logins: [] } })).connection_logins).toEqual({ complete: false, logins: [] })
  })

  it.each([
    ['not an object', 'none'],
    ['no completeness', { logins: [] }],
    ['a login naming no connection', { complete: true, logins: [{ ...needs, connection_id: 'any' }] }],
    ['a login naming no organization', { complete: true, logins: [{ ...needs, organization_id: null }] }],
    ['a service that is not a service key', { complete: true, logins: [{ ...needs, service: 'Sales Force' }] }],
    ['a state this Worker does not page on', { complete: true, logins: [{ ...failing, state: 'check_failing' }] }],
    ['a needs_reauth with a reason outside the closed set', { complete: true, logins: [{ ...needs, reason: 'invalid_grant: expired' }] }],
    ['a refresh_failing with no failure count', { complete: true, logins: [{ ...failing, failures: null }] }],
    ['an unreadable time', { complete: true, logins: [{ ...needs, since: 'lately' }] }],
    ['more logins than a report carries', { complete: false, logins: Array.from({ length: MAX_REPORT_LOGINS + 1 }, () => needs) }],
  ])('refuses a report whose logins are %s, so it pages as unreadable', (_label, connectionLogins) => {
    expect(() => parseOpsTickReport(report({ connection_logins: connectionLogins }))).toThrow(/connection login/)
  })
})

describe('the write backs in a report (#2340 phase 10 item 4)', () => {
  const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
  const CONN = '00000000-0000-4000-8000-0000000c2341'
  const report = (over: Record<string, unknown>) => ({
    tick_id: 't', mode: 'observe', scheduled_time: null, started_at: '2026-10-19T18:36:00Z', finished_at: '2026-10-19T18:36:10Z',
    db_now: '2026-10-19T18:36:00Z', outcome: 'ok', problems: [], problem_keys: [], counts: {}, ...over,
  })
  const waiting = { organization_id: ORG, connection_id: CONN, service: 'google_user', since: '2026-10-19T18:00:00Z', attempts: 6 }

  it('reads a report from an ops release before it, or from a tick that judged none, as null: unjudged, never all landed', () => {
    expect(parseOpsTickReport(report({})).write_backs).toBeNull()
    expect(parseOpsTickReport(report({ write_backs: null })).write_backs).toBeNull()
  })

  it('keeps a list of write backs due to page, one pending since an unknown time among them, and whether it is complete', () => {
    const unknown = { ...waiting, since: null }
    expect(parseOpsTickReport(report({ write_backs: { complete: true, pending: [waiting, unknown] } })).write_backs).toEqual({ complete: true, pending: [waiting, unknown] })
    expect(parseOpsTickReport(report({ write_backs: { complete: false, pending: [] } })).write_backs).toEqual({ complete: false, pending: [] })
  })

  it.each([
    ['not an object', 'none'],
    ['no completeness', { pending: [] }],
    ['one naming no connection', { complete: true, pending: [{ ...waiting, connection_id: 'any' }] }],
    ['one naming no organization', { complete: true, pending: [{ ...waiting, organization_id: null }] }],
    ['a service that is not a service key', { complete: true, pending: [{ ...waiting, service: 'Google User' }] }],
    ['an unreadable time', { complete: true, pending: [{ ...waiting, since: 'lately' }] }],
    ['an unreadable count of tries', { complete: true, pending: [{ ...waiting, attempts: -1 }] }],
    ['more than a report carries', { complete: false, pending: Array.from({ length: MAX_REPORT_WRITE_BACKS + 1 }, () => waiting) }],
  ])('refuses a report whose write backs are %s, so it pages as unreadable', (_label, writeBacks) => {
    expect(() => parseOpsTickReport(report({ write_backs: writeBacks }))).toThrow(/write back/)
  })
})
