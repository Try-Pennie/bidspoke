/**
 * Every execution id the engine mints must be a UUIDv7 (#869, Phase A1 of the
 * never delete without a backup milestone, plan in discussion #867).
 *
 * The execution archive keeps one bundle per execution in Snowflake, and the
 * hardest constraint on it is the point lookup: opening one execution's page must
 * not scan a table that grows forever. A time ordered id solves that for free,
 * because the UTC day is derivable from the id in the URL, so the read prunes to
 * one day of micro-partitions with no paid Search Optimization and no clustering
 * on a random key.
 *
 * This is asserted BEHAVIOURALLY, against the id `executeWorkflow` actually puts
 * on the context, rather than by scanning the source for a call to the helper. A
 * source scan passes as long as the right words appear somewhere in the file, so
 * it cannot tell a live call from a dead one, and the invariant it would be
 * protecting is the value that reaches the row (L3: wired is not proven).
 *
 * The companion half lives in routes/api/__tests__/workflows.test.ts: the canvas
 * test runner mints its id in the browser and posts it, so that is the one path
 * by which an id the engine did not generate can reach an execution, and the route
 * refuses a non-v7 one. Between them there is no way to create an execution the
 * archive cannot place.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { utcDayFromUuidV7, uuidv7 } from '@bidspoke/uuidv7'
import type { Env } from '../../index'
import type { ExecutionContext, WorkflowDefinition } from '../../types'

vi.mock('../definition-loader')
vi.mock('../../lib/env-loader', () => ({ loadEnvVars: vi.fn().mockResolvedValue({}) }))
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

import { executeWorkflow } from '../index'
import { loadWorkflowDefinition } from '../definition-loader'
import { executeNode } from '../nodes/index'

const definition = {
  trigger: { id: 'trigger', type: 'trigger', config: {} },
  nodes: [{ id: 'n', namespace: 'bid', type: 'salesforce', config: { retries: 0 } }],
  edges: [],
} as unknown as WorkflowDefinition

function makeKV() {
  const store = new Map<string, string>()
  return {
    async get(k: string, t?: string) { const v = store.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v },
    async put(k: string, v: string) { store.set(k, v) },
    async delete(k: string) { store.delete(k) },
  } as unknown as KVNamespace
}

const supabase = { from: () => ({ select: () => ({ in: () => Promise.resolve({ data: [] }) }) }) } as unknown as SupabaseClient

/**
 * Runs a workflow and returns the execution id the node executor was handed. Read
 * off the context the executor actually receives, rather than off the value
 * `executeWorkflow` returns, because the context is what every node, every step
 * row and the archive itself sees.
 */
async function run(options: Record<string, unknown> = {}): Promise<string> {
  const background: Promise<unknown>[] = []
  const env = { IDEMPOTENCY: makeKV(), WORKFLOW_CACHE: makeKV(), APP_URL: 'https://app.test', PII_REDACTION_FIELDS: '' } as unknown as Env
  const executionCtx = { waitUntil: (p: Promise<unknown>) => background.push(p.catch(() => {})) }

  await executeWorkflow(
    { workflowId: 'wf-869', payload: { lead: 1 }, source: 'engine', ...options },
    env,
    supabase,
    executionCtx,
  )
  await Promise.all(background.splice(0))

  const call = vi.mocked(executeNode).mock.calls[0]
  expect(call, 'the workflow did not execute a node').toBeDefined()
  const id = (call[1] as ExecutionContext).trigger.execution_id
  expect(id, 'the execution context carries no execution id at all').toBeTruthy()
  return id as string
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadWorkflowDefinition).mockResolvedValue({
    definition,
    workflow_version_id: 'v1',
    workflow_name: 'Execution id test',
    org_id: 'org-1',
    slack_channel: null,
  })
  vi.mocked(executeNode).mockResolvedValue({ output: { ok: true } } as never)
})

describe('the engine mints time-ordered execution ids (#869)', () => {
  it('produces an id the archive can derive a UTC day from', async () => {
    const id = await run()
    expect(
      utcDayFromUuidV7(id),
      `executeWorkflow minted ${id}, which carries no timestamp, so an archive lookup for it prunes nothing`,
    ).not.toBeNull()
  })

  it('derives the day the run actually started, not some other day', async () => {
    // A version 7 id whose timestamp is wrong still passes a shape check and still
    // yields a day, just the wrong one, and the lookup then finds nothing where a
    // missing archive and a mis-filed one look identical. So the day is checked
    // against the clock rather than merely being present.
    const id = await run()
    const today = new Date().toISOString().slice(0, 10)
    expect(utcDayFromUuidV7(id)).toBe(today)
  })

  it('still honours an id supplied by the caller', async () => {
    // The canvas test runner needs its own id before the run so it can open the
    // realtime channel. If the engine overrode it, the panel would listen on a
    // channel nothing ever writes to and the run would succeed invisibly.
    const supplied = uuidv7()
    expect(await run({ executionId: supplied })).toBe(supplied)
  })
})
