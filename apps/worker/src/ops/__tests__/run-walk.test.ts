/**
 * The ops run body (#1950, PR 5 of B3): a definition walked step by step with
 * the ops lane's in memory executors, and every other step through a handler
 * that sends only through ctx.send (the ledgered send), which is what #2339's
 * app_action registers. These tests drive walkOpsDefinition with a RunContext
 * whose send is recorded, and prove the walk's routing, what it refuses before
 * any step runs, and how each kind of step failure ends the run.
 */
import { describe, expect, it } from 'vitest'
import { organizationIdFrom } from '../ops-db'
import type { ClaimedRun, OpsStepRecord } from '../ops-writes'
import { RunStopped, StepUnrecorded, type RunContext, type StepSend } from '../run-invocation'
import { OPS_WALK_MAX_STEPS, StepEndsRun, walkOpsDefinition, type OpsStepHandler } from '../run-walk'
import { STEP_OUTPUT_MAX_BYTES } from '../step-output'

const RUN: ClaimedRun = {
  runRequestId: '0192f4a0-0000-7000-8000-000000000001', organizationId: organizationIdFrom('6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'),
  workflowId: '00000000-0000-4000-8000-0000000019a1', workflowVersion: 3, triggerKind: 'schedule', claimToken: 'token-1',
  claimExpiresAt: '2026-10-17T10:03:31.000Z', stateVersion: 2, attempts: 0, unchargedAttempts: 0, maxAttempts: 3, resumeReason: null,
  executionChainId: '0192f4a0-0000-7000-9000-000000000001', resumedFromExecutionId: null, payload: { slot: '2026-10-17T10:00:00Z', amount: 7 }, payloadRef: null,
}

const T0 = Date.parse('2026-10-24T14:00:00.000Z')

/** A run context whose sends and step records are kept; its clock moves 5 ms each time it is read. */
function runCtx(over: { recordStep?: (record: OpsStepRecord) => Promise<void> } = {}) {
  const sent: Array<StepSend<unknown>> = []
  const records: OpsStepRecord[] = []
  let t = T0
  const ctx: RunContext = {
    run: RUN, executionId: '0192f4a0-0000-7000-8000-0000000000ee', attempt: 1, signal: new AbortController().signal,
    send: async <T>(step: StepSend<T>) => {
      sent.push(step as StepSend<unknown>)
      const a = await step.forward({ signal: new AbortController().signal, requestId: 'req-1' })
      if (a.kind !== 'answered') throw new Error(`not answered: ${a.kind}`)
      return { status: a.status, value: a.value }
    },
    now: () => (t += 5),
    recordStep: over.recordStep ?? (async (record) => { records.push(record) }),
  }
  return { ctx, sent, records }
}

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, namespace: id, type, config })
const edge = (source: string, target: string, sourceHandle?: string) => ({ id: `${source}-${target}`, source, target, ...(sourceHandle ? { source_handle: sourceHandle } : {}) })

/** A handler that records the step outputs it can see, and answers what the test says. */
function recorder(answer: (seen: Record<string, unknown>) => unknown = () => ({ ok: true })) {
  const seen: Array<Record<string, unknown>> = []
  const handler: OpsStepHandler = async ({ node: n, ctx }) => {
    const steps = Object.fromEntries(Object.entries(ctx.steps).map(([k, v]) => [k, v.output]))
    seen.push({ node: n.id, steps, payload: ctx.trigger.payload })
    return { output: answer(steps) }
  }
  return { handler, seen }
}

