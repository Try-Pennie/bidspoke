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
  sendSlowdownSummaryAlert: vi.fn(),
}))

import { executeWorkflow, moneyRuntime } from '../index'
import { loadWorkflowDefinition } from '../definition-loader'
import { executeNode } from '../nodes/index'
import { getSlackConnection, sendOutcomeDeadLetterAlert, sendSlowdownSummaryAlert } from '../../lib/slack'
import { fireExecutionAlert } from '../../lib/execution-alerts'
import { NO_ROW_MATCHED_CODE } from '../../lib/db-retry'
import { POST_RESPONSE_BUDGET_MS, DEAD_LETTER_RESERVE_MS } from '../../lib/post-response-budget'
import { VirtualClock } from '../../lib/__tests__/_virtual-clock'
import { UNCONFIRMED_WRITE_PREFIX, ANSWER_JOURNAL_PREFIX } from '../unconfirmed-writes'
import { runUnconfirmedWriteSweep } from '../../lib/unconfirmed-write-sweep'

const WF_ID = 'wf-budget'
const RESPONSE = { status: 200, headers: {}, body: { accepted: true } }
const CUTOFF = POST_RESPONSE_BUDGET_MS - DEAD_LETTER_RESERVE_MS

const definition = {
  trigger: { id: 'trigger', type: 'trigger', config: {} },
  nodes: [{ id: 'r', namespace: 'offer_response', type: 'response', config: { retries: 0 } }],
  edges: [],
} as unknown as WorkflowDefinition

type Availability = 'up' | 'down' | 'hang' | 'late'

/** How long a `late` request takes to answer: past the whole post-response budget. */
const LATE_MS = 40_000

interface DbCall {
  at: number
  table: string
  op: string
  answered: Availability
}

/**
 * A PostgREST stand-in. `down` answers the way PostgREST does when it cannot
 * reach Postgres (an empty-bodied 503); `hang` never answers; `late` answers,
 * and lands, only after the whole budget (#1880); `up` stores rows,
 * enforces the step rows' foreign key on the execution row, and reports the
 * rows an UPDATE matched, as the real writers require.
 */
