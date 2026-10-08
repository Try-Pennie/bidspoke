/**
 * The minute sweep that reads back a post-response write which only timed out
 * (#1880).
 *
 * On 2026-10-08 the database stalled for about 90 seconds and every write made
 * after a run's answer outlasted its budget. Each was dead-lettered at once as
 * "Outcome Record Lost ... not saved and not auto-recovered", and every one of
 * them had landed. A timed out write is now recorded as unconfirmed, naming the
 * record to read back, and this sweep decides: landed (dropped silently),
 * missing (the lost alert, as before), or unreadable for 15 minutes (a "could
 * not confirm" alert, never "lost").
 *
 * The database here is a double whose answers each test sets, the clock is a
 * number each test moves, and nothing waits in real time (L524).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../slack')>()),
  getSlackConnection: vi.fn(),
  sendOutcomeDeadLetterAlert: vi.fn(),
  sendUnconfirmedWritesAlert: vi.fn(),
  sendSlowdownSummaryAlert: vi.fn(),
}))

import { getSlackConnection, sendOutcomeDeadLetterAlert, sendUnconfirmedWritesAlert, sendSlowdownSummaryAlert } from '../slack'
import {
  runUnconfirmedWriteSweep,
  READ_BACK_MIN_AGE_MS,
  COULD_NOT_CONFIRM_AFTER_MS,
  SWEEP_LIMIT,
  READ_PHASE_BUDGET_MS,
  SUMMARY_QUIET_MS,
  boundedSlackFor,
  type UnconfirmedSweepDeps,
} from '../unconfirmed-write-sweep'
import { putUnconfirmedWrite, UNCONFIRMED_WRITE_PREFIX, type ReadBack, type UnconfirmedWrite } from '../../engine/unconfirmed-writes'
import { NO_ROW_MATCHED_CODE } from '../db-retry'
import type { AlertClaims } from '../alert-claim'
import type { JobRunEnding } from '../job-run-record'

const T0 = Date.parse('2026-10-08T12:20:30.000Z')
const STARTED = '2026-10-08T12:20:08.000Z'

type Row = Record<string, unknown>
type Mode = 'up' | 'down' | 'hang'

/**
 * A PostgREST stand-in for reads: rows per table, matched on every `eq` the
 * query made and bounded by any `gte`/`lt`, so a read that forgot its partition
 * column, or asked with the wrong value, finds nothing.
 */
function makeDb() {
  const tables: Record<string, Row[]> = { workflow_executions: [], lead_sightings: [], lead_sighting_bids: [] }
  const state = { mode: 'up' as Mode, reads: 0, permanentFor: null as string | null }
  const queries: Array<{ table: string; eq: Record<string, unknown>; gte: Record<string, unknown>; lt: Record<string, unknown> }> = []
  function from(table: string) {
    const q = { table, eq: {} as Record<string, unknown>, gte: {} as Record<string, unknown>, lt: {} as Record<string, unknown> }
    const chain: Record<string | symbol, unknown> = new Proxy({} as Record<string | symbol, unknown>, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
            state.reads++
            queries.push(q)
            if (state.mode === 'hang') return new Promise(() => {})
            if (state.mode === 'down') return Promise.resolve({ data: null, error: { code: 'PGRST002', message: 'schema cache' } }).then(resolve, reject)
            if (state.permanentFor === table) return Promise.resolve({ data: null, error: { code: '42703', message: 'column does not exist' } }).then(resolve, reject)
            const rows = tables[table].filter(
              (r) =>
                Object.entries(q.eq).every(([k, v]) => sameValue(r[k], v)) &&
                Object.entries(q.gte).every(([k, v]) => Date.parse(String(r[k])) >= Date.parse(String(v))) &&
                Object.entries(q.lt).every(([k, v]) => Date.parse(String(r[k])) < Date.parse(String(v))),
            )
            return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
          }
        }
        return (...args: unknown[]) => {
          if (prop === 'eq') q.eq[args[0] as string] = args[1]
          if (prop === 'gte') q.gte[args[0] as string] = args[1]
          if (prop === 'lt') q.lt[args[0] as string] = args[1]
          return chain
        }
      },
    })
    return chain
  }
  return { client: { from } as unknown as SupabaseClient, tables, state, queries }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string' && /^\d{4}-\d\d-\d\dT/.test(a) && /^\d{4}-\d\d-\d\dT/.test(b)) {
    return Date.parse(a) === Date.parse(b)
  }
  return a === b
}