describe('walkOpsDefinition', () => {
  it('walks from the trigger edge, records each step\'s output for the next, and ends done', async () => {
    const r = recorder()
    const def = {
      nodes: [node('shape', 'transform', { mappings: [{ source: 'trigger.payload.amount', target: 'amount' }] }), node('act', 'test_action')],
      edges: [edge('trigger', 'shape'), edge('shape', 'act')],
    }
    const end = await walkOpsDefinition(def, runCtx().ctx, { test_action: r.handler })
    expect(end).toEqual({ outcome: 'done' })
    expect(r.seen).toEqual([{ node: 'act', steps: { shape: { amount: 7 } }, payload: RUN.payload }])
  })

  it('routes a branch by the label it matched, and a filter that exits ends the run done without the steps after it', async () => {
    const a = recorder()
    const b = recorder()
    const branchDef = {
      nodes: [
        node('pick', 'branch', { branches: [{ label: 'big', condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: 'trigger.payload.amount', operator: 'gt', value: '5' }] }] } }] }),
        node('a', 'action_a'), node('b', 'action_b'),
      ],
      edges: [edge('trigger', 'pick'), edge('pick', 'a', 'big'), edge('pick', 'b', 'else')],
    }
    expect(await walkOpsDefinition(branchDef, runCtx().ctx, { action_a: a.handler, action_b: b.handler })).toEqual({ outcome: 'done' })
    expect(a.seen).toHaveLength(1)
    expect(b.seen).toHaveLength(0)

    const after = recorder()
    const filterDef = {
      nodes: [node('gate', 'filter', { operation: 'continue_if', condition: { field: 'trigger.payload.amount', operator: 'gt', value: '100' } }), node('later', 'action_a')],
      edges: [edge('trigger', 'gate'), edge('gate', 'later', 'pass')],
    }
    expect(await walkOpsDefinition(filterDef, runCtx().ctx, { action_a: after.handler })).toEqual({ outcome: 'done' })
    expect(after.seen).toHaveLength(0)
  })

  it('hands a handler the run\'s ledgered send, whose answer feeds the next step', async () => {
    const run = runCtx()
    const sender: OpsStepHandler = async ({ node: n, run: rc }) => {
      const r = await rc.send({ nodeId: n.id, seq: 0, method: 'POST', url: 'https://api.example.test/x', idempotent: false, forward: async () => ({ kind: 'answered', status: 201, value: { id: 42 } }) })
      return { output: r.value }
    }
    const after = recorder()
    const def = { nodes: [node('send', 'sender'), node('next', 'after')], edges: [edge('trigger', 'send'), edge('send', 'next')] }
    expect(await walkOpsDefinition(def, run.ctx, { sender, after: after.handler })).toEqual({ outcome: 'done' })
    expect(run.sent.map((s) => s.nodeId)).toEqual(['send'])
    expect(after.seen[0].steps).toEqual({ send: { id: 42 } })
  })

  it('refuses, before any step runs, a node type it has neither an executor nor a handler for, naming each', async () => {
    const r = recorder()
    const def = {
      nodes: [node('first', 'action_a'), node('call', 'webhook'), node('script', 'code')],
      edges: [edge('trigger', 'first'), edge('first', 'call'), edge('call', 'script')],
    }
    const end = await walkOpsDefinition(def, runCtx().ctx, { action_a: r.handler })
    expect(end).toMatchObject({ outcome: 'failed' })
    expect((end as { error: string }).error).toMatch(/webhook/)
    expect((end as { error: string }).error).toMatch(/code/)
    expect(r.seen).toHaveLength(0)
  })

  it('refuses a definition that reads {{env.*}}, since ops runs load no environment variables yet, rather than sending blanks', async () => {
    const r = recorder()
    const def = { nodes: [node('shape', 'transform', { mappings: [{ source: 'env.API_BASE', target: 'base' }] }), node('act', 'action_a')], edges: [edge('trigger', 'shape'), edge('shape', 'act')] }
    const end = await walkOpsDefinition(def, runCtx().ctx, { action_a: r.handler })
    expect(end).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/env\.API_BASE/) })
    expect(r.seen).toHaveLength(0)
  })

  it('refuses an edge condition that reads env.*, which would compare against a blank', async () => {
    const r = recorder()
    const gated = { ...edge('trigger', 'act'), condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: 'env.REGION', operator: 'equals', value: 'us' }] }] } }
    const end = await walkOpsDefinition({ nodes: [node('act', 'action_a')], edges: [gated] }, runCtx().ctx, { action_a: r.handler })
    expect(end).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/env\.REGION/) })
    expect(r.seen).toHaveLength(0)
  })

  it('ends failed, naming the step, when a handler reports an error or throws; a stopped run is passed on', async () => {
    const failing: OpsStepHandler = async () => ({ output: null, error: 'partner refused' })
    const def = { nodes: [node('act', 'action_a')], edges: [edge('trigger', 'act')] }
    expect(await walkOpsDefinition(def, runCtx().ctx, { action_a: failing })).toEqual({ outcome: 'failed', error: 'step act (action_a): partner refused' })
    const throwing: OpsStepHandler = async () => { throw new Error('boom') }
    expect(await walkOpsDefinition(def, runCtx().ctx, { action_a: throwing })).toEqual({ outcome: 'failed', error: 'step act (action_a): boom' })
    const stopped: OpsStepHandler = async () => { throw new RunStopped() }
    await expect(walkOpsDefinition(def, runCtx().ctx, { action_a: stopped })).rejects.toBeInstanceOf(RunStopped)
  })

  it('ends failed with max_steps_exceeded when a loop passes OPS_WALK_MAX_STEPS', async () => {
    const r = recorder()
    const def = { nodes: [node('a', 'action_a'), node('b', 'action_a')], edges: [edge('trigger', 'a'), edge('a', 'b'), edge('b', 'a')] }
    const end = await walkOpsDefinition(def, runCtx().ctx, { action_a: r.handler })
    expect(end).toMatchObject({ outcome: 'failed', reason: 'max_steps_exceeded' })
    expect(r.seen).toHaveLength(OPS_WALK_MAX_STEPS)
  })

  it('refuses a definition with no steps or no entry, by name', async () => {
    expect(await walkOpsDefinition({ nodes: [], edges: [] }, runCtx().ctx, {})).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/no step/) })
    expect(await walkOpsDefinition({ nope: true }, runCtx().ctx, {})).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/nodes and edges/) })
    // Every step is some edge's target and no edge leaves the trigger, so nothing is first.
    const circle = { nodes: [node('a', 'action_a'), node('b', 'action_a')], edges: [edge('a', 'b'), edge('b', 'a')] }
    expect(await walkOpsDefinition(circle, runCtx().ctx, { action_a: recorder().handler })).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/no entry/) })
  })

  it('runs a handler registered under a name an object inherits, such as constructor, through that handler', async () => {
    const r = recorder()
    const def = { nodes: [node('odd', 'constructor')], edges: [edge('trigger', 'odd')] }
    expect(await walkOpsDefinition(def, runCtx().ctx, { constructor: r.handler })).toEqual({ outcome: 'done' })
    expect(r.seen.map((s) => s.node)).toEqual(['odd'])
  })

  it('routes by _route only for the in memory routing steps, never by a handler\'s output, which an outside answer fills', async () => {
    const r = recorder()
    const def = {
      nodes: [node('call', 'action_a'), node('wired', 'action_b'), node('steered', 'action_b')],
      edges: [edge('trigger', 'call'), edge('call', 'wired'), edge('call', 'steered', 'evil')],
    }
    const answering: OpsStepHandler = async () => ({ output: { _route: 'evil', from: 'a partner' } })
    const end = await walkOpsDefinition(def, runCtx().ctx, { action_a: answering, action_b: r.handler })
    expect(end).toEqual({ outcome: 'done' })
    expect(r.seen.map((s) => s.node)).toEqual(['wired'])
  })
})

