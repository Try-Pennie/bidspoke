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

const seen: Array<{ recovery: ExecutionContext['recovery']; origins: unknown[] | null; holds: { held: boolean; keys: string[] } | null }> = []
/** The at-risk keys the run's KV was asked for, across runs. */
const kvAsked: string[] = []
vi.mock('../nodes/index', () => ({
  executeNode: vi.fn(async (node: NodeDefinition, c: ExecutionContext) => {
    // Asked twice, as two inquiry posts in one run would: read once.
    const origins = c.recoveryOrigin ? [await c.recoveryOrigin(), await c.recoveryOrigin()] : null
    // The read-back's hold, asked of the nearest run of the lineage for this step.
    const held = c.readBackHolds && origins ? await c.readBackHolds(origins[0].lineage[0], node.namespace) : null
    seen.push({ recovery: c.recovery, origins, holds: held === null ? null : { held, keys: [...kvAsked] } })
    return { output: { ok: true } }
  }),
}))

import { executeWorkflow, moneyRuntime } from '../index'
import { startAtRiskWatch } from '../at-risk-writes'
import { CREDIT_INQUIRY_APEX_PATH } from '../inquiry-post'
import { VirtualClock } from '../../lib/__tests__/_virtual-clock'

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
    const kv = {
      get: async (k: string) => {
        if (k.startsWith('at-risk-write:')) kvAsked.push(k)
        return null
      },
      put: async () => undefined,
      delete: async () => undefined,
    } as unknown as KVNamespace
    const e = { IDEMPOTENCY: kv, WORKFLOW_CACHE: kv, APP_URL: 'https://app.test', PII_REDACTION_FIELDS: '' } as unknown as Env
    const ec = { waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined) }
    const base = { workflowId: 'wf-1', payload: { prospect: 'p-1' }, source: 's' }

    await executeWorkflow(base, e, moneyRuntime(sb), ec)
    expect(lineageReads).toEqual([])
    await executeWorkflow({ ...base, resumeFromExecutionId: 'replay1' }, e, moneyRuntime(sb), ec)
    expect(lineageReads).toEqual(['replay1', 'root'])
    await executeWorkflow({ ...base, parentExecutionId: 'root' }, e, moneyRuntime(sb), ec)
    expect(lineageReads).toEqual(['replay1', 'root', 'root'])

    const start = Date.parse('2026-10-15T20:00:00.000Z')
    const fromReplay = { executionId: 'root', startedAtMs: start, lineage: ['replay1', 'root'] }
    const fromRoot = { executionId: 'root', startedAtMs: start, lineage: ['root'] }
    expect(seen).toEqual([
      { recovery: undefined, origins: null, holds: null },
      { recovery: 'resume', origins: [fromReplay, fromReplay], holds: { held: false, keys: ['at-risk-write:replay1:a'] } },
      { recovery: 'replay', origins: [fromRoot, fromRoot], holds: { held: false, keys: ['at-risk-write:replay1:a', 'at-risk-write:root:a'] } },
    ])
  })

  // The hold is the read-back's own answer, not a second predicate: a credit
  // inquiry post the watch recorded, unsettled, reads as held through it.
  it('a recovery run reads a held inquiry post of its lineage as held, through the read-back\'s classifier', async () => {
    const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 11)).toString('base64')
    const store = new Map<string, string>()
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
    } as unknown as KVNamespace
    await startAtRiskWatch({ kv: kv as never, keys: KEY, clock: new VirtualClock(), run: { orgId: 'org-1', workflowId: 'wf-1', executionId: 'replay1' }, stepNamespace: 'a' })
      .recordNow({ object: 'Submission__c', record_id: 'a0XUi00000AbCdEFGH', operation: 'apex', apex_path: CREDIT_INQUIRY_APEX_PATH, body: { submissionId: 'a0XUi00000AbCdEFGH', inquiriesJson: '{"inquiries":[{"type":"H"}]}' } })
    const sb = {
      from: () => {
        const chain: Record<string, unknown> = {}
        Object.assign(chain, {
          select: () => chain,
          insert: () => Promise.resolve({ error: null }),
          update: () => chain,
          eq: (_c: string, v: string) => Object.assign(Promise.resolve({ data: [], error: null }), chain, { maybeSingle: async () => ({ data: ROWS[v] ?? null, error: null }) }),
        })
        return chain
      },
    } as unknown as SupabaseClient
    const e = { IDEMPOTENCY: kv, WORKFLOW_CACHE: kv, APP_URL: 'https://app.test', PII_REDACTION_FIELDS: '', SECRET_ENCRYPTION_KEY: KEY } as unknown as Env
    const ec = { waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined) }
    const before = seen.length
    await executeWorkflow({ workflowId: 'wf-1', payload: { prospect: 'p-1' }, source: 's', resumeFromExecutionId: 'replay1' }, e, moneyRuntime(sb), ec)
    expect(seen[before]?.holds?.held).toBe(true)
  })
})
