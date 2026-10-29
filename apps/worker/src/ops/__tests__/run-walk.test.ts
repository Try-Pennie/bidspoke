/**
 * The ops run body (#1950, PR 5 of B3): a definition walked step by step with
 * the ops lane's in memory executors, and every other step through a handler
 * that sends only through ctx.send (the ledgered send), which is what #2339's
 * app_action registers. These tests drive walkOpsDefinition with a RunContext
 * whose send is recorded, and prove the walk's routing, what it refuses before
 * any step runs, and how each kind of step failure ends the run.
 */
import { describe, expect, it } from 'vitest'
import { NODE_TRAITS, NODE_TYPES } from '@bidspoke/node-types'
import { organizationIdFrom } from '../ops-db'
import type { ClaimedRun, NamedCheckpoint, OpsStepRecord } from '../ops-writes'
import { CheckpointStoreMissing, CONTINUATION_BUDGET, type Checkpoint, type CheckpointStore, type ContinuationBudget } from '../checkpoint'
import { CheckpointNotNamed, RunStopped, StepUnrecorded, type RunCheckpoints, type RunContext, type StepSend } from '../run-invocation'
import { OPS_WALK_MAX_STEPS, StepEndsRun, walkOpsDefinition, type OpsStepHandler } from '../run-walk'
import { STEP_OUTPUT_MAX_BYTES } from '../step-output'
import type { RunVariablesRecord } from '../run-variables'
import type { ContinuationMode } from '../run-vocabulary'

const RUN: ClaimedRun = {
  runRequestId: '0192f4a0-0000-7000-8000-000000000001', organizationId: organizationIdFrom('6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'),
  workflowId: '00000000-0000-4000-8000-0000000019a1', workflowVersion: 3, triggerKind: 'schedule', claimToken: 'token-1',
  claimExpiresAt: '2026-10-17T10:03:31.000Z', stateVersion: 2, attempts: 0, unchargedAttempts: 0, maxAttempts: 3, resumeReason: null,
  executionChainId: '0192f4a0-0000-7000-9000-000000000001', resumedFromExecutionId: null, payload: { slot: '2026-10-17T10:00:00Z', amount: 7 }, payloadRef: null,
}

const T0 = Date.parse('2026-10-24T14:00:00.000Z')

/**
 * A run context whose sends and step records are kept; its clock moves 5 ms
 * each time it is read (or by tick, when the test sets it). Its checkpoint
 * port keeps what is named, and over.checkpoints replaces it.
 */
