/**
 * executeWorkflow gives a recovery run the way to read where its lineage began
 * (#2176), the one fact a credit inquiry post's check cannot find for itself: the
 * run it recovers from, read from the run's own database through
 * readRecoveryOrigin, at most once a run, and only when a node asks. A fresh run
 * has none, so nothing in it can read a lineage.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { ExecutionContext, NodeDefinition } from '../../types'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
vi.mock('../definition-loader', () => ({
  loadWorkflowDefinition: vi.fn().mockResolvedValue({
    definition: { trigger: { id: 't', type: 'trigger', config: {} }, nodes: [{ id: 'a', namespace: 'a', type: 'code', config: { retries: 0 } }], edges: [] },
    org_id: 'org-1', workflow_version_id: 'v1', workflow_name: 'wf', is_active: true, lane: 'money',
  }),
}))
vi.mock('../../lib/env-loader', () => ({ loadEnvVars: vi.fn().mockResolvedValue({}) }))
vi.mock('../../lib/partner-constants-loader', () => ({ loadPartnerConstants: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/execution-alerts', () => ({ fireExecutionAlert: vi.fn().mockResolvedValue(undefined) }))

const seen: Array<{ recovery: ExecutionContext['recovery']; origins: unknown[] | null }> = []
vi.mock('../nodes/index', () => ({
  executeNode: vi.fn(async (_node: NodeDefinition, c: ExecutionContext) => {
    // Asked twice, as two inquiry posts in one run would: read once.
    seen.push({ recovery: c.recovery, origins: c.recoveryOrigin ? [await c.recoveryOrigin(), await c.recoveryOrigin()] : null })
    return { output: { ok: true } }
  }),
}))

import { executeWorkflow, moneyRuntime } from '../index'

const ROWS: Record<string, { id: string; started_at: string; parent_execution_id: string | null }> = {
  root: { id: 'root', started_at: '2026-10-15T20:00:00.000Z', parent_execution_id: null },
  replay1: { id: 'replay1', started_at: '2026-10-15T21:00:00.000Z', parent_execution_id: 'root' },
}

describe('executeWorkflow and the recovery lineage', () => {
  it('resume and replay each read the root of the lineage once, from the run database; a fresh run has no reader', async () => {
    const lineageReads: string[] = []
    const chain = {
      select: () => chain,
      insert: () => Promise.resolve({ error: null }),
      update: () => chain,
      // Only a one row read by id is a lineage read; the run's own row updates go by id too.
      eq: (col: string, v: string) =>
        Object.assign(Promise.resolve({ data: [], error: null }), chain, {
          maybeSingle: async () => {
            if (col === 'id') lineageReads.push(v)
            return { data: ROWS[v] ?? null, error: null }
          },
        }),
    }
    const sb = { from: (table: string) => (table === 'workflow_executions' ? chain : { ...chain, eq: () => Object.assign(Promise.resolve({ data: [], error: null }), chain) }) } as unknown as SupabaseClient
    const kv = { get: async () => null, put: async () => undefined, delete: async () => undefined } as unknown as KVNamespace
    const e = { IDEMPOTENCY: kv, WORKFLOW_CACHE: kv, APP_URL: 'https://app.test', PII_REDACTION_FIELDS: '' } as unknown as Env
    const ec = { waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined) }
    const base = { workflowId: 'wf-1', payload: { prospect: 'p-1' }, source: 's' }

    await executeWorkflow(base, e, moneyRuntime(sb), ec)
    expect(lineageReads).toEqual([])
    await executeWorkflow({ ...base, resumeFromExecutionId: 'replay1' }, e, moneyRuntime(sb), ec)
    expect(lineageReads).toEqual(['replay1', 'root'])
    await executeWorkflow({ ...base, parentExecutionId: 'root' }, e, moneyRuntime(sb), ec)
    expect(lineageReads).toEqual(['replay1', 'root', 'root'])

    const origin = { executionId: 'root', startedAtMs: Date.parse('2026-10-15T20:00:00.000Z') }
    expect(seen).toEqual([
      { recovery: undefined, origins: null },
      { recovery: 'resume', origins: [origin, origin] },
      { recovery: 'replay', origins: [origin, origin] },
    ])
  })
})