function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
    list: vi.fn(async (opts: { prefix?: string; limit?: number }) => {
      const names = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort()
      return { keys: names.slice(0, opts.limit ?? 1000).map((name) => ({ name })), list_complete: names.length <= (opts.limit ?? 1000) }
    }),
  }
}

/** One answer per key, shared by every sweep, as the Durable Object is. */
function makeClaims(): AlertClaims & { held: Set<string> } {
  const held = new Set<string>()
  return {
    held,
    async claim(key) {
      if (held.has(key)) return false
      held.add(key)
      return true
    },
    async release(key) {
      held.delete(key)
    },
  }
}

const RUN = { workflow_id: 'wf-1', workflow_name: 'Engine Bidding Workflow', execution_id: 'ex-1' }

let seq = 0
async function seed(kv: ReturnType<typeof makeKv>, label: string, readBack: ReadBack, firstSeenMs = T0, org = 'org-1', run = RUN): Promise<UnconfirmedWrite> {
  const entry: UnconfirmedWrite = {
    id: `entry-${++seq}`,
    label,
    org_id: org,
    first_seen_at: new Date(firstSeenMs).toISOString(),
    read_back: readBack,
    run,
    error_message: `${label}: no answer within the post-response budget; the write may still land, but nothing confirmed it`,
  }
  await putUnconfirmedWrite(kv, entry)
  return entry
}

const EXEC: ReadBack = { kind: 'execution_finalized', execution_id: 'ex-1', started_at: STARTED }
const SIGHT_IN: ReadBack = { kind: 'sighting_present', sighting_id: 's-1', execution_started_at_utc: STARTED }
const SIGHT_FIN: ReadBack = { kind: 'sighting_finalized', sighting_id: 's-1', execution_started_at_utc: STARTED }
const BID: ReadBack = { kind: 'bid_present', execution_id: 'ex-1', partner_slug: 'tripoint', attempted_at_utc: STARTED }
const WINNER: ReadBack = {
  kind: 'bid_winner',
  execution_id: 'ex-1',
  partner_slug: 'tripoint',
  attempted_from: '2026-10-08T11:20:08.000Z',
  attempted_to: '2026-10-08T13:20:08.000Z',
}

function deps(kv: ReturnType<typeof makeKv>, db: ReturnType<typeof makeDb>, nowMs: number, extra: Partial<UnconfirmedSweepDeps> = {}): UnconfirmedSweepDeps {
  return {
    kv,
    supabase: db.client,
    appUrl: 'https://app.test',
    now: () => nowMs,
    slackFor: async () => ({ bot_token: 't', default_channel: 'c', config_alerts_enabled: true } as never),
    // The deadline never fires unless a test says so, so no test waits on it.
    readDeadline: () => new Promise<void>(() => {}),
    ...extra,
  }
}

const remaining = (kv: ReturnType<typeof makeKv>) => [...kv.store.keys()].filter((k) => k.startsWith(UNCONFIRMED_WRITE_PREFIX))
const OLD_ENOUGH = T0 + READ_BACK_MIN_AGE_MS
// When a slowdown whose last record timed out at T0 may be summarised.
const QUIET = T0 + SUMMARY_QUIET_MS

beforeEach(() => {
  vi.clearAllMocks()
  seq = 0
  vi.mocked(getSlackConnection).mockResolvedValue({ config_alerts_enabled: true } as never)
  vi.mocked(sendOutcomeDeadLetterAlert).mockResolvedValue(true)
  vi.mocked(sendUnconfirmedWritesAlert).mockResolvedValue(true)
  vi.mocked(sendSlowdownSummaryAlert).mockResolvedValue(true)
})