function runCtx(over: {
  recordStep?: (record: OpsStepRecord) => Promise<void>; checkpoints?: Partial<RunCheckpoints>; tick?: number; continuations?: number; stateVersion?: number
  runVariables?: RunVariablesRecord | null
} = {}) {
  const sent: Array<StepSend<unknown>> = []
  const records: OpsStepRecord[] = []
  const named: Array<{ steps: number; key: string; sha256: string; bytes: number }> = []
  let t = T0
  const ctx: RunContext = {
    run: RUN, executionId: '0192f4a0-0000-7000-8000-0000000000ee', attempt: 1, signal: new AbortController().signal,
    send: async <T>(step: StepSend<T>) => {
      sent.push(step as StepSend<unknown>)
      const a = await step.forward({ signal: new AbortController().signal, requestId: 'req-1' })
      if (a.kind !== 'answered') throw new Error(`not answered: ${a.kind}`)
      return { status: a.status, value: a.value }
    },
    now: () => (t += over.tick ?? 5),
    recordStep: over.recordStep ?? (async (record) => { records.push(record) }),
    stateVersion: over.stateVersion ?? 4,
    continuations: over.continuations ?? 0,
    runVariables: over.runVariables ?? null,
    checkpoints: {
      name: async (ack) => {
        named.push(ack)
        return 'recorded'
      },
      read: async () => {
        const last = named[named.length - 1]
        return last === undefined ? null : { key: last.key, stateVersion: over.stateVersion ?? 4, steps: last.steps, sha256: last.sha256, bytes: last.bytes }
      },
      ...over.checkpoints,
    },
  }
  return { ctx, sent, records, named }
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

  it('refuses a definition that reads env.* when the run has no record of its variables, rather than sending blanks', async () => {
    const r = recorder()
    const def = { nodes: [node('shape', 'transform', { mappings: [{ source: 'env.API_BASE', target: 'base' }] }), node('act', 'action_a')], edges: [edge('trigger', 'shape'), edge('shape', 'act')] }
    const end = await walkOpsDefinition(def, runCtx().ctx, { action_a: r.handler })
    expect(end).toEqual({
      outcome: 'failed',
      error: 'the definition reads env.API_BASE, and the run has no record of its variables from when it started, so nothing was run',
    })
    expect(r.seen).toHaveLength(0)
  })

  it('refuses an edge condition that reads env.* with no variables recorded, which would compare against a blank', async () => {
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

// ── time sliced continuation, observe mode (#1951) ──────────────────────────

/** A store in memory with R2's write only where nothing is. */
function memoryStore(over: Partial<CheckpointStore> = {}) {
  const objects = new Map<string, string>()
  const store: CheckpointStore = {
    put: async (key, body) => {
      if (objects.has(key)) return objects.get(key) === body ? 'already_written' : Promise.reject(new Error('taken'))
      objects.set(key, body)
      return 'written'
    },
    get: async (key) => objects.get(key) ?? null,
    ...over,
  }
  return { store, objects }
}

/** A budget whose slice ends after `steps` steps, nothing else reaching its limit. */
const stepsBudget = (steps: number): ContinuationBudget => ({ ...CONTINUATION_BUDGET, sliceSteps: steps })

function observing(store: () => CheckpointStore, budget: ContinuationBudget = stepsBudget(2)) {
  const logs: Array<Record<string, unknown>> = []
  return { continuation: { mode: 'observe' as const, budget, store, log: (e: Record<string, unknown>) => { logs.push(e) } }, logs }
}

const chain = (n: number) => ({
  nodes: Array.from({ length: n }, (_, i) => node(`s${i}`, 'action_a')),
  edges: [edge('trigger', 's0'), ...Array.from({ length: n - 1 }, (_, i) => edge(`s${i}`, `s${i + 1}`))],
})

const failures = (logs: Array<Record<string, unknown>>) => logs.filter((l) => l.step === 'observe_failed')

describe('walkOpsDefinition: a slice boundary in observe mode (#1951)', () => {
  it('off, or with no continuation, writes nothing whatever the budget', async () => {
    const m = memoryStore()
    const run = runCtx()
    const off = { continuation: { mode: 'off' as const, budget: stepsBudget(1), store: () => m.store, log: () => undefined } }
    expect(await walkOpsDefinition(chain(4), run.ctx, { action_a: recorder().handler }, off)).toEqual({ outcome: 'done' })
    expect(m.objects.size).toBe(0)
    expect(run.named).toEqual([])
  })

  it('writes, names and reads back a checkpoint at each boundary, verifies it would resume where the walk is, and ends the run exactly as without', async () => {
    const m = memoryStore()
    const o = observing(() => m.store)
    const run = runCtx()
    const r = recorder((seen) => ({ saw: Object.keys(seen).length }))
    expect(await walkOpsDefinition(chain(5), run.ctx, { action_a: r.handler }, o)).toEqual({ outcome: 'done' })
    // Every step still ran once, in order, in this invocation.
    expect(r.seen.map((s) => s.node)).toEqual(['s0', 's1', 's2', 's3', 's4'])
    expect([...m.objects.keys()]).toEqual([
      `checkpoints/v1/${RUN.organizationId}/${RUN.runRequestId}/4-2.json`,
      `checkpoints/v1/${RUN.organizationId}/${RUN.runRequestId}/4-4.json`,
    ])
    expect(run.named.map((n) => n.steps)).toEqual([2, 4])
    expect(failures(o.logs)).toEqual([])
    const would = o.logs.filter((l) => l.step === 'would_suspend')
    expect(would.map((l) => [l.steps, l.next_node_id])).toEqual([[2, 's2'], [4, 's4']])
    const first = JSON.parse(m.objects.get(`checkpoints/v1/${RUN.organizationId}/${RUN.runRequestId}/4-2.json`)!)
    expect(first).toMatchObject({ stateVersion: 4, executionId: run.ctx.executionId, nextNodeId: 's2', path: [{ nodeId: 's0', edgeId: 's0-s1' }, { nodeId: 's1', edgeId: 's1-s2' }] })
  })

  it('failure shape 1 through the walk: a checkpoint after a branch that took its second arm resumes down that arm', async () => {
    const m = memoryStore()
    const o = observing(() => m.store)
    const def = {
      nodes: [
        node('shape', 'action_a'),
        node('pick', 'branch', { branches: [{ label: 'big', condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: 'trigger.payload.amount', operator: 'gt', value: '50' }] }] } }] }),
        node('a', 'action_b'), node('b', 'action_c'),
      ],
      edges: [edge('trigger', 'shape'), edge('shape', 'pick'), edge('pick', 'a', 'big'), edge('pick', 'b', 'else')],
    }
    const a = recorder()
    const b = recorder()
    expect(await walkOpsDefinition(def, runCtx().ctx, { action_a: recorder().handler, action_b: a.handler, action_c: b.handler }, o)).toEqual({ outcome: 'done' })
    expect(b.seen).toHaveLength(1)
    expect(failures(o.logs)).toEqual([])
    expect(o.logs.find((l) => l.step === 'would_suspend')).toMatchObject({ steps: 2, next_node_id: 'b' })
  })

  it('a slice also ends on its wall clock and on its sends', async () => {
    const wall = memoryStore()
    const byWall = observing(() => wall.store, { ...CONTINUATION_BUDGET, sliceWallMs: 100 })
    await walkOpsDefinition(chain(3), runCtx({ tick: 60 }).ctx, { action_a: recorder().handler }, byWall)
    expect(byWall.logs.filter((l) => l.step === 'would_suspend').length).toBeGreaterThan(0)

    const sends = memoryStore()
    const bySends = observing(() => sends.store, { ...CONTINUATION_BUDGET, sliceSends: 2 })
    const sender: OpsStepHandler = async ({ node: n, run: rc }) => {
      await rc.send({ nodeId: n.id, seq: 0, method: 'GET', url: 'https://api.example.test/x', idempotent: true, forward: async () => ({ kind: 'answered', status: 200, value: 1 }) })
      return { output: { ok: true } }
    }
    await walkOpsDefinition(chain(4), runCtx().ctx, { action_a: sender }, bySends)
    expect(bySends.logs.filter((l) => l.step === 'would_suspend').map((l) => l.steps)).toEqual([2])
  })

  it('with the R2 binding missing, says so by name once and runs the run to its end as before', async () => {
    const o = observing(() => { throw new CheckpointStoreMissing() }, stepsBudget(1))
    const run = runCtx()
    expect(await walkOpsDefinition(chain(4), run.ctx, { action_a: recorder().handler }, o)).toEqual({ outcome: 'done' })
    expect(failures(o.logs)).toEqual([expect.objectContaining({ reason: 'store_missing', error: expect.stringMatching(/OPS_CHECKPOINTS/) })])
    expect(run.named).toEqual([])
  })

  it('a checkpoint write that fails names nothing, says why, and the run goes on', async () => {
    const m = memoryStore({ put: async () => { throw new Error('R2 answered 500') } })
    const o = observing(() => m.store)
    const run = runCtx()
    expect(await walkOpsDefinition(chain(3), run.ctx, { action_a: recorder().handler }, o)).toEqual({ outcome: 'done' })
    expect(failures(o.logs)).toEqual([expect.objectContaining({ reason: 'write_failed', error: expect.stringMatching(/R2 answered 500/) })])
    expect(run.named).toEqual([])
  })

  it('a checkpoint written and never named (the acknowledgement failed) is never read back as the run\'s', async () => {
    const m = memoryStore()
    const o = observing(() => m.store)
    const run = runCtx({ checkpoints: { name: async () => { throw new CheckpointNotNamed('record_run_checkpoint: deadline') } } })
    expect(await walkOpsDefinition(chain(3), run.ctx, { action_a: recorder().handler }, o)).toEqual({ outcome: 'done' })
    expect(m.objects.size).toBe(1)
    expect(failures(o.logs)).toEqual([expect.objectContaining({ reason: 'not_named' })])
    expect(o.logs.some((l) => l.step === 'would_suspend')).toBe(false)
  })

  it('a stale holder\'s acknowledgement stops the walk: its claim is lost', async () => {
    const m = memoryStore()
    const later = recorder()
    const run = runCtx({ checkpoints: { name: async () => { throw new RunStopped() } } })
    await expect(walkOpsDefinition(chain(4), run.ctx, { action_a: later.handler }, observing(() => m.store))).rejects.toBeInstanceOf(RunStopped)
    expect(later.seen.map((s) => s.node)).toEqual(['s0', 's1'])
  })

  it('reads back through the run\'s own row: a run that names another checkpoint, or none, is reported, never trusted', async () => {
    const m = memoryStore()
    const none = observing(() => m.store)
    await walkOpsDefinition(chain(3), runCtx({ checkpoints: { read: async () => null } }).ctx, { action_a: recorder().handler }, none)
    expect(failures(none.logs)).toEqual([expect.objectContaining({ reason: 'not_named_on_read' })])

    const corrupt = memoryStore({ get: async () => '{"v":1}' })
    const c = observing(() => corrupt.store)
    await walkOpsDefinition(chain(3), runCtx().ctx, { action_a: recorder().handler }, c)
    expect(failures(c.logs)).toEqual([expect.objectContaining({ reason: 'checkpoint_corrupt' })])
  })

  it('names a step whose output would not come back the same from a checkpoint', async () => {
    const m = memoryStore()
    const o = observing(() => m.store)
    const dated: OpsStepHandler = async () => ({ output: { at: new Date('2026-10-27T14:00:00.000Z') } })
    expect(await walkOpsDefinition(chain(3), runCtx().ctx, { action_a: dated }, o)).toEqual({ outcome: 'done' })
    expect(failures(o.logs)).toEqual([expect.objectContaining({ reason: 'replay_differs', error: expect.stringMatching(/s0/) })])
  })

  it('records a crossing of a whole run cap without ending the run (observe first)', async () => {
    const m = memoryStore()
    const o = observing(() => m.store, { ...stepsBudget(2), runStateBytes: 10, runComputeMs: 1 })
    expect(await walkOpsDefinition(chain(3), runCtx().ctx, { action_a: recorder().handler }, o)).toEqual({ outcome: 'done' })
    expect(o.logs.filter((l) => l.step === 'cap_crossed').map((l) => l.cap).sort()).toEqual(['max_compute_exceeded', 'max_state_exceeded'])
  })
})

