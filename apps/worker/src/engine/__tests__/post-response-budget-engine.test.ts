/**
 * A live run's post-response writes inside Cloudflare's waitUntil window (#1850).
 *
 * Cloudflare cancels waitUntil work 30 seconds after the response. The engine
 * writes the execution record, the step rows, the lead sighting and their dead
 * letters there, and in a real database outage the old ladders (finalize alone
 * spanned 112 seconds) were cancelled before the dead letter ran: the one record
 * that a served lead was lost was the thing that never got written.
 *
 * These drive the real step logger, durability seam and sighting writers
 * against a database double whose availability is a function of a virtual
 * clock, so a 25 second outage runs in milliseconds and every write and every
 * dead letter is stamped with the virtual time it happened at.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { WorkflowDefinition } from '../../types'

vi.mock('../definition-loader')
vi.mock('../../lib/env-loader', () => ({ loadEnvVars: vi.fn().mockResolvedValue({}) }))
vi.mock('../../lib/partner-constants-loader', () => ({ loadPartnerConstants: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../nodes/index')
vi.mock('../achieve-log', () => ({
  extractAchieveEvaluations: vi.fn().mockReturnValue([]),
  insertAchieveEvaluations: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/execution-alerts', () => ({ fireExecutionAlert: vi.fn().mockResolvedValue(undefined) }))
// The dead letter's durable record is the KV window count, written before the
// Slack connection is read. The read itself retries on real timers, so it is
// answered here rather than waited on, and the alert is captured, not sent.
vi.mock('../../lib/slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/slack')>()),
  getSlackConnection: vi.fn(),
  sendOutcomeDeadLetterAlert: vi.fn(),
}))

import { executeWorkflow, moneyRuntime } from '../index'
import { loadWorkflowDefinition } from '../definition-loader'
import { executeNode } from '../nodes/index'
import { getSlackConnection, sendOutcomeDeadLetterAlert } from '../../lib/slack'
import { NO_ROW_MATCHED_CODE } from '../../lib/db-retry'
import { POST_RESPONSE_BUDGET_MS, DEAD_LETTER_RESERVE_MS } from '../../lib/post-response-budget'
import { VirtualClock } from '../../lib/__tests__/_virtual-clock'

const WF_ID = 'wf-budget'
const RESPONSE = { status: 200, headers: {}, body: { accepted: true } }
const CUTOFF = POST_RESPONSE_BUDGET_MS - DEAD_LETTER_RESERVE_MS

const definition = {
  trigger: { id: 'trigger', type: 'trigger', config: {} },
  nodes: [{ id: 'r', namespace: 'offer_response', type: 'response', config: { retries: 0 } }],
  edges: [],
} as unknown as WorkflowDefinition

type Availability = 'up' | 'down' | 'hang'

interface DbCall {
  at: number
  table: string
  op: string
  answered: Availability
}

/**
 * A PostgREST stand-in. `down` answers the way PostgREST does when it cannot
 * reach Postgres (an empty-bodied 503); `hang` never answers; `up` stores rows,
 * enforces the step rows' foreign key on the execution row, and reports the
 * rows an UPDATE matched, as the real writers require.
 */
function makeDb(clock: VirtualClock, availability: () => Availability) {
  const calls: DbCall[] = []
  const executions = new Map<string, Record<string, unknown>>()
  const sightings = new Map<string, Record<string, unknown>>()
  const steps: Record<string, unknown>[] = []

  function answer(table: string, op: string, payload: unknown, filters: Record<string, unknown>) {
    const state = availability()
    calls.push({ at: clock.now(), table, op, answered: state })
    if (state === 'hang') return clock.hang()
    if (state === 'down') {
      return Promise.resolve({ data: null, error: { message: '' }, status: 503, statusText: 'Service Unavailable' })
    }
    const rowsOf = (p: unknown) => (Array.isArray(p) ? p : [p]) as Record<string, unknown>[]
    if (table === 'workflow_executions') {
      if (op === 'insert') {
        const row = rowsOf(payload)[0]
        if (executions.has(row.id as string)) return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } })
        executions.set(row.id as string, { ...row })
        return Promise.resolve({ data: null, error: null, status: 201 })
      }
      if (op === 'update') {
        const row = executions.get(filters.id as string)
        if (!row) return Promise.resolve({ data: [], error: null })
        Object.assign(row, payload as object)
        return Promise.resolve({ data: [{ id: row.id }], error: null })
      }
    }
    if (table === 'execution_steps' && op === 'insert') {
      const rows = rowsOf(payload)
      if (rows.some((r) => !executions.has(r.execution_id as string))) {
        return Promise.resolve({ data: null, error: { code: '23503', message: 'violates foreign key constraint' } })
      }
      steps.push(...rows)
      return Promise.resolve({ data: null, error: null, status: 201 })
    }
    if (table === 'lead_sightings') {
      if (op === 'insert') {
        const row = rowsOf(payload)[0]
        sightings.set(row.id as string, { ...row })
        return Promise.resolve({ data: null, error: null, status: 201 })
      }
      if (op === 'update') {
        const row = sightings.get(filters.id as string)
        if (!row) return Promise.resolve({ data: [], error: null })
        Object.assign(row, payload as object)
        return Promise.resolve({ data: [{ id: row.id }], error: null })
      }
    }
    return Promise.resolve({ data: op === 'select' ? null : [], error: null })
  }

  function from(table: string) {
    let op = 'select'
    let payload: unknown
    const filters: Record<string, unknown> = {}
    const chain: Record<string | symbol, unknown> = new Proxy({} as Record<string | symbol, unknown>, {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            answer(table, op, payload, filters).then(resolve, reject)
        }
        return (...args: unknown[]) => {
          if (prop === 'insert' || prop === 'update' || prop === 'upsert' || prop === 'delete') {
            op = prop
            payload = args[0]
          }
          if (prop === 'eq' && op !== 'select') filters[args[0] as string] = args[1]
          return chain
        }
      },
    })
    return chain
  }

  return { client: { from } as unknown as SupabaseClient, calls, executions, sightings, steps }
}

