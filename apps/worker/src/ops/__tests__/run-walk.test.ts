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
import type { ClaimedRun } from '../ops-writes'
import { RunStopped, type RunContext, type StepSend } from '../run-invocation'
import { OPS_WALK_MAX_STEPS, walkOpsDefinition, type OpsStepHandler } from '../run-walk'

const RUN: ClaimedRun = {
  runRequestId: '0192f4a0-0000-7000-8000-000000000001', organizationId: organizationIdFrom('6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'),
  workflowId: '00000000-0000-4000-8000-0000000019a1', workflowVersion: 3, triggerKind: 'schedule', claimToken: 'token-1',
  claimExpiresAt: '2026-10-17T10:03:31.000Z', stateVersion: 2, attempts: 0, unchargedAttempts: 0, maxAttempts: 3, resumeReason: null,
  executionChainId: '0192f4a0-0000-7000-9000-000000000001', resumedFromExecutionId: null, payload: { slot: '2026-10-17T10:00:00Z', amount: 7 }, payloadRef: null,
}

function runCtx() {
  const sent: Array<StepSend<unknown>> = []
  const ctx: RunContext = {
    run: RUN, executionId: '0192f4a0-0000-7000-8000-0000000000ee', attempt: 1, signal: new AbortController().signal,
    send: async <T>(step: StepSend<T>) => {
      sent.push(step as StepSend<unknown>)
      const a = await step.forward({ signal: new AbortController().signal, requestId: 'req-1' })
      if (a.kind !== 'answered') throw new Error(`not answered: ${a.kind}`)
      return { status: a.status, value: a.value }
    },
  }
  return { ctx, sent }
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