// ── suspend and resume (#1951, OPS_CONTINUATION=on) ───────────────────────

/**
 * One run's row across its slices, as the ops database keeps it: the
 * checkpoint it names and how many times it was suspended to continue. Each
 * slice is a new holder at a later state version; the test counts a
 * continuation where complete_run_request would.
 */
function runRow() {
  const row = { continuations: 0, stateVersion: 4, pointer: null as NamedCheckpoint | null, reads: 0 }
  const slice = (over: { checkpoints?: Partial<RunCheckpoints>; tick?: number } = {}) => {
    row.stateVersion += 2
    const sv = row.stateVersion
    return runCtx({
      tick: over.tick, continuations: row.continuations, stateVersion: sv,
      checkpoints: {
        name: async (ack) => {
          row.pointer = { key: ack.key, stateVersion: sv, steps: ack.steps, sha256: ack.sha256, bytes: ack.bytes }
          return 'recorded'
        },
        read: async () => {
          row.reads++
          return row.pointer
        },
        ...over.checkpoints,
      },
    })
  }
  return { row, slice }
}

function slicing(mode: ContinuationMode, store: () => CheckpointStore, budget: ContinuationBudget = stepsBudget(2)) {
  const logs: Array<Record<string, unknown>> = []
  return { continuation: { mode, budget, store, log: (e: Record<string, unknown>) => { logs.push(e) } }, logs }
}