// Each step of an ops run, recorded (#2703): one record per step as it finishes.
describe('walkOpsDefinition records each step (#2703)', () => {
  const twoSteps = {
    nodes: [node('shape', 'transform', { mappings: [{ source: 'trigger.payload.amount', target: 'amount' }] }), node('act', 'action_a')],
    edges: [edge('trigger', 'shape'), edge('shape', 'act')],
  }

  it('records each step as it finishes, in order: its place, node, step id, type, status, start, duration and output', async () => {
    const run = runCtx()
    expect(await walkOpsDefinition(twoSteps, run.ctx, { action_a: recorder(() => ({ id: 42 })).handler })).toEqual({ outcome: 'done' })
    expect(run.records).toEqual([
      { seq: 0, nodeId: 'shape', namespace: 'shape', stepType: 'transform', status: 'completed', startedAt: new Date(T0 + 5), durationMs: 5, output: { amount: 7 }, outputBytes: null, error: null },
      { seq: 1, nodeId: 'act', namespace: 'act', stepType: 'action_a', status: 'completed', startedAt: new Date(T0 + 15), durationMs: 5, output: { id: 42 }, outputBytes: null, error: null },
    ])
  })

  it('records a step before the next one runs, so a later step never runs ahead of its record', async () => {
    const order: string[] = []
    const run = runCtx({ recordStep: async (r) => { order.push(`record:${r.nodeId}`) } })
    const handler: OpsStepHandler = async ({ node: n }) => { order.push(`run:${n.id}`); return { output: null } }
    const def = { nodes: [node('a', 'action_a'), node('b', 'action_a')], edges: [edge('trigger', 'a'), edge('a', 'b')] }
    await walkOpsDefinition(def, run.ctx, { action_a: handler })
    expect(order).toEqual(['run:a', 'record:a', 'run:b', 'record:b'])
  })

  it('records a step that failed, threw or ended the run, with its error, and ends the run as before', async () => {
    const def = { nodes: [node('act', 'action_a')], edges: [edge('trigger', 'act')] }
    const cases: Array<[OpsStepHandler, Record<string, unknown>]> = [
      [async () => ({ output: null, error: 'partner refused' }), { outcome: 'failed', error: 'step act (action_a): partner refused' }],
      [async () => { throw new Error('boom') }, { outcome: 'failed', error: 'step act (action_a): boom' }],
      [async () => { throw new StepEndsRun({ outcome: 'needs_human', reason: 'send_outcome_unknown', error: 'example_failed: no answer' }) },
        { outcome: 'needs_human', reason: 'send_outcome_unknown', error: 'step act (action_a): example_failed: no answer' }],
    ]
    for (const [handler, end] of cases) {
      const run = runCtx()
      expect(await walkOpsDefinition(def, run.ctx, { action_a: handler })).toEqual(end)
      expect(run.records).toEqual([expect.objectContaining({ seq: 0, nodeId: 'act', status: 'failed', output: null, outputBytes: null, error: end.error })])
    }
  })

  it('records nothing for a step stopped with its run, or for a definition refused before any step ran', async () => {
    const stopped = runCtx()
    await expect(walkOpsDefinition({ nodes: [node('act', 'action_a')], edges: [edge('trigger', 'act')] }, stopped.ctx, {
      action_a: async () => { throw new RunStopped() },
    })).rejects.toBeInstanceOf(RunStopped)
    expect(stopped.records).toEqual([])
    const refused = runCtx()
    await walkOpsDefinition({ nodes: [node('call', 'webhook')], edges: [edge('trigger', 'call')] }, refused.ctx, {})
    expect(refused.records).toEqual([])
  })

  it('keeps an output over the cap by its size alone, and a plain null output as null', async () => {
    const run = runCtx()
    const big = { text: 'x'.repeat(STEP_OUTPUT_MAX_BYTES) }
    const def = { nodes: [node('big', 'action_a'), node('none', 'action_b')], edges: [edge('trigger', 'big'), edge('big', 'none')] }
    await walkOpsDefinition(def, run.ctx, { action_a: recorder(() => big).handler, action_b: recorder(() => null).handler })
    expect(run.records[0]).toMatchObject({ status: 'completed', output: null, outputBytes: JSON.stringify(big).length })
    expect(run.records[1]).toMatchObject({ status: 'completed', output: null, outputBytes: null })
  })

  it('a step whose record cannot be kept ends the run there, named, and no later step runs', async () => {
    const later = recorder()
    const run = runCtx({ recordStep: async () => { throw new StepUnrecorded('shape', 'record_ops_step failed (57014): canceling statement') } })
    const def = { ...twoSteps, nodes: [twoSteps.nodes[0], node('act', 'action_a')] }
    const end = await walkOpsDefinition(def, run.ctx, { action_a: later.handler })
    expect(end).toEqual({
      outcome: 'retry',
      error: 'step shape (transform): its step record was not kept (record_ops_step failed (57014): canceling statement), so the run stopped after it',
    })
    expect(later.seen).toEqual([])
  })

  it('a failed step whose record cannot be kept still ends the run failed, saying the record was not kept either', async () => {
    const run = runCtx({ recordStep: async () => { throw new StepUnrecorded('act', 'deadline') } })
    const end = await walkOpsDefinition({ nodes: [node('act', 'action_a')], edges: [edge('trigger', 'act')] }, run.ctx, {
      action_a: async () => ({ output: null, error: 'partner refused' }),
    })
    expect(end).toEqual({ outcome: 'failed', error: 'step act (action_a): partner refused; its step record was not kept either (deadline)' })
  })

  it('a record that finds the run stopped stops the walk, never read as recorded', async () => {
    const later = recorder()
    const run = runCtx({ recordStep: async () => { throw new RunStopped() } })
    await expect(walkOpsDefinition(twoSteps, run.ctx, { action_a: later.handler })).rejects.toBeInstanceOf(RunStopped)
    expect(later.seen).toEqual([])
  })
})
