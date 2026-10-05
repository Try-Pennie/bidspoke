/**
 * A variable saved against one workflow reaches that workflow's run, and only
 * that workflow's (#1681).
 *
 * Driven through executeWorkflow with the REAL env loader, a real KV double and
 * a database double that applies the filters it is sent, so the assertion is on
 * the env a node is actually handed, not on what the loader was called with.
 * Every other collaborator is the same double the lane test uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { ExecutionContext, LoadedWorkflow, WorkflowDefinition } from '../../types'

vi.mock('../definition-loader', async (orig) => ({ ...(await orig<object>()), loadWorkflowDefinition: vi.fn() }))
vi.mock('../../lib/partner-constants-loader', () => ({ loadPartnerConstants: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
vi.mock('../nodes/index')
vi.mock('../achieve-log', () => ({
  extractAchieveEvaluations: vi.fn().mockReturnValue([]),
  insertAchieveEvaluations: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/execution-alerts', () => ({ fireExecutionAlert: vi.fn().mockResolvedValue(undefined) }))

import { executeWorkflow, moneyRuntime } from '../index'
import { loadWorkflowDefinition } from '../definition-loader'
import { executeNode } from '../nodes/index'

const ORG = 'org-1'
const WF_A = 'wf-a'
const WF_B = 'wf-b'

const definition = {
  trigger: { id: 'trigger', type: 'trigger', config: {} },
  nodes: [{ id: 'n', namespace: 'step', type: 'transform', config: { retries: 0 } }],
  edges: [],
} as unknown as WorkflowDefinition

const loaded: LoadedWorkflow = {
  definition,
  workflow_version_id: 'v1',
  workflow_name: 'Scoped env test',
  org_id: ORG,
  slack_channel: null,
  lane: 'money',
}

const ROWS = [
  { organization_id: ORG, key: 'PARTNER_URL', value: 'https://org.example', is_secret: false, scope: 'global', workflow_id: null },
  { organization_id: ORG, key: 'PARTNER_URL', value: 'https://a.example', is_secret: false, scope: 'workflow', workflow_id: WF_A },
  { organization_id: ORG, key: 'A_ONLY', value: 'a-only', is_secret: false, scope: 'workflow', workflow_id: WF_A },
]

function makeKV() {
  const store = new Map<string, string>()
  return {
    async get(k: string, t?: string) { const v = store.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v },
    async put(k: string, v: string) { store.set(k, v) },
    async delete(k: string) { store.delete(k) },
  } as unknown as KVNamespace
}

// The env-var read honours its equality filters; every other read is the lane
// test's empty answer.
const client = {
  from: (table: string) => {
    if (table !== 'environment_variables') return { select: () => ({ in: () => Promise.resolve({ data: [] }) }) }
    const filters: Array<[string, unknown]> = []
    const chain = {
      select: () => chain,
      // Accepted, not applied: these cases hold far fewer rows than one page.
      order: () => chain,
      range: () => chain,
      eq: (col: string, val: unknown) => { filters.push([col, val]); return chain },
      then: (resolve: (r: unknown) => void) =>
        resolve({ data: ROWS.filter((r) => filters.every(([c, v]) => (r as Record<string, unknown>)[c] === v)), error: null }),
    }
    return chain
  },
} as unknown as SupabaseClient

// One Worker env for both runs, so the second is served from the cache the first filled.
const env = {
  IDEMPOTENCY: makeKV(),
  WORKFLOW_CACHE: makeKV(),
  APP_URL: 'https://app.test',
  PII_REDACTION_FIELDS: '',
  SECRET_ENCRYPTION_KEY: btoa('0'.repeat(32)),
} as unknown as Env

async function envHandedToTheNode(workflowId: string): Promise<Record<string, string>> {
  vi.mocked(executeNode).mockClear()
  const background: Promise<unknown>[] = []
  const executionCtx = { waitUntil: (p: Promise<unknown>) => background.push(p.catch(() => {})) }
  try {
    await executeWorkflow({ workflowId, payload: { lead: 1 }, source: 'engine' }, env, moneyRuntime(client), executionCtx)
  } finally {
    await Promise.all(background.splice(0))
  }
  expect(executeNode).toHaveBeenCalledTimes(1)
  return (vi.mocked(executeNode).mock.calls[0][1] as ExecutionContext).env
}

beforeEach(() => {
  vi.mocked(loadWorkflowDefinition).mockResolvedValue(loaded)
  vi.mocked(executeNode).mockResolvedValue({ output: { ok: true } } as never)
})

describe('workflow scoped env vars in a run (#1681)', () => {
  it("hands the run its own workflow's value, over the org value of the same key", async () => {
    expect(await envHandedToTheNode(WF_A)).toEqual({ PARTNER_URL: 'https://a.example', A_ONLY: 'a-only' })
  })

  it("hands a sibling workflow's run the org value and none of the other workflow's", async () => {
    expect(await envHandedToTheNode(WF_B)).toEqual({ PARTNER_URL: 'https://org.example' })
  })
})
