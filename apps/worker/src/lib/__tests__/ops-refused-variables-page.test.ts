/**
 * The page for an ops run whose variables bidding refused (#3131): a run of a
 * switched on workflow that bidding would not hand its variables to fails
 * before it sends anything (status reason variables_refused), and its
 * workflow is paged at once, on a page of its own, as the missing variable
 * page is (#3000). The page names each refused variable and why bidding
 * refused it in plain words, from the refusal's typed fields, never a code
 * and never the run's error text. These tests pin what it renders.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_PROBLEM_LENGTH, OPS_OWN_PAGES, OPS_TICK_PROBLEM_RULES, REFUSED_VARIABLES_PAGE, RUN_VARIABLES_REFUSALS, problemRuleOf, refusedVariablesText,
  type FailingRunVariablesRefusal,
} from '../ops-gateway-contract'

const WF = '00000000-0000-4000-8000-0000000019a1'
const secret = (...keys: string[]) => ({ reason: 'secret_unreadable' as const, keys })
const plain = (reason: Exclude<FailingRunVariablesRefusal, 'secret_unreadable'>) => ({ reason, keys: [] as string[] })

describe('the rule the refused variables page pages by (#3131)', () => {
  // Each refused run has already failed, and no later tick reports it again,
  // so holding it for three ticks would hold it for ever (the at_once rule).
  it('pages at once, per workflow', () => {
    expect(OPS_TICK_PROBLEM_RULES.runs_refused_variables).toBe('at_once')
    expect(problemRuleOf(`runs_refused_variables:${WF}`)).toBe('at_once')
  })

  it('is a page of its own, with its own job and its own count of the reports that judged it', () => {
    expect(OPS_OWN_PAGES).toContain(REFUSED_VARIABLES_PAGE)
    expect(REFUSED_VARIABLES_PAGE.kind).toBe('runs_refused_variables')
    expect(REFUSED_VARIABLES_PAGE.job(WF)).toBe(`ops-runs-variables-refused:${WF}`)
    expect(REFUSED_VARIABLES_PAGE.judgedCount).toBe('variables_refused_judged')
    expect(REFUSED_VARIABLES_PAGE.perWorkflow).toBe(true)
  })
})

describe('the words of the refused variables page (#3131, a draft for Dan)', () => {
  it('has a title naming the workflow, and one fix', () => {
    expect(REFUSED_VARIABLES_PAGE.title('Lead intake')).toBe('Ops runs failed because bidding refused their variables: Lead intake')
    expect(REFUSED_VARIABLES_PAGE.fix).toBe(
      'If a secret could not be read, enter its value again on the Environment Variables page. Otherwise open the workflow in Bidspoke and save it again. Runs that already failed are not run again.',
    )
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
    const text = refusedVariablesText(every.map((reason) => ({ reason, keys: reason === 'secret_unreadable' ? ['API_TOKEN'] : [] })))
    for (const code of [...RUN_VARIABLES_REFUSALS, 'variables_refused']) expect(text, code).not.toContain(code)
    expect(text).not.toMatch(/env\./)
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