function makeKV(clock: VirtualClock) {
  const store = new Map<string, string>()
  const puts: Array<{ at: number; key: string }> = []
  const kv = {
    async get(k: string, t?: string) {
      const v = store.get(k)
      return v === undefined ? null : t === 'json' ? JSON.parse(v) : v
    },
    async put(k: string, v: string) {
      puts.push({ at: clock.now(), key: k })
      store.set(k, v)
    },
    async delete(k: string) {
      store.delete(k)
    },
  }
  return { kv: kv as unknown as KVNamespace, puts }
}

async function run(availability: (clock: VirtualClock) => Availability) {
  const clock = new VirtualClock()
  const db = makeDb(clock, () => availability(clock))
  const idempotency = makeKV(clock)
  const background: Promise<unknown>[] = []
  const env = {
    IDEMPOTENCY: idempotency.kv,
    WORKFLOW_CACHE: makeKV(clock).kv,
    APP_URL: 'https://app.test',
    PII_REDACTION_FIELDS: '',
  } as unknown as Env
  const executionCtx = { waitUntil: (p: Promise<unknown>) => background.push(p.catch(() => {})) }

  const result = await executeWorkflow(
    { workflowId: WF_ID, payload: { lead: 1 }, source: 'engine' },
    env,
    { ...moneyRuntime(db.client), clock },
    executionCtx,
  )
  // The response is out at virtual time zero. Let the post-response work run.
  await clock.run()
  for (let i = 0; i < 6 && background.length; i++) await Promise.all(background.splice(0))

  const deadLetters = (label: string) =>
    idempotency.puts.filter((p) => p.key.startsWith('outcome-deadletter-window:') && p.key.endsWith(`:${label}`))
  return { result, clock, db, deadLetters }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadWorkflowDefinition).mockResolvedValue({
    definition,
    workflow_version_id: 'v1',
    workflow_name: 'Budget Test',
    org_id: 'org-1',
    slack_channel: null,
    lane: 'money',
  })
  vi.mocked(executeNode).mockResolvedValue({ output: RESPONSE, earlyResponse: RESPONSE })
  vi.mocked(getSlackConnection).mockResolvedValue({ config_alerts_enabled: true } as never)
  vi.mocked(sendOutcomeDeadLetterAlert).mockResolvedValue(true)
})

/** The alert payload the execution_finalize dead letter would post. */
function finalizeAlert() {
  const call = vi.mocked(sendOutcomeDeadLetterAlert).mock.calls.find(([, p]) => p.label === 'execution_finalize')
  return call?.[1]
}

describe('post-response writes with the database down for the whole window (#1850)', () => {
  it('dead-letters the lost execution record before the dead-letter tail begins', async () => {
    const { result, deadLetters } = await run(() => 'down')
    expect(result.status).toBe(200)

    const finalize = deadLetters('execution_finalize')
    expect(finalize).toHaveLength(1)
    expect(finalize[0].at).toBeLessThanOrEqual(CUTOFF)
  })

  it('dead-letters the lost lead sighting in time too', async () => {
    const { deadLetters } = await run(() => 'down')
    for (const label of ['lead_sightings.insert', 'lead_sightings.finalize']) {
      const letters = deadLetters(label)
      expect(letters, label).toHaveLength(1)
      expect(letters[0].at, label).toBeLessThanOrEqual(CUTOFF)
    }
  })

  // The alert copy says a finalize failure that is not a missing row left the
  // row at 'running' for the strand drain. With the create failed too there is
  // no row, so the dead letter must say so rather than promise a recovery.
  it('tells the alert the execution row was never created, so it does not promise a drain recovery', async () => {
    await run(() => 'down')
    const alert = finalizeAlert()
    expect(alert?.error_code).toBe(NO_ROW_MATCHED_CODE)
    expect(alert?.error_message).toContain('never confirmed')
    expect(alert?.error_message).toContain('503')
  })

  it('makes no database request after the budget ends', async () => {
    const { db, clock } = await run(() => 'down')
    expect(db.calls.length).toBeGreaterThan(0)
    expect(Math.max(...db.calls.map((c) => c.at))).toBeLessThanOrEqual(CUTOFF)
    expect(clock.now()).toBeLessThanOrEqual(POST_RESPONSE_BUDGET_MS)
  })
})

