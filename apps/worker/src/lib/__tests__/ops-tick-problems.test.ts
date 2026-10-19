/**
 * The ops tick's problem keys and the rule each kind pages by (#2506, Dan's
 * decision 2026-10-19): a problem a passing tick would clear pages only once
 * three ticks in a row report it; a problem no later tick can report again, or
 * one that is not transient, pages at once. The table is written out here, so
 * moving a kind from one rule to the other is a visible change to this file.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_REPORT_PROBLEMS, OPS_TICK_PROBLEM_RULES, capTickProblems, parseOpsTickReport, problemRuleOf, tickProblem,
} from '../ops-gateway-contract'

const THREE_IN_A_ROW = [
  'start_stamp', 'db_clock', 'sweep_claim_failed', 'sweep_failed', 'workflows_fetch_failed', 'workflows_save_failed',
  'copies_read_failed', 'schedule_plan_failed', 'claim_depth_failed', 'probe_failed', 'connections_fetch_failed',
  'connections_save_failed', 'tombstone_record_failed', 'problems_left_out',
]
const AT_ONCE = [
  'db_not_configured', 'not_configured', 'secrets_unchecked', 'agreement_check_failed', 'queue_disagreement', 'workflow_refused',
  'workflows_too_many', 'copies_read_limit', 'schedule_refused', 'schedule_no_version', 'slot_missed', 'dispatch_failed',
  'connections_list_unreadable', 'connection_refused', 'connections_too_many', 'connection_copies_expired', 'connections_step_failed',
  'report_unreadable', 'unkeyed',
  // The sf_limits sweep (#2336): it runs every fourth tick, so no kind of its can be reported by three ticks in a row.
  'sf_limits_failed', 'sf_limits_orgs_limit', 'sf_limits_refused', 'sf_limits_unreadable', 'sf_limits_read_failed',
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
