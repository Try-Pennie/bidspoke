import { describe, expect, it } from 'vitest'
import { instrumentWorkflow, CAPTURE_STEP_PREFIX, type PipedreamStep, type PipedreamWorkflow } from '../index.ts'
import { fixtureWorkflow, codeStep, registryStep } from './fixture.ts'

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