describe('an entry younger than the read back age', () => {
  it('is not read: a request still queued in the database could yet land', async () => {
    const kv = makeKv()
    const db = makeDb()
    await seed(kv, 'lead_sightings.insert', SIGHT_IN)
    const s = await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH - 1))
    expect(db.state.reads).toBe(0)
    expect(s.young).toBe(1)
    expect(remaining(kv)).toHaveLength(1)
  })
})

describe('a record read back present', () => {
  it('drops the entry silently and counts it', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.tables.lead_sightings.push({ id: 's-1', execution_started_at_utc: STARTED, outcome_state: 'finalized' })
    db.tables.workflow_executions.push({ id: 'ex-1', started_at: STARTED, status: 'failed' })
    db.tables.lead_sighting_bids.push({ id: 'b-1', execution_id: 'ex-1', partner_slug: 'tripoint', attempted_at_utc: STARTED, is_winner: true })
    for (const [label, rb] of [['lead_sightings.insert', SIGHT_IN], ['lead_sightings.finalize', SIGHT_FIN], ['execution_finalize', EXEC], ['lead_sighting_bids.insert', BID], ['lead_sighting_bids.winner', WINNER]] as const) {
      await seed(kv, label, rb)
    }

    const s = await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH))

    expect(s.landed).toBe(5)
    expect(s.lost).toBe(0)
    expect(remaining(kv)).toEqual([])
    expect(sendOutcomeDeadLetterAlert).not.toHaveBeenCalled()
    expect(sendUnconfirmedWritesAlert).not.toHaveBeenCalled()
  })

  it('reads each table by its partition column, so the read prunes to one partition', async () => {
    const kv = makeKv()
    const db = makeDb()
    await seed(kv, 'execution_finalize', EXEC)
    await seed(kv, 'lead_sightings.insert', SIGHT_IN)
    await seed(kv, 'lead_sighting_bids.insert', BID)
    await seed(kv, 'lead_sighting_bids.winner', WINNER)
    await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH))
    const by = (t: string) => db.queries.filter((q) => q.table === t)
    expect(by('workflow_executions')[0].eq).toMatchObject({ id: 'ex-1', started_at: STARTED })
    expect(by('lead_sightings')[0].eq).toMatchObject({ id: 's-1', execution_started_at_utc: STARTED })
    expect(by('lead_sighting_bids')[0].eq).toMatchObject({ attempted_at_utc: STARTED })
    const winner = by('lead_sighting_bids')[1]
    expect(winner.gte).toEqual({ attempted_at_utc: WINNER.kind === 'bid_winner' ? WINNER.attempted_from : '' })
    expect(winner.lt).toEqual({ attempted_at_utc: WINNER.kind === 'bid_winner' ? WINNER.attempted_to : '' })
  })
})

describe('a record whose effect is missing', () => {
  it('a sighting still in flight is a lost finalize: the row alone is not the effect', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.tables.lead_sightings.push({ id: 's-1', execution_started_at_utc: STARTED, outcome_state: 'in_flight' })
    await seed(kv, 'lead_sightings.finalize', SIGHT_FIN)

    const s = await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH))

    expect(s.lost).toBe(1)
    expect(sendOutcomeDeadLetterAlert).toHaveBeenCalledTimes(1)
    const [, payload] = vi.mocked(sendOutcomeDeadLetterAlert).mock.calls[0]
    expect(payload.label).toBe('lead_sightings.finalize')
    expect(payload.error_message).toContain('read back')
    expect(remaining(kv)).toEqual([])
  })

  it('an execution row left at running is the drain recoverable finalize loss, not a missing row', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.tables.workflow_executions.push({ id: 'ex-1', started_at: STARTED, status: 'running' })
    await seed(kv, 'execution_finalize', EXEC)
    await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH))
    const [, payload] = vi.mocked(sendOutcomeDeadLetterAlert).mock.calls[0]
    expect(payload.label).toBe('execution_finalize')
    expect(payload.error_code).not.toBe(NO_ROW_MATCHED_CODE)
  })

  it('an execution row that is not there at all is a served lead with no audit record', async () => {
    const kv = makeKv()
    const db = makeDb()
    await seed(kv, 'execution_finalize', EXEC)
    await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH))
    const [, payload] = vi.mocked(sendOutcomeDeadLetterAlert).mock.calls[0]
    expect(payload.error_code).toBe(NO_ROW_MATCHED_CODE)
    expect(payload.run).toMatchObject({ workflow_id: 'wf-1', execution_id: 'ex-1' })
  })

  it('a bid row present but never marked the winner is a lost winner mark', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.tables.lead_sighting_bids.push({ id: 'b-1', execution_id: 'ex-1', partner_slug: 'tripoint', attempted_at_utc: STARTED, is_winner: false })
    await seed(kv, 'lead_sighting_bids.winner', WINNER)
    const s = await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH))
    expect(s.lost).toBe(1)
  })

  it('two sweeps that overlap on one missing record send one lost alert, not two', async () => {
    const kv = makeKv()
    const db = makeDb()
    const claims = makeClaims()
    await seed(kv, 'lead_sightings.insert', SIGHT_IN)
    const [a, b] = await Promise.all([
      runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH, { claims })),
      runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH, { claims })),
    ])
    expect(a.lost + b.lost).toBe(1)
    expect(sendOutcomeDeadLetterAlert).toHaveBeenCalledTimes(1)
  })
})

