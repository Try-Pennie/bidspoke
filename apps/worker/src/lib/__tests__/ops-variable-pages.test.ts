/**
 * The four pages about an ops run's variables (#3000, phase 4 of #2982): each
 * on a page of its own, as Ops runs can't start is (#3039), with a title, a
 * body carrying the real values, and a fix. The wording is a DRAFT for Dan to
 * approve; these tests pin what each renders, so a change to it is seen here.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_PROBLEM_LENGTH, MISSING_VARIABLE_PAGE, OPS_OWN_PAGES, OPS_TICK_PROBLEM_RULES, RUN_VARIABLES_UNREADABLE_PAGE, RUNS_ON_VARIABLE_COPY_PAGE,
  UNSTARTED_RUNS_PAGE, VARIABLE_COPY_REFRESH_PAGE, inARowToPage, missingVariableText, problemRuleOf, refreshFailingText, runVariablesUnreadableText,
  runsOnVariableCopyText,
} from '../ops-gateway-contract'

const WF = '00000000-0000-4000-8000-0000000019a1'

describe('the rule each variables page pages by (#3000)', () => {
  // Plan, Phase 4: "the refresh failing three ticks running; an unreadable gateway answer (version skew) pages at once".
  it('pages the refresh only once three ticks in a row failed it, as the plan decided', () => {
    expect(OPS_TICK_PROBLEM_RULES.variable_copy_refresh_failing).toBe('three_in_a_row')
    expect(inARowToPage('variable_copy_refresh_failing')).toBe(3)
  })

  it('pages an unreadable answer at once, as the plan decided', () => {
    expect(OPS_TICK_PROBLEM_RULES.run_variables_unreadable).toBe('at_once')
  })

  // Each is a run that has already happened, which no later tick reports again,
  // so holding it for three ticks would hold it for ever (the at_once rule).
  it('pages runs that ran on the copy, and runs that failed on a missing variable, at once, per workflow', () => {
    expect(problemRuleOf(`runs_on_variable_copy:${WF}`)).toBe('at_once')
    expect(problemRuleOf(`runs_variable_missing:${WF}`)).toBe('at_once')
  })

  it('lists every page of its own once, each with its own kind, job and count of the reports that judged it', () => {
    const kinds = OPS_OWN_PAGES.map((p) => p.kind)
    expect(kinds).toEqual(['runs_unstarted', 'runs_on_variable_copy', 'variable_copy_refresh_failing', 'run_variables_unreadable', 'runs_variable_missing'])
    expect(new Set(OPS_OWN_PAGES.map((p) => p.judgedCount)).size).toBe(OPS_OWN_PAGES.length)
    expect(new Set(OPS_OWN_PAGES.map((p) => p.job(WF))).size).toBe(OPS_OWN_PAGES.length)
    for (const p of OPS_OWN_PAGES) expect(Object.hasOwn(OPS_TICK_PROBLEM_RULES, p.kind), p.kind).toBe(true)
    // #3039's page is unchanged by joining the list.
    expect(UNSTARTED_RUNS_PAGE.job(WF)).toBe(`ops-runs-unstarted:${WF}`)
  })
})

// The DRAFT wording, rendered with real values, so Dan reads exactly what pages.
describe('the DRAFT words of each page (#3000)', () => {
  it('(a) runs that ran on the kept copy while bidding answered the refresh', () => {
    expect(RUNS_ON_VARIABLE_COPY_PAGE.title('Lead intake')).toBe('Ops runs used old variables: Lead intake')
    expect(runsOnVariableCopyText({ runs: 2, ageSeconds: 14 * 60 + 30, why: 'the bidding Worker\'s run variables did not answer within 15 s' })).toBe(
      '2 runs started on the copy of their environment variables that ops keeps, last confirmed by bidding 14 minutes before they started, because bidding did not answer the request for their current values (the bidding Worker\'s run variables did not answer within 15 s). In the same minute bidding answered the refresh of that copy, so these runs should have had current values.',
    )
    expect(RUNS_ON_VARIABLE_COPY_PAGE.fix).toBe('Search the bidding Worker\'s logs for opsRunVariables around the time of this alert. If a variable this workflow reads was changed in the last 6 hours, check what these runs sent.')
  })

  it('(a) reads in the singular, and says how old a copy under a minute or over two hours is', () => {
    expect(runsOnVariableCopyText({ runs: 1, ageSeconds: 40, why: 'x' })).toMatch(/^1 run started on the copy of its environment variables that ops keeps, last confirmed by bidding less than a minute before it started, .* so this run should have had current values\.$/)
    expect(runsOnVariableCopyText({ runs: 3, ageSeconds: 5 * 3600 + 7 * 60, why: 'x' })).toMatch(/last confirmed by bidding 5 hours 7 minutes before they started/)
    expect(runsOnVariableCopyText({ runs: 3, ageSeconds: 61, why: 'x' })).toMatch(/last confirmed by bidding 1 minute before/)
  })

  it('(b) the refresh of the kept copy failing three ticks in a row', () => {
    expect(VARIABLE_COPY_REFRESH_PAGE.title()).toBe('Ops can\'t refresh its copy of the variables')
    expect(refreshFailingText({ workflows: 12, error: 'the refresh did not finish within 15 s' })).toBe(
      'Ops could not refresh its copy of the environment variables of 12 switched on workflows from bidding: the refresh did not finish within 15 s. Runs still start whenever bidding answers their own request, but a run that has to fall back to the copy can use it only while it is under 6 hours old.',
    )
    expect(refreshFailingText({ workflows: 1, error: 'x' })).toMatch(/of 1 switched on workflow from bidding/)
    expect(VARIABLE_COPY_REFRESH_PAGE.fix).toBe('Check that the bidding Worker is up and answering the ops gateway. Its logs for opsRunVariables say why the requests failed.')
  })

  it('(c) an answer from bidding that ops cannot read', () => {
    expect(RUN_VARIABLES_UNREADABLE_PAGE.title()).toBe('Ops can\'t read the variables bidding sent')
    const first = 'the bidding Worker answered the run variables request with something other than { organization_id, runs }'
    expect(runVariablesUnreadableText({ answers: [first, 'another'] })).toBe(
      `Bidding answered 2 of ops's requests for environment variables in a shape ops cannot read. The first: ${first}. Runs fall back to the copy ops keeps where they can, and the rest wait to start.`,
    )
    expect(runVariablesUnreadableText({ answers: [first] })).toMatch(/^Bidding answered 1 of ops's requests for environment variables in a shape ops cannot read\./)
    expect(RUN_VARIABLES_UNREADABLE_PAGE.fix).toBe('The ops and bidding Workers are probably running different releases. Deploy both from the same commit of main.')
  })

  it('(d) a switched on workflow\'s run failing on a missing variable', () => {
    expect(MISSING_VARIABLE_PAGE.title('Lead intake')).toBe('Ops runs failed on a missing variable: Lead intake')
    const error = 'the definition reads env.LIST_ID, which was not a variable of this workflow when the run started, so nothing was run; add it and run it again'
    expect(missingVariableText({ runs: 2, error })).toBe(`2 runs failed before sending anything. The first said: ${error}.`)
    expect(missingVariableText({ runs: 1, error })).toMatch(/^1 run failed before sending anything\. It said: /)
    expect(MISSING_VARIABLE_PAGE.fix).toBe('Add the missing variable on the Environment Variables page, or remove it from the workflow and save it. Runs that already failed are not run again.')
  })

  it('keeps each body inside what a report carries, even with a long error, ending on its own last sentence', () => {
    const long = 'x'.repeat(2000)
    for (const text of [
      runsOnVariableCopyText({ runs: 2, ageSeconds: 60, why: long }), refreshFailingText({ workflows: 2, error: long }),
      runVariablesUnreadableText({ answers: [long] }), missingVariableText({ runs: 2, error: long }),
    ]) {
      expect(text.length).toBeLessThanOrEqual(MAX_PROBLEM_LENGTH)
      expect(text.endsWith('.')).toBe(true)
      expect(text).toContain('...')
    }
  })
})
