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
import { CheckpointStoreMissing, CONTINUATION_BUDGET, type CheckpointStore, type ContinuationBudget } from '../checkpoint'
import { CheckpointNotNamed, RunStopped, StepUnrecorded, type RunCheckpoints, type RunContext, type StepSend } from '../run-invocation'
import { OPS_WALK_MAX_STEPS, StepEndsRun, walkOpsDefinition, type OpsStepHandler } from '../run-walk'
import { STEP_OUTPUT_MAX_BYTES } from '../step-output'
import type { OpsVersionVariables } from '../../lib/ops-gateway-contract'

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
function runCtx(over: { recordStep?: (record: OpsStepRecord) => Promise<void>; checkpoints?: Partial<RunCheckpoints>; tick?: number } = {}) {
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
    stateVersion: 4,
    checkpoints: {
      name: async (ack) => {
        named.push(ack)
        return 'recorded'
      },
      read: async () => {
        const last = named[named.length - 1]
        return last === undefined ? null : { key: last.key, stateVersion: 4, steps: last.steps, sha256: last.sha256, bytes: last.bytes }
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

  it('refuses a definition that reads env.* when its version was kept with no variables, rather than sending blanks', async () => {
    const r = recorder()
    const def = { nodes: [node('shape', 'transform', { mappings: [{ source: 'env.API_BASE', target: 'base' }] }), node('act', 'action_a')], edges: [edge('trigger', 'shape'), edge('shape', 'act')] }
    for (const variables of [undefined, null]) {
      const end = await walkOpsDefinition(def, runCtx().ctx, { action_a: r.handler }, variables === undefined ? {} : { variables })
      expect(end).toEqual({
        outcome: 'failed',
        error: 'the definition reads env.API_BASE, and version 3 was saved before ops kept the values of its variables with it, so nothing was run; save the workflow again',
      })
    }
    expect(r.seen).toHaveLength(0)
  })

  it('refuses an edge condition that reads env.* with no variables kept, which would compare against a blank', async () => {
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

describe('walkOpsDefinition: the plain variables kept with the version (#2702)', () => {
  const gatedOn = (field: string) => ({ ...edge('shape', 'act'), condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field, operator: 'eq', value: 'us' }] }] } })
  // A path in a transform, a template in a handler's settings, and a path in an edge condition.
  const def = {
    nodes: [node('shape', 'transform', { mappings: [{ source: 'env.API_BASE', target: 'base' }] }), node('act', 'action_a', { list: '{{env.LIST_ID}}' })],
    edges: [edge('trigger', 'shape'), gatedOn('env.REGION')],
  }

  it('hands the run the values kept with its version, in steps, templates and edge conditions alike', async () => {
    const seenEnv: Array<Record<string, string>> = []
    const r = recorder((steps) => steps)
    const handler: OpsStepHandler = async (args) => {
      seenEnv.push({ ...args.ctx.env })
      return r.handler(args)
    }
    const variables = { values: { API_BASE: 'https://api.example.test', LIST_ID: 'list-7', REGION: 'us' }, secretKeys: [] }
    expect(await walkOpsDefinition(def, runCtx().ctx, { action_a: handler }, { variables })).toEqual({ outcome: 'done' })
    expect(r.seen[0].steps).toEqual({ shape: { base: 'https://api.example.test' } })
    // The run is handed exactly the values its definition reads, nothing else.
    expect(seenEnv).toEqual([{ API_BASE: 'https://api.example.test', LIST_ID: 'list-7', REGION: 'us' }])
  })

  it('hands a step only the variables the definition reads, even when more were kept', async () => {
    const seenEnv: Array<Record<string, string>> = []
    const handler: OpsStepHandler = async ({ ctx }) => {
      seenEnv.push({ ...ctx.env })
      return { output: null }
    }
    const variables = { values: { API_BASE: 'a', LIST_ID: 'b', REGION: 'us', UNREAD: 'c' }, secretKeys: [] }
    expect(await walkOpsDefinition(def, runCtx().ctx, { action_a: handler }, { variables })).toEqual({ outcome: 'done' })
    expect(seenEnv).toEqual([{ API_BASE: 'a', LIST_ID: 'b', REGION: 'us' }])
  })

  it('a value kept with the version is what the run uses, whatever the variable holds now', async () => {
    // The walk is handed only what was kept at the save; it has no way to read the variable as it is now.
    const r = recorder()
    const kept = { values: { API_BASE: 'kept-at-save', LIST_ID: 'l', REGION: 'us' }, secretKeys: [] }
    await walkOpsDefinition(def, runCtx().ctx, { action_a: r.handler }, { variables: kept })
    await walkOpsDefinition(def, runCtx().ctx, { action_a: r.handler }, { variables: { ...kept, values: { ...kept.values, API_BASE: 'saved-again' } } })
    expect(r.seen.map((s) => (s.steps as { shape: { base: string } }).shape.base)).toEqual(['kept-at-save', 'saved-again'])
  })

  it('refuses, before any step runs, a definition that reads a secret variable, naming it and saying a credential belongs in a connection', async () => {
    const r = recorder()
    const variables = { values: { LIST_ID: 'l', REGION: 'us' }, secretKeys: ['API_BASE'] }
    const run = runCtx()
    expect(await walkOpsDefinition(def, run.ctx, { action_a: r.handler }, { variables })).toEqual({
      outcome: 'failed',
      error: 'the definition reads the secret variable env.API_BASE, and an ops run is never given a secret: a credential an ops step uses belongs in a connection, so nothing was run',
    })
    expect(r.seen).toHaveLength(0)
    expect(run.records).toEqual([])
  })

  it('refuses, before any step runs, a variable that did not exist when the version was saved, naming it, never sending a blank', async () => {
    const r = recorder()
    const variables = { values: { API_BASE: 'a', REGION: 'us' }, secretKeys: [] }
    expect(await walkOpsDefinition(def, runCtx().ctx, { action_a: r.handler }, { variables })).toEqual({
      outcome: 'failed',
      error: 'the definition reads env.LIST_ID, which was not a variable of this workflow when version 3 was saved, so nothing was run; add it and save the workflow again',
    })
    expect(r.seen).toHaveLength(0)
  })

  it('names every secret and every missing variable at once, the secret first', async () => {
    const variables = { values: { REGION: 'us' }, secretKeys: ['LIST_ID'] }
    const end = await walkOpsDefinition(def, runCtx().ctx, { action_a: recorder().handler }, { variables })
    expect(end).toEqual({
      outcome: 'failed',
      error: 'the definition reads the secret variable env.LIST_ID, and an ops run is never given a secret: a credential an ops step uses belongs in a connection; '
        + 'and it reads env.API_BASE, which was not a variable of this workflow when version 3 was saved, so nothing was run',
    })
  })

  it('a definition that reads no variable runs whether or not any were kept', async () => {
    const plain = { nodes: [node('act', 'action_a')], edges: [edge('trigger', 'act')] }
    const kept: Array<OpsVersionVariables | null> = [null, { values: {}, secretKeys: [] }, { values: { X: '1' }, secretKeys: ['S'] }]
    for (const variables of kept) {
      expect(await walkOpsDefinition(plain, runCtx().ctx, { action_a: recorder().handler }, { variables })).toEqual({ outcome: 'done' })
    }
  })
})