function makeDb(clock: VirtualClock, availability: (table: string, op: string) => Availability) {
  const calls: DbCall[] = []
  const executions = new Map<string, Record<string, unknown>>()
  const sightings = new Map<string, Record<string, unknown>>()
  const steps: Record<string, unknown>[] = []

  function answer(table: string, op: string, payload: unknown, filters: Record<string, unknown>) {
    const state = availability(table, op)
    calls.push({ at: clock.now(), table, op, answered: state })
    if (state === 'hang') return clock.hang()
    if (state === 'down') {
      return Promise.resolve({ data: null, error: { message: '' }, status: 503, statusText: 'Service Unavailable' })
    }
    if (state === 'late') return clock.delay(LATE_MS).then(() => land(table, op, payload, filters))
    return land(table, op, payload, filters)
  }

  function land(table: string, op: string, payload: unknown, filters: Record<string, unknown>): Promise<unknown> {
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
    if (op === 'select' && table === 'execution_steps') {
      // The step rows' read back (#1881), by run.
      const match = steps.filter((r) => r.execution_id === filters.execution_id)
      return Promise.resolve({ data: match.map((r) => ({ id: r.id })), error: null })
    }
    if (op === 'select' && (table === 'workflow_executions' || table === 'lead_sightings')) {
      // The read back (#1880): by id and by the partition column, as the sweep asks.
      const store = table === 'workflow_executions' ? executions : sightings
      const partition = table === 'workflow_executions' ? 'started_at' : 'execution_started_at_utc'
      const row = store.get(filters.id as string)
      const match = row && new Date(row[partition] as string).getTime() === new Date(filters[partition] as string).getTime()
      return Promise.resolve({ data: match ? [row] : [], error: null })
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
          if (prop === 'eq') filters[args[0] as string] = args[1]
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
    async list(opts: { prefix?: string; limit?: number }) {
      const names = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort()
      return { keys: names.slice(0, opts.limit ?? 1000).map((name) => ({ name })), list_complete: true }
    },
  }
  return { kv: kv as unknown as KVNamespace, puts, store }
}

async function run(availability: (clock: VirtualClock, table: string, op: string) => Availability, envExtra: Record<string, string> = {}) {
  const clock = new VirtualClock()
  const db = makeDb(clock, (table, op) => availability(clock, table, op))
  const idempotency = makeKV(clock)
  const background: Promise<unknown>[] = []
  const env = {
    IDEMPOTENCY: idempotency.kv,
    WORKFLOW_CACHE: makeKV(clock).kv,
    APP_URL: 'https://app.test',
    PII_REDACTION_FIELDS: '',
    ...envExtra,
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
  return { result, clock, db, deadLetters, idempotency }
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
  vi.mocked(sendSlowdownSummaryAlert).mockResolvedValue(true)
})

type Phase = { now: Availability }

/** The minute sweep, run as if three minutes later, with the database answering by then (#1880). */
async function sweepAfter(phase: Phase, idempotency: { kv: KVNamespace }, db: { client: SupabaseClient }) {
  phase.now = 'up'
  return runUnconfirmedWriteSweep({
    kv: idempotency.kv as never,
    supabase: db.client,
    appUrl: 'https://app.test',
    now: () => Date.now() + 3 * 60_000,
    slackFor: async () => ({ config_alerts_enabled: true }) as never,
  })
}

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
    // Up for the create at time zero, down for everything after it. The last
    // finalize attempt can still be in flight at the cut-off, which makes it
    // unconfirmed rather than failed (#1880), so the sweep that reads it back
    // is part of the path: either way the loss must keep the drain wording.
    let created = false
    const phase: Phase = { now: 'down' }
    const { db, result, idempotency } = await run(() => {
      if (created) return phase.now
      created = true
      return 'up'
    })
    expect(db.executions.get(result.executionId)?.status).toBe('running')
    await sweepAfter(phase, idempotency, db)
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

describe('post-response writes with a database that never answers (#1850, #1880)', () => {
  it('records each timed out write as unconfirmed, at the cut-off, and dead-letters none of them', async () => {
    const { deadLetters, clock, idempotency } = await run(() => 'hang')
    for (const label of ['execution_finalize', 'lead_sightings.insert', 'lead_sightings.finalize']) {
      expect(deadLetters(label), label).toEqual([])
    }
    const unconfirmed = idempotency.puts.filter((p) => p.key.startsWith(UNCONFIRMED_WRITE_PREFIX))
    const labels = [...idempotency.store.entries()]
      .filter(([k]) => k.startsWith(UNCONFIRMED_WRITE_PREFIX))
      .map(([, v]) => (JSON.parse(v) as { label: string }).label)
      .sort()
    expect(labels).toEqual(['execution_finalize', 'execution_steps', 'lead_sightings.finalize', 'lead_sightings.insert'])
    expect(Math.max(...unconfirmed.map((p) => p.at))).toBeLessThanOrEqual(CUTOFF)
    expect(sendOutcomeDeadLetterAlert).not.toHaveBeenCalled()
    expect(clock.now()).toBeLessThanOrEqual(POST_RESPONSE_BUDGET_MS)
  })
})

/**
 * #1880, measured on 2026-10-08: a 90 second stall answered every write after
 * the budget, every row landed, and each one was paged as lost. The writes are
 * now recorded as unconfirmed and the minute sweep reads them back.
 */
describe('writes that answer after the budget, read back by the sweep (#1880)', () => {

  it('sends no alert once every late row is read back present', async () => {
    const phase: Phase = { now: 'late' }
    const { db, idempotency, result } = await run(() => phase.now)
    // #1881: the lead was answered and the step records only went unconfirmed,
    // so the run pages nobody (part of #688). Since #1883 the finalize goes out
    // at the answer, so here it is the answer's own update that lands late, and
    // the demotion is held back because that update had not confirmed: the row
    // says what the caller was told, and the journal carries the demotion.
    const row = db.executions.get(result.executionId)
    expect(row?.status).toBe('completed')
    expect(row?.response_status).toBe(200)
    expect(fireExecutionAlert).not.toHaveBeenCalled()
    const journal = JSON.parse(String(await idempotency.kv.get(`${ANSWER_JOURNAL_PREFIX}${result.executionId}`)))
    expect(journal.status).toBe('degraded')

    const summary = await sweepAfter(phase, idempotency, db)

    expect(summary.landed).toBe(4)
    expect(summary.lost).toBe(0)
    expect(db.steps).toHaveLength(1)
    // One summary for the slowdown, saying every record landed (#1881).
    expect(sendSlowdownSummaryAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendSlowdownSummaryAlert).mock.calls[0][1]).toMatchObject({ runs: 1, records: 4, landed: 4, lost: 0, steps_missing: 0 })
    expect(sendOutcomeDeadLetterAlert).not.toHaveBeenCalled()
    expect([...idempotency.store.keys()].filter((k) => k.startsWith(UNCONFIRMED_WRITE_PREFIX))).toEqual([])
  })

  it('alerts that the records were lost when they never landed', async () => {
    const phase: Phase = { now: 'hang' }
    const { db, idempotency } = await run(() => phase.now)

    const summary = await sweepAfter(phase, idempotency, db)

    expect(summary.lost).toBe(3)
    const labels = vi.mocked(sendOutcomeDeadLetterAlert).mock.calls.map(([, p]) => p.label).sort()
    expect(labels).toEqual(['execution_finalize', 'lead_sightings.finalize', 'lead_sightings.insert'])
    // No row at all: a served lead with no audit record, never the drain wording.
    expect(finalizeAlert()?.error_code).toBe(NO_ROW_MATCHED_CODE)
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
    // Set from the run's own clock on its first database call, which comes before
    // the walk reaches patch_sf; reached unset, it fails rather than hangs.
    let late: () => Promise<{ output: unknown }> = () => Promise.reject(new Error('the late step ran before the clock was wired'))
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

  // #1882: the reason and the alert pointed at the Salesforce update, which had
  // finished 87 ms after the answer; the step still out was the Achieve call after
  // it. They now name the step the walk was running when the wait gave up.
  it('names the step still running at the cut-off, not the one before it that finished', async () => {
    const twoSteps = {
      trigger: { id: 'trigger', type: 'trigger', config: {} },
      nodes: [
        { id: 'r', namespace: 'offer_response', type: 'response', config: { continue_after_response: true, retries: 0 } },
        { id: 's', namespace: 'under_10000_sf_post', label: 'Salesforce post', type: 'code', config: { retries: 0 } },
        { id: 'a', namespace: 'achieve_under_10k', label: 'Achieve under 10k', type: 'achieve_offers', config: { retries: 0 } },
      ],
      edges: [
        { id: 'e0', source: 'r', target: 's' },
        { id: 'e1', source: 's', target: 'a' },
      ],
    } as unknown as WorkflowDefinition
    vi.mocked(loadWorkflowDefinition).mockResolvedValue({
      definition: twoSteps,
      workflow_version_id: 'v1',
      workflow_name: 'Budget Test',
      org_id: 'org-1',
      slack_channel: null,
      lane: 'money',
    })
    let late: () => Promise<{ output: unknown }> = () => Promise.reject(new Error('the late step ran before the clock was wired'))
    vi.mocked(executeNode).mockImplementation(async (node) => {
      if (node.namespace === 'offer_response') return { output: RESPONSE, earlyResponse: RESPONSE, continueAfterResponse: true }
      if (node.namespace === 'under_10000_sf_post') return { output: { posted: true } }
      return late()
    })
    const { db, result } = await run((c) => {
      late = () => c.sleep(60_000).then(() => ({ output: { late: true } }))
      return 'up'
    })
    const reason = String(db.executions.get(result.executionId)?.error_message)
    expect(reason).toContain('Achieve under 10k (achieve_under_10k)')
    expect(reason).not.toContain('under_10000_sf_post')
    const alert = vi.mocked(sendOutcomeDeadLetterAlert).mock.calls.find(([, p]) => p.label === 'continuation_unfinished')?.[1]
    expect(alert?.run?.still_running).toEqual(['Achieve under 10k (achieve_under_10k)'])
  })
})

/**
 * #1883, defect A, measured 2026-10-08: five Engine runs answered HTTP 200, and
 * the finalize update recording that answer was sent only after the step write
 * gave up, 15 s later. In the stall none of those updates ran, so the runs kept
 * no record of what Engine was told. The finalize now goes out at the answer,
 * beside the step write, and the answer is journaled in KV for the strand drain.
 */
describe('the answer is recorded at the answer (#1883)', () => {
  const stepsHang = (_c: VirtualClock, table: string): Availability => (table === 'execution_steps' ? 'hang' : 'up')

  it('sends the finalize update at the answer, not behind a step write that has not answered', async () => {
    const { db, result } = await run(stepsHang)
    const firstUpdate = db.calls.find((c) => c.table === 'workflow_executions' && c.op === 'update')
    expect(firstUpdate).toBeDefined()
    // Behind the step write it went out at the flush's cut-off, 15 s after the answer.
    expect(firstUpdate!.at).toBeLessThan(1_000)
    const row = db.executions.get(result.executionId)
    expect(row?.response_status).toBe(200)
    expect(row?.response_body).toEqual(RESPONSE.body)
  })

  it('then demotes the run once the step write is known not to have confirmed', async () => {
    const { db, result } = await run(stepsHang)
    const row = db.executions.get(result.executionId)
    expect(row?.status).toBe('degraded')
    expect(String(row?.error_message)).toMatch(/step records were not confirmed/i)
  })

  it('still records a step write that returned an error as failed, and pages for it', async () => {
    const stepsDown = (_c: VirtualClock, table: string): Availability => (table === 'execution_steps' ? 'down' : 'up')
    const { db, result } = await run(stepsDown)
    const row = db.executions.get(result.executionId)
    expect(row?.status).toBe('failed')
    expect(String(row?.error_message)).toMatch(/Step logs failed to persist/)
    expect(fireExecutionAlert).toHaveBeenCalledTimes(1)
  })

  it('journals the answer in KV at the answer, keyed by execution id, with PII redacted', async () => {
    const body = { accepted: true, applicant: { ssn: '123-45-6789' } }
    const withSsn = { status: 200, headers: {}, body }
    vi.mocked(executeNode).mockResolvedValue({ output: withSsn, earlyResponse: withSsn })
    const { idempotency, result } = await run(() => 'up', { PII_REDACTION_FIELDS: 'ssn' })
    const put = idempotency.puts.find((p) => p.key === `${ANSWER_JOURNAL_PREFIX}${result.executionId}`)
    expect(put).toBeDefined()
    expect(put!.at).toBeLessThan(1_000)
    const journal = JSON.parse(idempotency.store.get(put!.key)!)
    expect(journal).toMatchObject({
      execution_id: result.executionId,
      status: 'completed',
      response_status: 200,
      final_node_namespace: 'offer_response',
    })
    expect(journal.response_body.applicant.ssn).toBe('[REDACTED]')
    expect(JSON.stringify(journal)).not.toContain('123-45-6789')
  })

  // Finalize now runs beside the create, so it can rebuild the row while the
  // create is still out. When that create then lands, the original flush writes
  // the step rows, and a second flush after the rebuild would write them twice.
  it('writes the step rows once when finalize rebuilt the row while the create was still out', async () => {
    let creates = 0
    const { db, result } = await run((_c, table, op) => {
      if (table === 'workflow_executions' && op === 'insert' && creates++ === 0) return 'late'
      return 'up'
    })
    expect(db.executions.get(result.executionId)?.status).not.toBe('running')
    expect(db.steps).toHaveLength(1)
  })

  it('updates the journal when the run is demoted, so the drain restores the final status', async () => {
    const { idempotency, result } = await run(stepsHang)
    const journal = JSON.parse(idempotency.store.get(`${ANSWER_JOURNAL_PREFIX}${result.executionId}`)!)
    expect(journal.status).toBe('degraded')
  })
})
