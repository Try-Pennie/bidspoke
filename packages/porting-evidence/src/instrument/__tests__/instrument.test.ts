import { describe, expect, it } from 'vitest'
import { instrumentWorkflow, CAPTURE_STEP_PREFIX, type PipedreamStep, type PipedreamWorkflow } from '../index.ts'
import {
  DOLLAR_KEPT_UNDER_ANOTHER_NAME,
  DOLLAR_TO_AXIOS_ONLY,
  HELPER_EXIT_AT_MODULE_LEVEL,
  HELPER_RESPOND_AT_MODULE_LEVEL,
  HELPER_THROUGH_RUN_CONTEXT,
  HELPER_WITH_A_BARE_CATCH,
  HELPERS_INSIDE_RUN,
  HELPERS_OUTSIDE_RUN,
  RESPOND_AND_EXIT_AS_VALUES,
  RESPOND_ON_AN_UNTRACED_RECEIVER,
  RUN_PARAMETER_SHADOWED,
  codeStep,
  fixtureWorkflow,
  registryStep,
} from './fixture.ts'

const OPTS = { receiverBaseUrl: 'https://ops.example.test' }

const pipelines = (wf: PipedreamWorkflow): Array<[string, PipedreamStep[]]> => [
  ['main', wf.steps],
  ...Object.entries(wf.deployments ?? {}).map(([id, d]): [string, PipedreamStep[]] => [id, d.steps ?? []]),
]
const isCapture = (s: PipedreamStep | undefined) => !!s && s.namespace.startsWith(CAPTURE_STEP_PREFIX)
const captureKind = (s: PipedreamStep) => /__portingCapture\([^,]+, '(\w+)'/.exec(s.uses.code ?? '')?.[1]

describe('instrumentWorkflow: whole pipelines', () => {
  it('puts a start capture first', () => {
    const { workflow } = instrumentWorkflow(fixtureWorkflow(), OPTS)
    expect(isCapture(workflow.steps[0])).toBe(true)
    expect(captureKind(workflow.steps[0])).toBe('start')
  })

  it('puts a terminal capture immediately before every enabled end-workflow step, in every pipeline', () => {
    const { workflow } = instrumentWorkflow(fixtureWorkflow(), OPTS)
    let ends = 0
    for (const [, steps] of pipelines(workflow)) {
      steps.forEach((s, i) => {
        if (s.component_key !== 'end-end-workflow' || s.disabled) return
        ends++
        expect(isCapture(steps[i - 1]), `no capture before ${s.namespace}`).toBe(true)
        expect(captureKind(steps[i - 1])).toBe('terminal')
      })
    }
    expect(ends).toBe(2)
  })

  it('ends the top level pipeline with a terminal capture when it does not end the workflow itself', () => {
    const { workflow } = instrumentWorkflow(fixtureWorkflow(), OPTS)
    const last = workflow.steps[workflow.steps.length - 1]
    expect(isCapture(last)).toBe(true)
    expect(captureKind(last)).toBe('terminal')
  })

  it('adds no terminal to a branch that falls off its end, because Pipedream rejoins it to the parent', () => {
    // A branch that falls off its end merges back into the parent flow, which
    // reaches its own terminal. A second terminal there would break pairing.
    const { workflow } = instrumentWorkflow(fixtureWorkflow(), OPTS)
    const slack = workflow.deployments!.d_slack.steps!
    expect(slack.some(isCapture)).toBe(false)
  })

  it('does not add a top level terminal when the pipeline already ends in an enabled end-workflow', () => {
    const wf = fixtureWorkflow()
    wf.steps = [codeStep('a', 'export default defineComponent({ async run() { return 1 } })'), registryStep('end', 'end-end-workflow')]
    const { workflow } = instrumentWorkflow(wf, OPTS)
    expect(workflow.steps.map((s) => (isCapture(s) ? captureKind(s) : s.namespace))).toEqual(['start', 'a', 'terminal', 'end'])
  })

  it('adds a responded capture after every http return step, never counted as a terminal', () => {
    const { workflow } = instrumentWorkflow(fixtureWorkflow(), OPTS)
    for (const [, steps] of pipelines(workflow)) {
      steps.forEach((s, i) => {
        if (s.component_key !== 'http-return-http-response') return
        expect(captureKind(steps[i + 1]), `no responded capture after ${s.namespace}`).toBe('responded')
      })
    }
  })

  it('leaves the original steps in their original order', () => {
    const before = fixtureWorkflow()
    const { workflow } = instrumentWorkflow(fixtureWorkflow(), OPTS)
    for (const [id, steps] of pipelines(before)) {
      const after = pipelines(workflow).find(([pid]) => pid === id)![1].filter((s) => !isCapture(s))
      expect(after.map((s) => s.namespace)).toEqual(steps.map((s) => s.namespace))
    }
  })

  it('does not mutate the workflow it was given', () => {
    const wf = fixtureWorkflow()
    const copy = structuredClone(wf)
    instrumentWorkflow(wf, OPTS)
    expect(wf).toEqual(copy)
  })

  it('gives every inserted step a namespace no other step uses', () => {
    const { workflow } = instrumentWorkflow(fixtureWorkflow(), OPTS)
    const all = pipelines(workflow).flatMap(([, s]) => s.map((x) => x.namespace))
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('instrumentWorkflow: code sites', () => {
  it('captures before every rewritable $.flow.exit and after every $.respond, and refuses the rest by name', () => {
    const { sites, refused } = instrumentWorkflow(fixtureWorkflow(), OPTS)
    const code = sites.filter((s) => s.step === 'validate')
    expect(code.filter((s) => s.kind === 'terminal')).toHaveLength(3)
    expect(code.filter((s) => s.kind === 'responded')).toHaveLength(1)
    expect(refused.map((r) => r.reason).sort()).toEqual(['exit_in_expression_position', 'exit_in_sync_function', 'exit_outside_run'])
    for (const r of refused) {
      expect(r.step).toBe('validate')
      expect(r.line).toBeGreaterThan(0)
      expect(r.siteId).toMatch(/^main\/validate\/exit:/)
    }
  })

  it('edits the code through its parse tree, leaving untouched lines byte identical', () => {
    const { workflow } = instrumentWorkflow(fixtureWorkflow(), OPTS)
    const code = workflow.steps.find((s) => s.namespace === 'validate')!.uses.code!
    expect(code).toContain('    const seen = []\n')
    expect(code).toContain('  return $.flow.exit(reason)\n')
    expect(code).toContain('const check = () => $.flow.exit("sync exit")')
  })

  it('leaves a code step with no exit or respond untouched', () => {
    const before = fixtureWorkflow().steps.find((s) => s.namespace === 'compute')!
    const { workflow } = instrumentWorkflow(fixtureWorkflow(), OPTS)
    expect(workflow.steps.find((s) => s.namespace === 'compute')).toEqual(before)
  })

  it('refuses an unparseable code step by name rather than skipping it silently', () => {
    const wf = fixtureWorkflow()
    wf.steps.push(codeStep('broken', 'export default defineComponent({ async run({ $ }) { $.flow.exit( } })'))
    const { refused } = instrumentWorkflow(wf, OPTS)
    expect(refused).toContainEqual(expect.objectContaining({ step: 'broken', reason: 'unparseable_code' }))
  })

  it('refuses a step that is already instrumented', () => {
    const once = instrumentWorkflow(fixtureWorkflow(), OPTS).workflow
    const { refused } = instrumentWorkflow(once, OPTS)
    expect(refused).toContainEqual(expect.objectContaining({ reason: 'already_instrumented' }))
  })

  it('treats a test that exit exists as harmless, and a stored exit as an alias it must refuse', () => {
    const wf = fixtureWorkflow()
    wf.steps = [
      codeStep('guarded', 'export default defineComponent({ async run({ $ }) {\n  if ($?.flow?.exit) return $.flow.exit("done")\n} })'),
      codeStep('stored', 'export default defineComponent({ async run({ $ }) {\n  const stop = $.flow.exit\n  return 1\n} })'),
    ]
    const { sites, refused } = instrumentWorkflow(wf, OPTS)
    expect(sites.filter((s) => s.step === 'guarded' && s.how === 'code_call')).toHaveLength(1)
    expect(refused.filter((r) => r.step === 'guarded')).toEqual([])
    expect(refused).toContainEqual(expect.objectContaining({ step: 'stored', reason: 'exit_alias', line: 2 }))
  })

  // Review of #1711: with a plain identifier for the run's parameter, a respond
  // reached through it (`ctx.$.respond`) was neither captured nor refused.
  it('captures a respond reached through a run parameter that is a plain identifier', () => {
    const wf = fixtureWorkflow()
    wf.steps = [
      codeStep('ctxstep', 'export default defineComponent({ async run(ctx) {\n  await ctx.$.respond({ status: 200 })\n  return 1\n} })'),
    ]
    const { sites, refused, workflow } = instrumentWorkflow(wf, OPTS)
    expect(sites).toContainEqual(expect.objectContaining({ step: 'ctxstep', kind: 'responded', how: 'code_call' }))
    expect(refused.filter((r) => r.step === 'ctxstep')).toEqual([])
    expect(workflow.steps.find((s) => s.namespace === 'ctxstep')!.uses.code).toMatch(/__portingCapture\(\s*ctx\.steps,\s*["']responded["']/)
  })

  it('skips disabled steps, whose code never runs', () => {
    const wf = fixtureWorkflow()
    wf.steps.push(codeStep('off', 'export default defineComponent({ async run({ $ }) { return $.flow.exit("x") } })', { disabled: true }))
    const { sites, workflow } = instrumentWorkflow(wf, OPTS)
    expect(sites.some((s) => s.step === 'off')).toBe(false)
    expect(workflow.steps.find((s) => s.namespace === 'off')!.uses.code).not.toContain('__portingCapture')
  })

  it('does not instrument the control flow routing steps', () => {
    const { workflow } = instrumentWorkflow(fixtureWorkflow(), OPTS)
    expect(workflow.steps.find((s) => s.namespace === 'route')).toEqual(fixtureWorkflow().steps.find((s) => s.namespace === 'route'))
  })
})

// #1717: a `$` handed to a helper defined in the step, which responds or exits
// through its own parameter name, was neither captured nor refused.
describe('instrumentWorkflow: helpers that receive the run $ under another name', () => {
  const only = (code: string) => {
    const wf = fixtureWorkflow()
    wf.steps = [codeStep('helper', code)]
    const result = instrumentWorkflow(wf, OPTS)
    return {
      ...result,
      code: result.workflow.steps.find((s) => s.namespace === 'helper')!.uses.code!,
      captured: result.sites.filter((s) => s.step === 'helper' && s.how === 'code_call'),
      refusedHere: result.refused.filter((r) => r.step === 'helper'),
    }
  }

  it('refuses by name a respond made in a module level helper through its own parameter', () => {
    const { captured, refusedHere } = only(HELPER_RESPOND_AT_MODULE_LEVEL)
    expect(captured).toEqual([])
    expect(refusedHere.map((r) => [r.reason, r.line])).toEqual([['respond_outside_run', 2]])
    expect(refusedHere[0].siteId).toMatch(/^main\/helper\/respond:2:/)
  })

  it('refuses by name an exit made in a module level helper through its own parameter', () => {
    const { captured, refusedHere } = only(HELPER_EXIT_AT_MODULE_LEVEL)
    expect(captured).toEqual([])
    expect(refusedHere.map((r) => [r.reason, r.line])).toEqual([['exit_outside_run', 2]])
    expect(refusedHere[0].siteId).toMatch(/^main\/helper\/exit:2:/)
  })

  it('captures responds and exits in helpers defined inside run: arrows, function expressions, object methods, nested helpers', () => {
    const { captured, refusedHere, code } = only(HELPERS_INSIDE_RUN)
    expect(refusedHere).toEqual([])
    const responded = captured.filter((s) => s.kind === 'responded').map((s) => s.siteId)
    expect(responded.sort()).toEqual(['main/helper/respond:11:14', 'main/helper/respond:18:12', 'main/helper/respond:4:12'])
    expect(captured.filter((s) => s.kind === 'terminal').map((s) => s.siteId)).toEqual(['main/helper/exit:7:13'])
    for (const name of ['d', 'r', 'i']) {
      expect(code).toMatch(new RegExp(`await ${name}\\.respond\\(__portingResponse_\\d+_\\d+\\)\\s*await __portingCapture\\(\\s*__portingSteps,\\s*"responded"`))
    }
  })

  it('refuses responds in helpers outside run: object literal methods, component methods, a destructured $', () => {
    const { captured, refusedHere } = only(HELPERS_OUTSIDE_RUN)
    expect(captured).toEqual([])
    expect(refusedHere.map((r) => [r.reason, r.line])).toEqual([
      ['respond_outside_run', 3],
      ['respond_outside_run', 8],
      ['respond_outside_run', 14],
    ])
  })

  it('captures a respond through a helper that was given the run context', () => {
    const { captured, refusedHere, code } = only(HELPER_THROUGH_RUN_CONTEXT)
    expect(refusedHere).toEqual([])
    expect(captured).toEqual([expect.objectContaining({ kind: 'responded', siteId: 'main/helper/respond:4:12' })])
    expect(code).toMatch(/__portingCapture\(\s*ctx\.steps,\s*["']responded["']/)
  })

  it('captures a respond through a local name for $', () => {
    const { captured, refusedHere } = only(DOLLAR_KEPT_UNDER_ANOTHER_NAME)
    expect(refusedHere).toEqual([])
    expect(captured).toEqual([expect.objectContaining({ kind: 'responded', siteId: 'main/helper/respond:4:10' })])
  })

  it('leaves a $ handed to axios, directly or through a helper, unrefused and the step untouched', () => {
    const { captured, refusedHere, code } = only(DOLLAR_TO_AXIOS_ONLY)
    expect(captured).toEqual([])
    expect(refusedHere).toEqual([])
    expect(code).toBe(DOLLAR_TO_AXIOS_ONLY)
  })

  it('does not raise the refusal count of a workflow when a step hands $ only to axios', () => {
    const base = instrumentWorkflow(fixtureWorkflow(), OPTS).refused.length
    const wf = fixtureWorkflow()
    wf.steps.push(codeStep('axios_only', DOLLAR_TO_AXIOS_ONLY))
    expect(instrumentWorkflow(wf, OPTS).refused).toHaveLength(base)
  })

  it('refuses $.respond and flow taken as values, whose later calls cannot be found', () => {
    const { captured, refusedHere } = only(RESPOND_AND_EXIT_AS_VALUES)
    expect(captured).toEqual([])
    expect(refusedHere.map((r) => [r.reason, r.line])).toEqual([
      ['respond_alias', 3],
      ['exit_alias', 4],
    ])
  })

  it('refuses a respond on a receiver it cannot trace to $, rather than leaving a silent gap', () => {
    const { captured, refusedHere } = only(RESPOND_ON_AN_UNTRACED_RECEIVER)
    expect(captured).toEqual([])
    expect(refusedHere).toEqual([expect.objectContaining({ reason: 'respond_unresolved_receiver', line: 6 })])
  })

  it('follows $ into a helper whose respond sits in a catch block with no binding', () => {
    const { captured, refusedHere } = only(HELPER_WITH_A_BARE_CATCH)
    expect(refusedHere).toEqual([])
    expect(captured.map((s) => s.siteId)).toEqual(['main/helper/respond:7:14', 'main/helper/respond:10:12'])
  })

  it('refuses a site where a helper parameter hides the run context the capture reads steps from', () => {
    const { captured, refusedHere } = only(RUN_PARAMETER_SHADOWED)
    expect(captured).toEqual([])
    expect(refusedHere.map((r) => [r.reason, r.line])).toEqual([
      ['respond_run_parameter_shadowed', 4],
      ['exit_run_parameter_shadowed', 7],
    ])
  })
})

describe('instrumentWorkflow: error terminal', () => {
  it("emits an error listener that captures only this workflow's errors, keyed by the failed run's id", () => {
    const { errorListener } = instrumentWorkflow(fixtureWorkflow(), OPTS)
    expect(errorListener.code).toContain("'p_FIXTURE'")
    expect(errorListener.code).toContain('original_context')
    expect(errorListener.code).toMatch(/__portingCapture\([^,]+, 'error'/)
  })
})

describe('instrumentWorkflow: delay steps', () => {
  it('reports delay steps, which extend the pairing wait', () => {
    const wf = fixtureWorkflow()
    wf.deployments.d_slack.steps.unshift(registryStep('wait', 'delay-workflow-delay'))
    const { delaySteps } = instrumentWorkflow(wf, OPTS)
    expect(delaySteps).toEqual([{ pipeline: 'd_slack', step: 'wait' }])
  })
})