const stepsOf = (logs: Array<Record<string, unknown>>, step: string) => logs.filter((l) => l.step === step)

describe('walkOpsDefinition: suspend and resume (#1951, on)', () => {
  it('on: at a slice boundary writes, names and verifies the checkpoint, then ends the slice to continue, running no later step', async () => {
    const m = memoryStore()
    const o = slicing('on', () => m.store)
    const run = runCtx()
    const r = recorder()
    expect(await walkOpsDefinition(chain(5), run.ctx, { action_a: r.handler }, o)).toEqual({ outcome: 'continue' })
    expect(r.seen.map((x) => x.node)).toEqual(['s0', 's1'])
    expect(run.named.map((n) => n.steps)).toEqual([2])
    expect(stepsOf(o.logs, 'suspend')).toEqual([expect.objectContaining({ steps: 2, next_node_id: 's2', key: `checkpoints/v1/${RUN.organizationId}/${RUN.runRequestId}/4-2.json` })])
    expect(stepsOf(o.logs, 'suspend_failed')).toEqual([])
  })

  it('resumes a continued run where its checkpoint left it: no completed step runs again, every output is restored, and its step records start again from 0', async () => {
    const m = memoryStore()
    const { row, slice } = runRow()
    const r = recorder((seen) => ({ saw: Object.keys(seen).sort().join(',') }))
    const first = slice()
    expect(await walkOpsDefinition(chain(5), first.ctx, { action_a: r.handler }, slicing('on', () => m.store))).toEqual({ outcome: 'continue' })
    row.continuations++
    const second = slice()
    expect(await walkOpsDefinition(chain(5), second.ctx, { action_a: r.handler }, slicing('on', () => m.store))).toEqual({ outcome: 'continue' })
    row.continuations++
    const third = slice()
    const o3 = slicing('on', () => m.store)
    expect(await walkOpsDefinition(chain(5), third.ctx, { action_a: r.handler }, o3)).toEqual({ outcome: 'done' })

    // Each step ran once, in order, across the three slices.
    expect(r.seen.map((x) => x.node)).toEqual(['s0', 's1', 's2', 's3', 's4'])
    // The first step of the second slice reads what the first slice's steps answered.
    expect(r.seen[2].steps).toEqual({ s0: { saw: '' }, s1: { saw: 's0' } })
    expect(r.seen[4].steps).toMatchObject({ s3: { saw: 's0,s1,s2' } })
    // A slice's records are its own attempt's, from place 0.
    expect(second.records.map((x) => [x.seq, x.nodeId])).toEqual([[0, 's2'], [1, 's3']])
    expect(third.records.map((x) => [x.seq, x.nodeId])).toEqual([[0, 's4']])
    expect(stepsOf(o3.logs, 'resumed')).toEqual([expect.objectContaining({ steps: 4, next_node_id: 's4', continuations: 2 })])
  })

  it('carries the whole run\'s totals across slices: the checkpoint holds every step walked, the compute adds up and the slices count', async () => {
    const m = memoryStore()
    const { row, slice } = runRow()
    const r = recorder()
    await walkOpsDefinition(chain(5), slice().ctx, { action_a: r.handler }, slicing('on', () => m.store))
    row.continuations++
    await walkOpsDefinition(chain(5), slice().ctx, { action_a: r.handler }, slicing('on', () => m.store))
    const read = (key: string) => JSON.parse(m.objects.get(key)!) as Checkpoint
    const keys = [...m.objects.keys()]
    expect(keys).toHaveLength(2)
    const [one, two] = keys.map(read)
    expect(one.totals).toMatchObject({ steps: 2, slices: 1 })
    expect(two.totals).toMatchObject({ steps: 4, slices: 2 })
    expect(two.path.map((p) => [p.seq, p.nodeId])).toEqual([[0, 's0'], [1, 's1'], [2, 's2'], [3, 's3']])
    expect(two.totals.computeMs).toBeGreaterThan(one.totals.computeMs)
    expect(two.stateVersion).toBe(row.stateVersion)
  })

  it('the step cap counts every slice: a run that loops for ever ends failed with max_steps_exceeded, and no further continuation', async () => {
    const m = memoryStore()
    const { row, slice } = runRow()
    const loop = { nodes: [node('spin', 'action_a')], edges: [edge('trigger', 'spin'), edge('spin', 'spin')] }
    const r = recorder()
    const ends: unknown[] = []
    for (let i = 0; i < 10; i++) {
      const end = await walkOpsDefinition(loop, slice().ctx, { action_a: r.handler }, slicing('on', () => m.store, stepsBudget(50)))
      ends.push(end)
      if ((end as { outcome: string }).outcome !== 'continue') break
      row.continuations++
    }
    expect(ends.slice(0, 4)).toEqual(Array(4).fill({ outcome: 'continue' }))
    expect(ends[4]).toEqual({ outcome: 'failed', reason: 'max_steps_exceeded', error: `the run walked ${OPS_WALK_MAX_STEPS} steps, the most one run may` })
    expect(ends).toHaveLength(5)
    expect(r.seen).toHaveLength(OPS_WALK_MAX_STEPS)
  })

  it('a whole run cap crossing is judged on the run\'s totals, not the slice\'s (observe first: nothing is ended)', async () => {
    const m = memoryStore()
    const { row, slice } = runRow()
    const budget = { ...stepsBudget(2), runComputeMs: 25 }
    const first = slicing('on', () => m.store, budget)
    await walkOpsDefinition(chain(5), slice().ctx, { action_a: recorder().handler }, first)
    row.continuations++
    const second = slicing('on', () => m.store, budget)
    expect(await walkOpsDefinition(chain(5), slice().ctx, { action_a: recorder().handler }, second)).toEqual({ outcome: 'continue' })
    const firstValue = stepsOf(first.logs, 'suspend')[0].compute_ms as number
    const crossed = stepsOf(second.logs, 'cap_crossed').find((l) => l.cap === 'max_compute_exceeded')
    expect(crossed).toBeDefined()
    expect(crossed!.value as number).toBeGreaterThan(firstValue)
  })

  it('resumes a continued run in every mode, off and observe too, since starting it again from its first step would repeat what its earlier slices sent', async () => {
    for (const mode of ['off', 'observe'] as const) {
      const m = memoryStore()
      const { row, slice } = runRow()
      const r = recorder()
      await walkOpsDefinition(chain(4), slice().ctx, { action_a: r.handler }, slicing('on', () => m.store))
      row.continuations++
      expect(await walkOpsDefinition(chain(4), slice().ctx, { action_a: r.handler }, slicing(mode, () => m.store))).toEqual({ outcome: 'done' })
      expect(r.seen.map((x) => x.node), mode).toEqual(['s0', 's1', 's2', 's3'])
    }
  })

  it('a run that has never continued is walked from its first step and reads no checkpoint, whatever its row names (an observe checkpoint, a retry)', async () => {
    const m = memoryStore()
    const { row, slice } = runRow()
    await walkOpsDefinition(chain(3), slice().ctx, { action_a: recorder().handler }, slicing('observe', () => m.store))
    expect(row.pointer).not.toBeNull()
    row.reads = 0
    const r = recorder()
    expect(await walkOpsDefinition(chain(3), slice().ctx, { action_a: r.handler }, slicing('on', () => m.store, stepsBudget(50)))).toEqual({ outcome: 'done' })
    expect(r.seen.map((x) => x.node)).toEqual(['s0', 's1', 's2'])
    expect(row.reads).toBe(0)
  })

  it('money only node types never reach a resume: each is refused before any checkpoint is read', async () => {
    const money = NODE_TYPES.filter((t) => NODE_TRAITS[t].lane === 'money')
    expect(money.length).toBeGreaterThan(0)
    for (const t of money) {
      const m = memoryStore()
      const { row, slice } = runRow()
      row.continuations = 1
      row.pointer = { key: 'checkpoints/v1/x', stateVersion: 4, steps: 1, sha256: 'a'.repeat(64), bytes: 10 }
      const gets: string[] = []
      const def = { nodes: [node('s0', 'action_a'), node('money', t)], edges: [edge('trigger', 's0'), edge('s0', 'money')] }
      const end = await walkOpsDefinition(def, slice().ctx, { action_a: recorder().handler }, slicing('on', () => ({ ...m.store, get: async (k) => { gets.push(k); return null } })))
      expect(end, t).toEqual({ outcome: 'failed', error: `an ops run cannot take a step of type ${t} yet, so nothing was run` })
      expect(row.reads, t).toBe(0)
      expect(gets, t).toEqual([])
    }
  })

  it('a continued run whose checkpoint cannot be had or trusted is never walked from its first step: a lasting refusal fails it by name, a passing fault retries it', async () => {
    const def = chain(4)
    type Arranged = { store?: () => CheckpointStore; checkpoints?: Partial<RunCheckpoints>; def?: unknown }
    /** A continued run's next slice, its first slice having suspended at s2 into m. */
    const continued = async (m: ReturnType<typeof memoryStore>) => {
      const rr = runRow()
      await walkOpsDefinition(def, rr.slice().ctx, { action_a: recorder().handler }, slicing('on', () => m.store))
      rr.row.continuations++
      return rr
    }
    const cases: Array<{ name: string; arrange: (m: ReturnType<typeof memoryStore>, rr: ReturnType<typeof runRow>) => Arranged; end: unknown }> = [
      { name: 'names none', arrange: (_m, rr) => { rr.row.pointer = null; return {} }, end: { outcome: 'failed', error: expect.stringMatching(/has continued 1 time and names no checkpoint/) } },
      { name: 'object gone', arrange: (m) => { m.objects.clear(); return {} }, end: { outcome: 'failed', error: expect.stringMatching(/^checkpoint_missing: /) } },
      { name: 'object altered', arrange: (m) => { for (const k of m.objects.keys()) m.objects.set(k, '{"v":1}'); return {} }, end: { outcome: 'failed', error: expect.stringMatching(/^checkpoint_corrupt: /) } },
      {
        name: 'route not in the definition',
        arrange: () => ({ def: { nodes: def.nodes, edges: def.edges.filter((e) => e.id !== 's0-s1').concat([{ id: 's0-s1b', source: 's0', target: 's1' }]) } }),
        end: { outcome: 'failed', error: expect.stringMatching(/^checkpoint_route_mismatch: /) },
      },
      { name: 'read failed', arrange: () => ({ checkpoints: { read: async () => { throw new CheckpointNotNamed('run_checkpoint: deadline') } } }), end: { outcome: 'retry', error: expect.stringMatching(/run_checkpoint: deadline/) } },
      { name: 'bucket missing', arrange: () => ({ store: () => { throw new CheckpointStoreMissing() } }), end: { outcome: 'retry', error: expect.stringMatching(/OPS_CHECKPOINTS/) } },
      { name: 'R2 failed', arrange: (m) => ({ store: () => ({ ...m.store, get: async () => { throw new Error('R2 answered 500') } }) }), end: { outcome: 'retry', error: expect.stringMatching(/R2 answered 500/) } },
    ]
    for (const c of cases) {
      const m = memoryStore()
      const rr = await continued(m)
      const a = c.arrange(m, rr)
      const r = recorder()
      const o = slicing('on', a.store ?? (() => m.store))
      const end = await walkOpsDefinition(a.def ?? def, rr.slice({ checkpoints: a.checkpoints }).ctx, { action_a: r.handler }, o)
      expect(end, c.name).toEqual(c.end)
      expect(r.seen, c.name).toEqual([])
      expect(stepsOf(o.logs, 'resume_refused'), c.name).toHaveLength(1)
    }
  })

  it('a continued run whose read finds the run no longer this holder\'s stops: its claim is lost', async () => {
    const m = memoryStore()
    const rr = runRow()
    await walkOpsDefinition(chain(4), rr.slice().ctx, { action_a: recorder().handler }, slicing('on', () => m.store))
    rr.row.continuations++
    const r = recorder()
    await expect(walkOpsDefinition(chain(4), rr.slice({ checkpoints: { read: async () => { throw new RunStopped() } } }).ctx, { action_a: r.handler }, slicing('on', () => m.store)))
      .rejects.toBeInstanceOf(RunStopped)
    expect(r.seen).toEqual([])
  })

  it('on: a boundary that cannot verify its checkpoint never suspends: it says why and the slice carries on', async () => {
    const m = memoryStore({ put: async () => { throw new Error('R2 answered 500') } })
    const o = slicing('on', () => m.store)
    const run = runCtx()
    const r = recorder()
    expect(await walkOpsDefinition(chain(3), run.ctx, { action_a: r.handler }, o)).toEqual({ outcome: 'done' })
    expect(r.seen.map((x) => x.node)).toEqual(['s0', 's1', 's2'])
    expect(stepsOf(o.logs, 'suspend_failed')).toEqual([expect.objectContaining({ reason: 'write_failed' })])
    expect(stepsOf(o.logs, 'suspend')).toEqual([])
  })
})

