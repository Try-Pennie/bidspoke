/**
 * Tracing — verify trace_id propagates through structured logs and execution_steps
 * PRD Section 10.3: "To trace a single lead end-to-end: search by trace_id in
 * Cloudflare Logpush output or filter execution_steps in Supabase."
 *
 * Key invariants tested:
 *  1. Every structured log line emitted during an execution contains the trace_id
 *  2. Log lines carry required fields (event, workflow_id, step_namespace, step_type)
 *  3. step_start fires before step_complete for each node
 *  4. Failed steps emit step_error with error_type and error_message
 *  5. writeStepLog is called with the execution_id so rows are linkable to the
 *     workflow_executions row that carries the trace_id
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecutionContext, NodeDefinition } from '../../types'
import type { Env } from '../../index'

vi.mock('../../lib/circuit-breaker-client', () => ({
  CircuitBreakerClient: class {
    check() { return Promise.resolve({ allowed: true, state: 'closed' }) }
    recordSuccess() { return Promise.resolve() }
    recordError() { return Promise.resolve({ ok: true, state: 'closed', tripped: false }) }
  },
}))

vi.mock('../nodes/index')

import { executeNode } from '../nodes/index'
import type { StepLogEntry } from '../step-logger'
import { walkGraph } from '../index'

// ── Helpers ───────────────────────────────────────────────────────────────────

function node(id: string, namespace: string, type: NodeDefinition['type'] = 'code'): NodeDefinition {
  return { id, namespace, type, config: {} }
}

function chain(...nodes: NodeDefinition[]) {
  return {
    nodes,
    edges: nodes.slice(0, -1).map((n, i) => ({
      id: `e${i}`,
      source: n.id,
      target: nodes[i + 1].id,
    })),
  }
}

function makeCtx(traceId = 'trace-test-abc', workflowId = 'wf-test'): ExecutionContext {
  return {
    trigger: { payload: { lead_id: 'L1' }, source: 'test', workflow_id: workflowId, org_id: '', trace_id: traceId },
    steps: {},
    env: {},
  }
}

const TRACE_ID = 'trace-e2e-12345'
const WORKFLOW_ID = 'wf-lead-routing'
const EXECUTION_ID = 'exec-abcdef'
const WORKFLOW_VERSION_ID = 'ver-001'

const supabase = {} as SupabaseClient
const env = {} as Env

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('trace_id propagation — structured logs', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(executeNode).mockResolvedValue({ output: { ok: true } })
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
  })

  function parsedLogs(): Record<string, unknown>[] {
    return (consoleSpy.mock.calls as [unknown][])
      .filter(([line]) => {
        try { JSON.parse(line as string); return true } catch { return false }
      })
      .map(([line]) => JSON.parse(line as string) as Record<string, unknown>)
  }

  it('every structured log line contains the trace_id', async () => {
    const def = chain(
      node('a', 'validate', 'code'),
      node('b', 'enrich', 'code'),
      node('c', 'respond', 'response')
    )
    await walkGraph(makeCtx(TRACE_ID, WORKFLOW_ID), def, EXECUTION_ID, new Date().toISOString(), supabase, env, WORKFLOW_VERSION_ID)

    const lines = parsedLogs()
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line.trace_id).toBe(TRACE_ID)
    }
  })

  it('every structured log line contains workflow_id and workflow_version_id', async () => {
    const def = chain(node('a', 'step_a', 'code'), node('b', 'step_b', 'response'))
    await walkGraph(makeCtx(TRACE_ID, WORKFLOW_ID), def, EXECUTION_ID, new Date().toISOString(), supabase, env, WORKFLOW_VERSION_ID)

    for (const line of parsedLogs()) {
      expect(line.workflow_id).toBe(WORKFLOW_ID)
      expect(line.workflow_version_id).toBe(WORKFLOW_VERSION_ID)
    }
  })

  it('step-level log lines include step_namespace and step_type', async () => {
    const def = chain(node('a', 'credit_pull', 'code'), node('b', 'respond', 'response'))
    await walkGraph(makeCtx(TRACE_ID, WORKFLOW_ID), def, EXECUTION_ID, new Date().toISOString(), supabase, env, WORKFLOW_VERSION_ID)

    const stepLines = parsedLogs().filter((l) =>
      typeof l.event === 'string' && l.event.startsWith('step_')
    )
    expect(stepLines.length).toBeGreaterThan(0)
    for (const line of stepLines) {
      expect(typeof line.step_namespace).toBe('string')
      expect(typeof line.step_type).toBe('string')
    }
  })

  it('step_start fires before step_complete for each node', async () => {
    const def = chain(
      node('a', 'validate', 'code'),
      node('b', 'respond', 'response')
    )
    await walkGraph(makeCtx(TRACE_ID, WORKFLOW_ID), def, EXECUTION_ID, new Date().toISOString(), supabase, env, WORKFLOW_VERSION_ID)

    const lines = parsedLogs()
    const events = lines.map((l) => ({ event: l.event, ns: l.step_namespace }))

    for (const ns of ['validate', 'respond']) {
      const startIdx = events.findIndex((e) => e.event === 'step_start' && e.ns === ns)
      const completeIdx = events.findIndex((e) => e.event === 'step_complete' && e.ns === ns)
      expect(startIdx).toBeGreaterThanOrEqual(0)
      expect(completeIdx).toBeGreaterThan(startIdx)
    }
  })

  it('step_complete log includes duration_ms', async () => {
    const def = chain(node('a', 'step_a', 'code'), node('b', 'step_b', 'response'))
    await walkGraph(makeCtx(TRACE_ID, WORKFLOW_ID), def, EXECUTION_ID, new Date().toISOString(), supabase, env, WORKFLOW_VERSION_ID)

    const completeLogs = parsedLogs().filter((l) => l.event === 'step_complete')
    expect(completeLogs.length).toBeGreaterThan(0)
    for (const line of completeLogs) {
      expect(typeof line.duration_ms).toBe('number')
    }
  })

  it('failed step emits step_error with error_type and error_message', async () => {
    vi.mocked(executeNode)
      .mockResolvedValueOnce({ output: { ok: true } })           // step_a succeeds
      // step_b fails on every attempt — retries default to 2 now, so all
      // three attempts must reject for the step to terminate as failed.
      .mockRejectedValue(new Error('upstream timeout'))

    const def = chain(
      node('a', 'step_a', 'code'),
      node('b', 'step_b', 'code'),
      node('c', 'step_c', 'response')
    )

    // step_b exhausts its retries, so this used to live through the real 1.5s of
    // default backoff (1510ms). Record the delays instead and assert them
    // (#1063).
    const slept: number[] = []
    const ctx = makeCtx(TRACE_ID, WORKFLOW_ID)
    ctx.retrySleep = async (ms) => { slept.push(ms) }

    await expect(
      walkGraph(ctx, def, EXECUTION_ID, new Date().toISOString(), supabase, env, WORKFLOW_VERSION_ID)
    ).rejects.toThrow()

    // Two retries on the engine default, exponential from 500ms, and no sleep
    // after the attempt that gives up.
    expect(slept).toEqual([500, 1000])

    const errorLog = parsedLogs().find((l) => l.event === 'step_error' && l.step_namespace === 'step_b')
    expect(errorLog).toBeDefined()
    expect(errorLog!.trace_id).toBe(TRACE_ID)
    expect(typeof errorLog!.error_message).toBe('string')
    expect(errorLog!.error_type).toBeDefined()
  })
})

describe('trace_id propagation — execution_steps linkage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(executeNode).mockResolvedValue({ output: { result: 'ok' } })
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('step log queue is populated with the same execution_id for all steps', async () => {
    const def = chain(
      node('a', 'step_a', 'code'),
      node('b', 'step_b', 'code'),
      node('c', 'step_c', 'response')
    )
    const queue: StepLogEntry[] = []
    await walkGraph(makeCtx(TRACE_ID, WORKFLOW_ID), def, EXECUTION_ID, new Date().toISOString(), supabase, env, WORKFLOW_VERSION_ID, queue)

    expect(queue.length).toBe(3)
    // Every step row shares the same execution_id, which is the FK to workflow_executions
    // where trace_id lives — this is how execution_steps are traceable by trace_id
    for (const entry of queue) {
      expect(entry.execution_id).toBe(EXECUTION_ID)
    }
  })

  it('step log queue receives step_namespace and step_type for each step', async () => {
    const def = chain(
      node('a', 'credit_pull', 'code'),
      node('b', 'respond', 'response')
    )
    const queue: StepLogEntry[] = []
    await walkGraph(makeCtx(TRACE_ID, WORKFLOW_ID), def, EXECUTION_ID, new Date().toISOString(), supabase, env, WORKFLOW_VERSION_ID, queue)

    expect(queue.map((e) => e.step_namespace)).toEqual(['credit_pull', 'respond'])
    expect(queue.map((e) => e.step_type)).toEqual(['code', 'response'])
  })
})