describe('a database that still does not answer', () => {
  it('says nothing before 15 minutes and keeps the entry', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.state.mode = 'down'
    await seed(kv, 'lead_sightings.insert', SIGHT_IN)
    const s = await runUnconfirmedWriteSweep(deps(kv, db, T0 + COULD_NOT_CONFIRM_AFTER_MS - 1))
    expect(s.unreadable).toBe(1)
    expect(sendUnconfirmedWritesAlert).not.toHaveBeenCalled()
    expect(sendOutcomeDeadLetterAlert).not.toHaveBeenCalled()
    expect(remaining(kv)).toHaveLength(1)
  })

  it('at 15 minutes alerts once that it could not confirm, never that the records were lost', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.state.mode = 'down'
    const claims = makeClaims()
    await seed(kv, 'lead_sightings.insert', SIGHT_IN)
    await seed(kv, 'execution_finalize', EXEC)

    await runUnconfirmedWriteSweep(deps(kv, db, T0 + COULD_NOT_CONFIRM_AFTER_MS, { claims }))
    await runUnconfirmedWriteSweep(deps(kv, db, T0 + COULD_NOT_CONFIRM_AFTER_MS + 60_000, { claims }))

    expect(sendOutcomeDeadLetterAlert).not.toHaveBeenCalled()
    expect(sendUnconfirmedWritesAlert).toHaveBeenCalledTimes(1)
    const [, payload] = vi.mocked(sendUnconfirmedWritesAlert).mock.calls[0]
    expect(payload.count).toBe(2)
    expect(payload.runs.map((r) => r.execution_id)).toEqual(['ex-1'])
    // Kept, so the record is still read back when the database returns.
    expect(remaining(kv)).toHaveLength(2)
  })

  it('a read that never answers is given up on and treated as unreadable', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.state.mode = 'hang'
    await seed(kv, 'lead_sightings.insert', SIGHT_IN)
    const s = await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH, { readDeadline: () => Promise.resolve() }))
    expect(s.unreadable).toBe(1)
  })

  it('does not hold a slowdown summary back for an entry the could-not-confirm alert has already named', async () => {
    const kv = makeKv()
    const db = makeDb()
    const claims = makeClaims()
    db.state.permanentFor = 'lead_sighting_bids'
    db.tables.lead_sightings.push({ id: 's-1', execution_started_at_utc: STARTED, outcome_state: 'finalized' })
    await seed(kv, 'lead_sighting_bids.insert', BID, T0)
    await seed(kv, 'lead_sightings.insert', SIGHT_IN, T0 + 1)
    // Before 15 minutes the unreadable entry holds the summary back.
    await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH + 1, { claims }))
    expect(sendSlowdownSummaryAlert).not.toHaveBeenCalled()
    // At 15 minutes it is named by its own alert, and the summary goes out.
    await runUnconfirmedWriteSweep(deps(kv, db, T0 + COULD_NOT_CONFIRM_AFTER_MS, { claims }))
    await runUnconfirmedWriteSweep(deps(kv, db, T0 + COULD_NOT_CONFIRM_AFTER_MS + 60_000, { claims }))
    expect(sendUnconfirmedWritesAlert).toHaveBeenCalledTimes(1)
    expect(sendSlowdownSummaryAlert).toHaveBeenCalledTimes(1)
    // It must not read as every record saved while one is still unconfirmed.
    expect(vi.mocked(sendSlowdownSummaryAlert).mock.calls[0][1]).toMatchObject({ landed: 1, unconfirmed: 1 })
  })

  it('keys a lost execution row found by read back on the read back cause', async () => {
    const kv = makeKv()
    const db = makeDb()
    const claims = makeClaims()
    const keys: string[] = []
    const claim = claims.claim.bind(claims)
    claims.claim = async (key, ttl) => {
      keys.push(key)
      return claim(key, ttl)
    }
    await seed(kv, 'execution_finalize', EXEC)
    await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH, { claims }))
    expect(keys).toContain('outcome-deadletter:org-1:execution_finalize:read-back')
  })

  it('does not stop the tick for one entry whose read was refused permanently', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.state.permanentFor = 'lead_sighting_bids'
    db.tables.lead_sightings.push({ id: 's-1', execution_started_at_utc: STARTED, outcome_state: 'finalized' })
    await seed(kv, 'lead_sighting_bids.insert', BID, T0)
    await seed(kv, 'lead_sightings.insert', SIGHT_IN, T0 + 1)
    const s = await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH + 1))
    expect(s.unreadable).toBe(1)
    expect(s.landed).toBe(1)
  })

  it('stops reading at the first unreadable answer, so one dead database costs one read a tick', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.state.mode = 'down'
    for (let i = 0; i < 5; i++) await seed(kv, 'lead_sightings.insert', SIGHT_IN, T0 + i)
    const s = await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH + 10))
    expect(db.state.reads).toBe(1)
    expect(s.unreadable).toBe(5)
  })

  it('reads the entry back once the database returns, and drops it when it landed', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.state.mode = 'down'
    const claims = makeClaims()
    await seed(kv, 'lead_sightings.insert', SIGHT_IN)
    await runUnconfirmedWriteSweep(deps(kv, db, T0 + COULD_NOT_CONFIRM_AFTER_MS, { claims }))
    db.state.mode = 'up'
    db.tables.lead_sightings.push({ id: 's-1', execution_started_at_utc: STARTED, outcome_state: 'in_flight' })
    const s = await runUnconfirmedWriteSweep(deps(kv, db, T0 + COULD_NOT_CONFIRM_AFTER_MS + 60_000, { claims }))
    expect(s.landed).toBe(1)
    expect(remaining(kv)).toEqual([])
  })
})