describe('walkOpsDefinition: the variables a run started with (#2998)', () => {
  const gatedOn = (field: string) => ({ ...edge('shape', 'act'), condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field, operator: 'eq', value: 'us' }] }] } })
  // A path in a transform, a template in a handler's settings, and a path in an edge condition.
  const def = {
    nodes: [node('shape', 'transform', { mappings: [{ source: 'env.API_BASE', target: 'base' }] }), node('act', 'action_a', { list: '{{env.LIST_ID}}' })],
    edges: [edge('trigger', 'shape'), gatedOn('env.REGION')],
  }
  const recorded = (values: Record<string, string>, secretKeys: string[] = []): RunVariablesRecord => ({ source: 'bidding', servedAt: '2026-10-29T14:00:00.000Z', values, secretKeys })

  it('hands the run the values it recorded when it started, in steps, templates and edge conditions alike', async () => {
    const seenEnv: Array<Record<string, string>> = []
    const r = recorder((steps) => steps)
    const handler: OpsStepHandler = async (args) => {
      seenEnv.push({ ...args.ctx.env })
      return r.handler(args)
    }
    const run = runCtx({ runVariables: recorded({ API_BASE: 'https://api.example.test', LIST_ID: 'list-7', REGION: 'us' }) })
    expect(await walkOpsDefinition(def, run.ctx, { action_a: handler })).toEqual({ outcome: 'done' })
    expect(r.seen[0].steps).toEqual({ shape: { base: 'https://api.example.test' } })
    // The run is handed exactly the values its definition reads, nothing else.
    expect(seenEnv).toEqual([{ API_BASE: 'https://api.example.test', LIST_ID: 'list-7', REGION: 'us' }])
  })

  it('hands a step only the variables the definition reads, even when more were recorded', async () => {
    const seenEnv: Array<Record<string, string>> = []
    const handler: OpsStepHandler = async ({ ctx }) => {
      seenEnv.push({ ...ctx.env })
      return { output: null }
    }
    const run = runCtx({ runVariables: recorded({ API_BASE: 'a', LIST_ID: 'b', REGION: 'us', UNREAD: 'c' }) })
    expect(await walkOpsDefinition(def, run.ctx, { action_a: handler })).toEqual({ outcome: 'done' })
    expect(seenEnv).toEqual([{ API_BASE: 'a', LIST_ID: 'b', REGION: 'us' }])
  })

  it('gives a step a secret variable served for this start: ops reads secrets (Dan, 2026-10-29)', async () => {
    const seenEnv: Array<Record<string, string>> = []
    const handler: OpsStepHandler = async ({ ctx }) => {
      seenEnv.push({ ...ctx.env })
      return { output: null }
    }
    const run = runCtx({ runVariables: recorded({ LIST_ID: 'l', REGION: 'us' }, ['API_BASE']) })
    expect(await walkOpsDefinition(def, run.ctx, { action_a: handler }, { secretValues: { API_BASE: 'fake-walk-secret-value' } })).toEqual({ outcome: 'done' })
    expect(seenEnv).toEqual([{ API_BASE: 'fake-walk-secret-value', LIST_ID: 'l', REGION: 'us' }])
  })

  it('refuses, before any step runs, a variable that did not exist when the run started, naming it, never sending a blank', async () => {
    const r = recorder()
    const run = runCtx({ runVariables: recorded({ API_BASE: 'a', REGION: 'us' }) })
    expect(await walkOpsDefinition(def, run.ctx, { action_a: r.handler })).toEqual({
      outcome: 'failed',
      error: 'the definition reads env.LIST_ID, which was not a variable of this workflow when the run started, so nothing was run; add it and run it again',
    })
    expect(r.seen).toHaveLength(0)
    expect(run.records).toEqual([])
  })

  it('refuses, before any step runs, a secret the run read when it started and was not served again', async () => {
    const r = recorder()
    const run = runCtx({ runVariables: recorded({ LIST_ID: 'l', REGION: 'us' }, ['API_BASE']) })
    expect(await walkOpsDefinition(def, run.ctx, { action_a: r.handler }, { secretValues: {} })).toMatchObject({
      outcome: 'failed', error: expect.stringMatching(/^the definition reads the secret variable env\.API_BASE, which the run read when it started/),
    })
    expect(r.seen).toHaveLength(0)
  })

  it('a definition that reads no variable runs whether or not the run recorded any', async () => {
    const plain = { nodes: [node('act', 'action_a')], edges: [edge('trigger', 'act')] }
    for (const runVariables of [null, recorded({}), recorded({ X: '1' }, ['S'])]) {
      expect(await walkOpsDefinition(plain, runCtx({ runVariables }).ctx, { action_a: recorder().handler })).toEqual({ outcome: 'done' })
    }
  })
})

