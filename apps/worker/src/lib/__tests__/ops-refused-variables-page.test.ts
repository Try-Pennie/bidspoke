/**
 * The pages for ops runs whose variables bidding refused (#3131): a run of a
 * switched on workflow that bidding would not hand its variables to fails
 * before it sends anything (status reason variables_refused), and its
 * workflow is paged on a page of its own, as the missing variable page is
 * (#3000). The page names each refused variable and why bidding refused it in
 * plain words, from the refusal's typed fields, never a code and never the
 * run's error text, and its fix changes with the reason. A refusal because
 * the workflow is no longer on the ops lane pages, on a page of its own, only
 * once a refused run comes 3 minutes or more after the workflow's first with
 * no successful run between, so a workflow mid move does not page; every
 * other reason pages at once. The words are Dan's, approved on 2026-10-30 on #3131;
 * these tests pin what each renders.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_PROBLEM_LENGTH, MAX_SUCCEEDED_WORKFLOWS, OFF_LANE_FIRST_REFUSED_TTL_SECONDS, OPS_OWN_PAGES, parseOpsTickReport, OPS_TICK_PROBLEM_RULES, PROBLEM_KEY_PATTERN, REFUSED_OFF_LANE_PAGE, REFUSED_VARIABLES_PAGE, RUN_VARIABLES_REFUSALS,
  inARowToPage, problemRuleOf, refusedVariablesFix, refusedVariablesSubject, refusedVariablesText, type FailingRunVariablesRefusal,
} from '../ops-gateway-contract'

const WF = '00000000-0000-4000-8000-0000000019a1'
const secret = (...keys: string[]) => ({ reason: 'secret_unreadable' as const, keys })
const plain = (reason: Exclude<FailingRunVariablesRefusal, 'secret_unreadable'>) => ({ reason, keys: [] as string[] })
const CLOSING = 'Runs that already failed are not run again.'
const SECRET_FIX = 'Enter the secret\'s value again on the Environment Variables page.'
const VERSION_FIX = 'Open the workflow in Bidspoke and save it again.'
const PLACEMENT_FIX = 'Check the workflow\'s organization and lane in Bidspoke.'

describe('the rules the refused variables pages page by (#3131)', () => {
  // Each refused run has already failed, and no later tick reports it again,
  // so holding it for three ticks would hold it for ever (the at_once rule).
  it('pages every reason but the lane at once, per workflow', () => {
    expect(OPS_TICK_PROBLEM_RULES.runs_refused_variables).toBe('at_once')
    expect(problemRuleOf(`runs_refused_variables:${WF}`)).toBe('at_once')
  })

  // Dan, 2026-10-30 ("Second refused run"): a workflow mid move off the ops
  // lane must not page. The tick reports it at once; its page holds it until a
  // refused run comes 3 minutes after the first, by its own state, not by ticks.
  it('pages a refusal because the workflow is off the ops lane once a refused run comes 3 minutes after its first', () => {
    expect(OPS_TICK_PROBLEM_RULES.runs_refused_off_lane).toBe('at_once')
    expect(inARowToPage(`runs_refused_off_lane:${WF}`)).toBeNull()
    expect(REFUSED_OFF_LANE_PAGE.pagesAfterFirstMs).toBe(3 * 60_000)
    expect(REFUSED_VARIABLES_PAGE).not.toHaveProperty('pagesAfterFirstMs')
    // The first refused time outlives a daily workflow's gap between runs, and is renewed while refusals go on.
    expect(OFF_LANE_FIRST_REFUSED_TTL_SECONDS).toBe(7 * 24 * 3600)
  })

  it('gives each its own page, job and count of the reports that judged it', () => {
    expect(OPS_OWN_PAGES).toContain(REFUSED_VARIABLES_PAGE)
    expect(OPS_OWN_PAGES).toContain(REFUSED_OFF_LANE_PAGE)
    expect(REFUSED_VARIABLES_PAGE.kind).toBe('runs_refused_variables')
    expect(REFUSED_OFF_LANE_PAGE.kind).toBe('runs_refused_off_lane')
    expect(REFUSED_VARIABLES_PAGE.job(WF)).toBe(`ops-runs-variables-refused:${WF}`)
    expect(REFUSED_OFF_LANE_PAGE.job(WF)).toBe(`ops-runs-variables-refused-off-lane:${WF}`)
    expect(REFUSED_VARIABLES_PAGE.judgedCount).toBe('variables_refused_judged')
    expect(REFUSED_OFF_LANE_PAGE.judgedCount).toBe('variables_refused_off_lane_judged')
    expect(REFUSED_VARIABLES_PAGE.perWorkflow).toBe(true)
    expect(REFUSED_OFF_LANE_PAGE.perWorkflow).toBe(true)
  })
})

describe('the words of the refused variables pages, as Dan approved them (#3131)', () => {
  it('titles both pages the same, naming the workflow', () => {
    expect(REFUSED_VARIABLES_PAGE.title('Lead intake')).toBe('Ops runs failed because bidding refused their variables: Lead intake')
    expect(REFUSED_OFF_LANE_PAGE.title('Lead intake')).toBe('Ops runs failed because bidding refused their variables: Lead intake')
  })

  it('names the secret bidding could not read', () => {
    expect(refusedVariablesText([secret('API_TOKEN')])).toBe(
      '1 run failed before sending anything, because bidding would not hand over the secret variable API_TOKEN: it could not be read.',
    )
    expect(refusedVariablesText([secret('API_TOKEN'), secret('API_TOKEN')])).toBe(
      '2 runs failed before sending anything, because bidding would not hand over the secret variable API_TOKEN: it could not be read.',
    )
  })

  it('names every secret the runs were refused, each once, sorted', () => {
    expect(refusedVariablesText([secret('PASS', 'API_TOKEN'), secret('API_TOKEN')])).toBe(
      '2 runs failed before sending anything, because bidding would not hand over the secret variables API_TOKEN and PASS: they could not be read.',
    )
    expect(refusedVariablesText([secret('C', 'A'), secret('B', 'A')])).toMatch(/the secret variables A, B and C: they could not be read\.$/)
  })

  it('says why in plain words for each refusal that names no variable', () => {
    expect(refusedVariablesText([plain('version_missing')])).toBe(
      '1 run failed before sending anything, because bidding would not hand over its variables: the saved version of this workflow it was started on no longer exists in bidding.',
    )
    expect(refusedVariablesText([plain('version_missing'), plain('version_missing')])).toBe(
      '2 runs failed before sending anything, because bidding would not hand over their variables: the saved version of this workflow they were started on no longer exists in bidding.',
    )
    expect(refusedVariablesText([plain('version_unreadable')])).toBe(
      '1 run failed before sending anything, because bidding would not hand over its variables: bidding could not read the saved version of this workflow it was started on, so it could not tell which variables to send.',
    )
    expect(refusedVariablesText([plain('other_organization')])).toBe(
      '1 run failed before sending anything, because bidding would not hand over its variables: in bidding, this workflow now belongs to another organization.',
    )
    expect(refusedVariablesText([plain('not_ops_lane'), plain('not_ops_lane'), plain('not_ops_lane')])).toBe(
      '3 runs failed before sending anything, because bidding would not hand over their variables: in bidding, this workflow is no longer set to run on ops.',
    )
  })

  it('says each reason, with its runs, when the runs were refused for more than one', () => {
    expect(refusedVariablesText([secret('API_TOKEN'), plain('version_missing'), plain('version_missing')])).toBe(
      '3 runs failed before sending anything, because bidding would not hand over their variables. For 2 runs, the saved version of this workflow they were started on no longer exists in bidding. For 1 run, the secret variable API_TOKEN could not be read.',
    )
  })

  it('never shows a refusal code', () => {
    const every = RUN_VARIABLES_REFUSALS.filter((r): r is FailingRunVariablesRefusal => r !== 'workflow_deleted')
    const runs = every.map((reason) => ({ reason, keys: reason === 'secret_unreadable' ? ['API_TOKEN'] : [] }))
    const text = refusedVariablesText(runs)
    for (const code of [...RUN_VARIABLES_REFUSALS, 'variables_refused']) expect(text, code).not.toContain(code)
    expect(text).not.toMatch(/env\./)
    expect(refusedVariablesFix(refusedVariablesSubject(WF, runs).slice(WF.length + 1))).not.toMatch(/_/)
  })

  it('says a secret was refused without naming it when the refusal named none, rather than naming nothing', () => {
    expect(refusedVariablesText([secret()])).toBe(
      '1 run failed before sending anything, because bidding would not hand over a secret variable it reads: it could not be read.',
    )
  })

  it('keeps the body inside what a report carries, cutting only the list of names', () => {
    const names = Array.from({ length: 200 }, (_, i) => `SECRET_NUMBER_${i}`)
    const text = refusedVariablesText([secret(...names), plain('version_missing')])
    expect(text.length).toBeLessThanOrEqual(MAX_PROBLEM_LENGTH)
    expect(text).toContain('...')
    expect(text).toMatch(/^2 runs failed before sending anything, because bidding would not hand over their variables\. For 1 run, /)
    expect(text.endsWith(' could not be read.')).toBe(true)
  })
})

// Dan, 2026-10-30: the fix changes with the reason, each reason's fix once in
// the body's order, then the closing sentence once.
describe('the fix of the refused variables page, by reason (#3131)', () => {
  const fixOf = (runs: Array<{ reason: FailingRunVariablesRefusal; keys: string[] }>) => refusedVariablesFix(refusedVariablesSubject(WF, runs).slice(WF.length + 1))

  it('gives each reason its own fix, then the closing sentence', () => {
    expect(fixOf([secret('API_TOKEN')])).toBe(`${SECRET_FIX} ${CLOSING}`)
    expect(fixOf([plain('version_missing')])).toBe(`${VERSION_FIX} ${CLOSING}`)
    expect(fixOf([plain('version_unreadable')])).toBe(`${VERSION_FIX} ${CLOSING}`)
    expect(fixOf([plain('other_organization')])).toBe(`${PLACEMENT_FIX} ${CLOSING}`)
    expect(REFUSED_OFF_LANE_PAGE.fix).toBe(`${PLACEMENT_FIX} ${CLOSING}`)
  })

  it('gives each fix once, in the order of the body\'s sentences, with mixed reasons', () => {
    const runs = [secret('API_TOKEN'), plain('version_unreadable'), plain('other_organization'), plain('version_missing')]
    expect(refusedVariablesText(runs)).toMatch(/For 1 run, the saved version .*For 1 run, in bidding, this workflow now belongs .*For 1 run, bidding could not read .*For 1 run, the secret variable/)
    expect(fixOf(runs)).toBe(`${VERSION_FIX} ${PLACEMENT_FIX} ${SECRET_FIX} ${CLOSING}`)
  })

  it('keys the page by the workflow, carrying which fixes it needs in a form a report carries', () => {
    const subject = refusedVariablesSubject(WF, [secret('API_TOKEN'), plain('version_missing')])
    expect(subject).toBe(`${WF}.version-secret`)
    expect(PROBLEM_KEY_PATTERN.test(`runs_refused_variables:${subject}`)).toBe(true)
  })

  // An unreadable detail is judged on the side that tells the reader most (L50): every fix, never none.
  it('gives every fix for a detail it cannot read, or none at all', () => {
    const all = `${VERSION_FIX} ${PLACEMENT_FIX} ${SECRET_FIX} ${CLOSING}`
    expect(refusedVariablesFix(null)).toBe(all)
    expect(refusedVariablesFix('')).toBe(all)
    expect(refusedVariablesFix('version-nonsense')).toBe(all)
    expect(REFUSED_VARIABLES_PAGE.fix).toBe(all)
  })
})

// The bidding Worker starts the lane page's wait again on a successful run of
// the workflow (Dan, 2026-10-30), so the tick's report names the workflows
// whose runs ended done; absent or null is not known, never none.
describe('the workflows whose runs succeeded, in the tick\'s report (#3131)', () => {
  const base = {
    tick_id: 't1', mode: 'live', scheduled_time: null, started_at: '2026-10-30T10:00:00.000Z', finished_at: '2026-10-30T10:00:01.000Z',
    db_now: null, outcome: 'ok', problems: [], counts: {}, start_stamp_failed: false, problem_keys: [],
  }
  const OTHER = '00000000-0000-4000-8000-0000000019b2'

  it('reads the list, and absent or null as not known', () => {
    expect(parseOpsTickReport({ ...base, succeeded_workflows: [WF, OTHER] }).succeeded_workflows).toEqual([WF, OTHER])
    expect(parseOpsTickReport({ ...base, succeeded_workflows: [] }).succeeded_workflows).toEqual([])
    expect(parseOpsTickReport(base).succeeded_workflows).toBeNull()
    expect(parseOpsTickReport({ ...base, succeeded_workflows: null }).succeeded_workflows).toBeNull()
  })

  it('refuses a list that is not of workflow ids, or longer than a tick can claim', () => {
    expect(() => parseOpsTickReport({ ...base, succeeded_workflows: ['not-a-workflow'] })).toThrow(/succeeded workflows/)
    expect(() => parseOpsTickReport({ ...base, succeeded_workflows: WF })).toThrow(/succeeded workflows/)
    const many = Array.from({ length: MAX_SUCCEEDED_WORKFLOWS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    expect(() => parseOpsTickReport({ ...base, succeeded_workflows: many })).toThrow(/succeeded workflows/)
  })
})