describe('the sweep is bounded and safe to run twice', () => {
  it('handles at most SWEEP_LIMIT entries a tick', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.tables.lead_sightings.push({ id: 's-1', execution_started_at_utc: STARTED, outcome_state: 'finalized' })
    for (let i = 0; i < SWEEP_LIMIT + 5; i++) await seed(kv, 'lead_sightings.insert', SIGHT_IN, T0 + i)
    const s = await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH + SWEEP_LIMIT + 5))
    expect(s.landed).toBe(SWEEP_LIMIT)
    expect(remaining(kv)).toHaveLength(5)
  })

  it('never deletes an entry written after it listed', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.tables.lead_sightings.push({ id: 's-1', execution_started_at_utc: STARTED, outcome_state: 'finalized' })
    await seed(kv, 'lead_sightings.insert', SIGHT_IN)
    const list = kv.list
    kv.list = vi.fn(async (opts) => {
      const listed = await list(opts)
      // A run that times out on the same record writes its own entry now.
      await seed(kv, 'lead_sightings.insert', SIGHT_IN, T0 + 1)
      return listed
    })
    await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH + 1))
    expect(remaining(kv)).toHaveLength(1)
  })

  it('stops reading once the tick has spent its read budget, leaving the rest for the next tick', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.tables.lead_sightings.push({ id: 's-1', execution_started_at_utc: STARTED, outcome_state: 'finalized' })
    for (let i = 0; i < 3; i++) await seed(kv, 'lead_sightings.insert', SIGHT_IN, T0 + i)
    // A slow database: every look at the clock finds the tick further on.
    let t = OLD_ENOUGH + 10
    const s = await runUnconfirmedWriteSweep(deps(kv, db, 0, { now: () => (t += READ_PHASE_BUDGET_MS / 2) }))
    expect(s.landed).toBeLessThan(3)
    expect(s.unread).toBeGreaterThan(0)
    expect(s.unreadable).toBe(0)
    expect(remaining(kv)).toHaveLength(3 - s.landed)
  })

  it('keeps the entry when the lost alert itself could not be recorded', async () => {
    const kv = makeKv()
    const db = makeDb()
    await seed(kv, 'lead_sightings.insert', SIGHT_IN)
    // The dead letter's own count write fails, so nothing recorded the loss.
    const put = kv.put
    kv.put = vi.fn(async (k: string, v: string) => {
      if (k.startsWith('outcome-deadletter-window:')) throw new Error('kv down')
      await put(k, v)
    })
    const s = await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH))
    expect(s.lost).toBe(0)
    expect(remaining(kv)).toHaveLength(1)
  })

  it('drops an entry whose stored value is not a readable entry, so it cannot hold a list slot for a day', async () => {
    const kv = makeKv()
    const db = makeDb()
    kv.store.set(`${UNCONFIRMED_WRITE_PREFIX}000000000000001:junk`, 'not json')
    const s = await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH))
    expect(s.skipped).toBe(1)
    expect(remaining(kv)).toEqual([])
  })

  it('drops a key that does not carry a first seen time, rather than counting it young for a day', async () => {
    const kv = makeKv()
    const db = makeDb()
    kv.store.set(`${UNCONFIRMED_WRITE_PREFIX}not-a-time:x`, '{}')
    const s = await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH))
    expect(s.young).toBe(0)
    expect(remaining(kv)).toEqual([])
  })

  it('records the tick in job_runs only when it had entries to look at', async () => {
    const kv = makeKv()
    const db = makeDb()
    const recordRun = vi.fn(async (_startedAtMs: number, _ending: JobRunEnding) => {})
    await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH, { recordRun }))
    expect(recordRun).not.toHaveBeenCalled()

    db.tables.lead_sightings.push({ id: 's-1', execution_started_at_utc: STARTED, outcome_state: 'finalized' })
    await seed(kv, 'lead_sightings.insert', SIGHT_IN)
    await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH, { recordRun }))
    expect(recordRun).toHaveBeenCalledTimes(1)
    expect(recordRun.mock.calls[0][1]).toMatchObject({ outcome: 'resolved', summary: expect.objectContaining({ landed: 1, lost: 0 }) })
  })
})