// ── a secret is never stored (#2998) ─────────────────────────────────────────

describe('walkOpsDefinition: a secret value is masked out of everything the run keeps (#2998)', () => {
  const SECRET = 'fake-planted-walk-secret'
  const withSecret = (): RunVariablesRecord => ({ source: 'bidding', servedAt: '2026-10-29T14:00:00.000Z', values: { API_BASE: 'https://api.example.test' }, secretKeys: ['API_TOKEN'] })
  // A transform that copies the secret into its output, then a step that answers with it and one that fails quoting it.
  const leaky = {
    nodes: [
      node('shape', 'transform', { mappings: [{ source: 'env.API_TOKEN', target: 'token' }, { source: 'env.API_BASE', target: 'base' }] }),
      node('echo', 'action_a'), node('boom', 'action_b'),
    ],
    edges: [edge('trigger', 'shape'), edge('shape', 'echo'), edge('echo', 'boom')],
  }
  const echo: OpsStepHandler = async ({ ctx }) => ({ output: { sent: `Authorization: Bearer ${ctx.env.API_TOKEN}`, url: `https://x.test/?t=${encodeURIComponent(ctx.env.API_TOKEN)}` } })
  const boom: OpsStepHandler = async ({ ctx }) => { throw new Error(`the service refused token ${ctx.env.API_TOKEN}`) }

  it('masks the secret in every step record and in the run\'s error, while the steps themselves had it', async () => {
    const run = runCtx({ runVariables: withSecret() })
    const end = await walkOpsDefinition(leaky, run.ctx, { action_a: echo, action_b: boom }, { secretValues: { API_TOKEN: SECRET } })
    expect(end).toEqual({ outcome: 'failed', error: 'step boom (action_b): the service refused token API_TOKEN' })
    expect(run.records.map((r) => r.namespace)).toEqual(['shape', 'echo', 'boom'])
    expect(run.records[0].output).toEqual({ token: 'API_TOKEN', base: 'https://api.example.test' })
    expect(run.records[1].output).toEqual({ sent: 'Authorization: Bearer API_TOKEN', url: 'https://x.test/?t=API_TOKEN' })
    expect(run.records[2].error).toBe('step boom (action_b): the service refused token API_TOKEN')
    // The planted value is nowhere in anything kept.
    expect(JSON.stringify({ end, records: run.records })).not.toContain(SECRET)
  })

  it('never writes a checkpoint holding a secret, and says so once, carrying on in the slice', async () => {
    const m = memoryStore()
    const o = slicing('on', () => m.store, stepsBudget(1))
    const run = runCtx({ runVariables: withSecret() })
    const end = await walkOpsDefinition(leaky, run.ctx, { action_a: echo, action_b: async () => ({ output: null }) }, { ...o, secretValues: { API_TOKEN: SECRET } })
    // Every boundary falls after the transform holding the secret, so no slice ended and nothing was written.
    expect(end).toEqual({ outcome: 'done' })
    expect(m.objects.size).toBe(0)
    expect(run.named).toEqual([])
    expect(stepsOf(o.logs, 'checkpoint_skipped')).toEqual([expect.objectContaining({ reason: 'holds_secret' })])
    expect(JSON.stringify(o.logs)).not.toContain(SECRET)
  })

  it('still writes a checkpoint when no step output holds a secret, the secret read only in a step\'s settings', async () => {
    const m = memoryStore()
    const o = slicing('on', () => m.store, stepsBudget(1))
    const run = runCtx({ runVariables: withSecret() })
    const reads = { nodes: [node('a', 'action_b', { token: '{{env.API_TOKEN}}' }), node('b', 'action_b')], edges: [edge('trigger', 'a'), edge('a', 'b')] }
    expect(await walkOpsDefinition(reads, run.ctx, { action_b: async () => ({ output: { ok: true } }) }, { ...o, secretValues: { API_TOKEN: SECRET } })).toEqual({ outcome: 'continue' })
    expect(m.objects.size).toBe(1)
    expect([...m.objects.values()].join('')).not.toContain(SECRET)
  })
})