describe('a finalize lost after the execution row was created (#1850)', () => {
  it('keeps the drain-recoverable wording, since the row is there at running', async () => {
    // Up for the create at time zero, down for everything after it.
    let created = false
    const { db, result } = await run(() => {
      if (created) return 'down'
      created = true
      return 'up'
    })
    expect(db.executions.get(result.executionId)?.status).toBe('running')
    const alert = finalizeAlert()
    expect(alert).toBeDefined()
    expect(alert?.error_code).not.toBe(NO_ROW_MATCHED_CODE)
  })
})

describe('post-response writes with the database back partway through (#1850)', () => {
  it('lands the run whole, with no dead letter, when the database returns before the create gives up', async () => {
    const { db, deadLetters, result } = await run((clock) => (clock.now() < 12_000 ? 'down' : 'up'))
    const row = db.executions.get(result.executionId)
    expect(row?.status).toBe('completed')
    expect(db.steps).toHaveLength(1)
    expect(deadLetters('execution_finalize')).toEqual([])
    expect(deadLetters('lead_sightings.finalize')).toEqual([])
  })

  it('rebuilds the execution row and its step rows at finalize when the create had already given up', async () => {
    const { db, deadLetters, result } = await run((clock) => (clock.now() < 16_000 ? 'down' : 'up'))
    const row = db.executions.get(result.executionId)
    expect(row).toBeDefined()
    expect(row?.status).not.toBe('running')
    expect(db.steps).toHaveLength(1)
    expect(deadLetters('execution_finalize')).toEqual([])
    expect(Math.max(...db.calls.map((c) => c.at))).toBeLessThanOrEqual(POST_RESPONSE_BUDGET_MS)
  })
})

describe('post-response writes with a database that never answers (#1850)', () => {
  it('still writes the dead letters, at the cut-off', async () => {
    const { deadLetters, clock } = await run(() => 'hang')
    for (const label of ['execution_finalize', 'lead_sightings.insert', 'lead_sightings.finalize']) {
      const letters = deadLetters(label)
      expect(letters, label).toHaveLength(1)
      expect(letters[0].at, label).toBeLessThanOrEqual(CUTOFF)
    }
    expect(clock.now()).toBeLessThanOrEqual(POST_RESPONSE_BUDGET_MS)
  })
})

/**
 * #1860: a run that answered early (continue_after_response) and whose remaining
 * walk never finishes. Finalize waited for that walk with no limit, so the run was
 * never recorded and its dead letter never written. The wait now stops at its own
 * cut-off, and finalize records what is known with a named reason.
 */
describe('a continuation that never finishes after the answer (#1860)', () => {
  const withContinuation = {
    trigger: { id: 'trigger', type: 'trigger', config: {} },
    nodes: [
      { id: 'r', namespace: 'offer_response', type: 'response', config: { continue_after_response: true, retries: 0 } },
      { id: 'p', namespace: 'patch_sf', type: 'code', config: { retries: 0 } },
    ],
    edges: [{ id: 'e0', source: 'r', target: 'p' }],
  } as unknown as WorkflowDefinition

  it('finalizes the run inside the budget, as degraded with a named reason, while the walk is still out', async () => {
    vi.mocked(loadWorkflowDefinition).mockResolvedValue({
      definition: withContinuation,
      workflow_version_id: 'v1',
      workflow_name: 'Budget Test',
      org_id: 'org-1',
      slack_channel: null,
      lane: 'money',
    })
    // The remaining work ends 60 s after the answer on the virtual clock: well past
    // the whole budget, where Cloudflare would already have cancelled it.
    let late: () => Promise<{ output: unknown }> = () => new Promise(() => {})
    vi.mocked(executeNode).mockImplementation(async (node) => {
      if (node.namespace === 'offer_response') return { output: RESPONSE, earlyResponse: RESPONSE, continueAfterResponse: true }
      return late()
    })
    const { db, result, deadLetters } = await run((c) => {
      late = () => c.sleep(60_000).then(() => ({ output: { late: true } }))
      return 'up'
    })
    expect(result.status).toBe(200)
    const row = db.executions.get(result.executionId)
    expect(row?.status).toBe('degraded')
    expect(String(row?.error_message)).toMatch(/did not finish within .* of the answer/)
    // The run's finalize and the lead sighting's finalize both ran, and every
    // database call the run made landed inside the budget.
    expect(db.calls.some((c) => c.table === 'workflow_executions' && c.op === 'update')).toBe(true)
    expect(db.calls.some((c) => c.table === 'lead_sightings' && c.op === 'update')).toBe(true)
    expect(Math.max(...db.calls.map((c) => c.at))).toBeLessThanOrEqual(POST_RESPONSE_BUDGET_MS)
    // Unfinished is not a failed Salesforce write: counted under its own label.
    expect(deadLetters('continuation_unfinished')).toHaveLength(1)
    expect(deadLetters('sf_writeback')).toEqual([])
  })
})