/**
 * #1881: one database stall produced about 35 Slack messages within a minute.
 * Once the sweep has resolved every entry a slowdown left, it posts ONE summary:
 * how many runs, which workflows, and whether every record landed.
 */
describe('one summary per slowdown (#1881)', () => {
  const RUN_B = { workflow_id: 'wf-2', workflow_name: 'Lead Economy', execution_id: 'ex-2' }
  const SIGHT_B: ReadBack = { kind: 'sighting_present', sighting_id: 's-2', execution_started_at_utc: STARTED }
  const STEPS: ReadBack = {
    kind: 'steps_present',
    execution_id: 'ex-1',
    execution_started_at: STARTED,
    started_from: STARTED,
    started_to: '2026-10-08T13:20:08.000Z',
    expected: 2,
  }

  it('waits until the slowdown is fully read back, then posts once for every run in it', async () => {
    const kv = makeKv()
    const db = makeDb()
    const claims = makeClaims()
    db.tables.lead_sightings.push({ id: 's-1', execution_started_at_utc: STARTED, outcome_state: 'finalized' })
    db.tables.lead_sightings.push({ id: 's-2', execution_started_at_utc: STARTED, outcome_state: 'in_flight' })
    await seed(kv, 'lead_sightings.insert', SIGHT_IN, T0)
    await seed(kv, 'lead_sightings.insert', SIGHT_B, T0 + 50_000, 'org-1', RUN_B)

    // The second entry is still too young to read: no summary yet.
    await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH, { claims }))
    expect(sendSlowdownSummaryAlert).not.toHaveBeenCalled()

    await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH + 50_000, { claims }))
    await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH + 110_000, { claims }))

    expect(sendSlowdownSummaryAlert).toHaveBeenCalledTimes(1)
    const [, payload] = vi.mocked(sendSlowdownSummaryAlert).mock.calls[0]
    expect(payload).toMatchObject({ runs: 2, records: 2, landed: 2, lost: 0, steps_missing: 0 })
    expect(payload.workflows.map((w) => w.name).sort()).toEqual(['Engine Bidding Workflow', 'Lead Economy'])
    expect(payload.from).toBe(new Date(T0).toISOString())
    expect(payload.to).toBe(new Date(T0 + 50_000).toISOString())
  })

  it('waits until the slowdown has been quiet past a KV list lag before summarising', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.tables.lead_sightings.push({ id: 's-1', execution_started_at_utc: STARTED, outcome_state: 'finalized' })
    await seed(kv, 'lead_sightings.insert', SIGHT_IN)
    await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH))
    expect(sendSlowdownSummaryAlert).not.toHaveBeenCalled()
    await runUnconfirmedWriteSweep(deps(kv, db, QUIET))
    expect(sendSlowdownSummaryAlert).toHaveBeenCalledTimes(1)
  })

  it('posts one summary when every tick is delivered twice, half a minute apart', async () => {
    const kv = makeKv()
    const db = makeDb()
    const claims = makeClaims()
    db.tables.lead_sightings.push({ id: 's-1', execution_started_at_utc: STARTED, outcome_state: 'finalized' })
    await seed(kv, 'lead_sightings.insert', SIGHT_IN)
    // Cloudflare delivered each minute's tick twice on 2026-10-08, 24 to 36 s apart.
    for (const at of [OLD_ENOUGH, OLD_ENOUGH + 30_000, QUIET, QUIET + 30_000, QUIET + 60_000, QUIET + 90_000]) {
      await runUnconfirmedWriteSweep(deps(kv, db, at, { claims }))
    }
    expect(sendSlowdownSummaryAlert).toHaveBeenCalledTimes(1)
  })

  it('says how many records never landed', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.tables.lead_sightings.push({ id: 's-1', execution_started_at_utc: STARTED, outcome_state: 'finalized' })
    await seed(kv, 'lead_sightings.insert', SIGHT_IN)
    await seed(kv, 'lead_sightings.insert', SIGHT_B, T0, 'org-1', RUN_B)
    await runUnconfirmedWriteSweep(deps(kv, db, QUIET))
    const [, payload] = vi.mocked(sendSlowdownSummaryAlert).mock.calls[0]
    expect(payload).toMatchObject({ runs: 2, records: 2, landed: 1, lost: 1 })
    // The dead letter is claimed once per label and cause, so it cannot name every
    // lost record: the summary names the runs they belong to.
    expect(payload.lost_runs).toEqual([{ ...RUN_B, labels: ['lead_sightings.insert'] }])
  })

  it('posts nothing while the database still does not answer', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.state.mode = 'down'
    await seed(kv, 'lead_sightings.insert', SIGHT_IN)
    await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH))
    expect(sendSlowdownSummaryAlert).not.toHaveBeenCalled()
  })

  it('two overlapping sweeps that both finish a slowdown post one summary', async () => {
    const kv = makeKv()
    const db = makeDb()
    const claims = makeClaims()
    db.tables.lead_sightings.push({ id: 's-1', execution_started_at_utc: STARTED, outcome_state: 'finalized' })
    await seed(kv, 'lead_sightings.insert', SIGHT_IN)
    await Promise.all([
      runUnconfirmedWriteSweep(deps(kv, db, QUIET, { claims })),
      runUnconfirmedWriteSweep(deps(kv, db, QUIET, { claims })),
    ])
    expect(sendSlowdownSummaryAlert).toHaveBeenCalledTimes(1)
  })

  it('keeps the tally and tries again next tick when the summary did not deliver', async () => {
    const kv = makeKv()
    const db = makeDb()
    const claims = makeClaims()
    db.tables.lead_sightings.push({ id: 's-1', execution_started_at_utc: STARTED, outcome_state: 'finalized' })
    await seed(kv, 'lead_sightings.insert', SIGHT_IN)
    vi.mocked(sendSlowdownSummaryAlert).mockResolvedValueOnce(false)
    await runUnconfirmedWriteSweep(deps(kv, db, QUIET, { claims }))
    await runUnconfirmedWriteSweep(deps(kv, db, QUIET + 60_000, { claims }))
    expect(sendSlowdownSummaryAlert).toHaveBeenCalledTimes(2)
    expect(vi.mocked(sendSlowdownSummaryAlert).mock.calls[1][1]).toMatchObject({ landed: 1 })
  })

  it('reads step rows back by count, and a missing one is told in the summary, not dead-lettered', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.tables.execution_steps = [{ id: 'st-1', execution_id: 'ex-1', execution_started_at: STARTED, started_at: '2026-10-08T12:20:09.000Z' }]
    await seed(kv, 'execution_steps', STEPS)
    const s = await runUnconfirmedWriteSweep(deps(kv, db, QUIET))
    expect(s.steps_missing).toBe(1)
    expect(sendOutcomeDeadLetterAlert).not.toHaveBeenCalled()
    const [, payload] = vi.mocked(sendSlowdownSummaryAlert).mock.calls[0]
    expect(payload).toMatchObject({ steps_missing: 1, lost: 0 })
    // execution_steps is partitioned on each step's own started_at.
    const read = db.queries.find((q) => q.table === 'execution_steps')
    expect(read?.eq).toMatchObject({ execution_id: 'ex-1' })
    expect(read?.gte).toEqual({ started_at: STARTED })
    expect(read?.lt).toEqual({ started_at: '2026-10-08T13:20:08.000Z' })
  })

  it('counts step rows that all landed as landed', async () => {
    const kv = makeKv()
    const db = makeDb()
    db.tables.execution_steps = [
      { id: 'st-1', execution_id: 'ex-1', execution_started_at: STARTED, started_at: '2026-10-08T12:20:09.000Z' },
      { id: 'st-2', execution_id: 'ex-1', execution_started_at: STARTED, started_at: '2026-10-08T12:20:10.000Z' },
    ]
    await seed(kv, 'execution_steps', STEPS)
    const s = await runUnconfirmedWriteSweep(deps(kv, db, OLD_ENOUGH))
    expect(s.landed).toBe(1)
  })
})

/**
 * The sweep reads the Slack connection exactly while the database may be down,
 * and that read retries on real timers with no deadline. It is bounded, and the
 * last-good copy answers when it runs out (coordinator review of #1888).
 */
describe('the Slack connection read the sweep posts with', () => {
  const conn = { bot_token: 't', default_channel: 'c', config_alerts_enabled: true } as never

  it('falls back to the last-good copy when the live read does not answer in time', async () => {
    const slackFor = boundedSlackFor(
      () => new Promise(() => {}),
      async () => new Map([['org-1', conn]]),
      () => Promise.resolve(),
    )
    expect(await slackFor('org-1')).toBe(conn)
  })

  it('uses the live connection when it answers', async () => {
    const live = { ...(conn as object), default_channel: 'live' } as never
    const slackFor = boundedSlackFor(async () => live, async () => new Map([['org-1', conn]]), () => new Promise(() => {}))
    expect(await slackFor('org-1')).toBe(live)
  })

  it('answers null when neither copy can be read', async () => {
    const slackFor = boundedSlackFor(
      async () => { throw new Error('db down') },
      async () => { throw new Error('kv down') },
      () => new Promise(() => {}),
    )
    expect(await slackFor('org-1')).toBeNull()
  })
})
