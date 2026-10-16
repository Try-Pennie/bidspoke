/**
 * The drain of stored failed Salesforce writes (#468 step 3, the plan Dan
 * approved on 2026-10-15).
 *
 * A post-answer Salesforce write that failed with an answer is stored pending in
 * outcome_writeback_deadletters (#1993). The drain resends those rows through the
 * replay's one send path (writeback-replay.ts), at most twice with a backoff,
 * oldest first per record, holding while the Salesforce bulkhead is full and
 * stopping the tick at the first call Salesforce does not answer. A rejection
 * closes the row refused, spent attempts close it abandoned, and a field another
 * writer changed since is left out and named. Every behaviour here runs against
 * built rows: the table has never held one in production.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { encryptSecret } from '../secret-crypto'
import type { HeldWriteRow, HeldWriteStore, SalesforcePort } from '../writeback-replay'
import {
  runWritebackDrain,
  listDrainRows,
  DRAIN_LIST_LIMIT,
  DRAIN_BACKOFF_MS,
  DRAIN_MAX_ATTEMPTS,
  DRAIN_OUTBOX_PREFIX,
  type DrainKv,
  type DrainRow,
  type WritebackDrainDeps,
} from '../writeback-drain'
import type { WritebackDrainAlert } from '../slack'
import { readBackHoldsStep } from '../salesforce-read-back'
import { AT_RISK_WRITE_PREFIX } from '../../engine/at-risk-writes'

const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 7)).toString('base64')
const ORG = '11111111-1111-1111-1111-111111111468'
const WF = '44444444-4444-4444-4444-444444444468'
const T0 = Date.parse('2026-10-15T20:00:00Z')
const BEFORE_THE_ROWS = '2026-10-15T19:00:00.000+0000'

let seq = 0
async function row(over: Partial<HeldWriteRow> & { body?: Record<string, unknown> } = {}): Promise<HeldWriteRow> {
  seq++
  const { body, ...rest } = over
  const created = new Date(T0 - 60_000 + seq * 1000).toISOString()
  return {
    id: `22222222-2222-2222-2222-${String(seq).padStart(12, '0')}`,
    organization_id: ORG,
    workflow_id: WF,
    execution_id: `01920000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    step_namespace: 'patch_prospect',
    sf_object: 'Prospect__c',
    sf_record_id: 'a0B000000000001AAA',
    sf_operation: 'update',
    body_encrypted: await encryptSecret(JSON.stringify(body ?? { Status__c: 'No Bid' }), KEY),
    error_encrypted: await encryptSecret('Salesforce API error (503): unavailable', KEY),
    error_type: 'transient',
    replayable: true,
    status: 'pending',
    attempts: 0,
    last_error_encrypted: null,
    created_at: created,
    updated_at: created,
    finished_at: null,
    ...rest,
  }
}

/** The real store's compare and set, with the claim stamping updated_at from the test's clock. */
function memoryStore(rows: HeldWriteRow[], clock: () => number): HeldWriteStore {
  return {
    async get(orgId, id) {
      const r = rows.find((x) => x.id === id && x.organization_id === orgId)
      return r ? { ...r } : null
    },
    async claim(orgId, id, attempts) {
      const r = rows.find((x) => x.id === id && x.organization_id === orgId && x.status === 'pending' && x.attempts === attempts)
      if (!r) return false
      r.attempts = attempts + 1
      r.updated_at = new Date(clock()).toISOString()
      return true
    },
    async finish(id, attempts, patch) {
      const r = rows.find((x) => x.id === id && x.attempts === attempts && x.status === 'pending')
      if (!r) return false
      Object.assign(r, patch)
      return true
    },
    async list() {
      return rows
    },
  }
}

/** What the drain's list query returns: pending replayable updates, oldest first. */
const listOf = (rows: HeldWriteRow[]) => async (): Promise<DrainRow[]> =>
  rows
    .filter((r) => r.status === 'pending' && r.replayable && r.sf_operation === 'update')
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map((r) => ({ ...r }))

type Answer = { status: number; text: string } | Error | 'hang'
interface Sent { method: string; path: string; body?: string }

/** One Salesforce for the org: GETs answer `read(path)`, PATCHes answer `patch(path)`. */
function salesforce(opts: { read?: (path: string) => Answer; patch?: (path: string) => Answer } = {}) {
  const sent: Sent[] = []
  const port: SalesforcePort = {
    async send(method, path, body) {
      sent.push({ method, path, body })
      const a = method === 'GET' ? (opts.read ?? (() => ({ status: 200, text: JSON.stringify({ LastModifiedDate: BEFORE_THE_ROWS }) })))(path) : (opts.patch ?? (() => ({ status: 204, text: '' })))(path)
      if (a === 'hang') return new Promise(() => {})
      if (a instanceof Error) throw a
      return a
    },
    postApex: () => Promise.reject(new Error('the drain posted to Apex')),
  }
  return { port, sent, patches: () => sent.filter((s) => s.method === 'PATCH') }
}

function memoryKv() {
  const data = new Map<string, string>()
  const writes: string[] = []
  const kv: DrainKv & { data: Map<string, string>; writes: string[] } = {
    data,
    writes,
    async get(k) { return data.get(k) ?? null },
    async put(k, v) { writes.push(`put ${k}`); data.set(k, v) },
    async delete(k) { writes.push(`delete ${k}`); data.delete(k) },
    async list({ prefix }) { return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true } },
  }
  return kv
}

let rows: HeldWriteRow[]
let nowMs: number
let kv: ReturnType<typeof memoryKv>
let alerts: WritebackDrainAlert[]

function deps(sf: SalesforcePort, over: Partial<WritebackDrainDeps> = {}): WritebackDrainDeps {
  return {
    list: listOf(rows),
    store: memoryStore(rows, () => nowMs),
    keys: KEY,
    salesforceFor: async () => sf,
    readBackHolds: async () => false,
    busy: async () => null,
    kv,
    slackFor: async () => ({ bot_token: 'xoxb', default_channel: 'C1', config_alerts_enabled: true }),
    sendAlert: async (_slack, alert) => { alerts.push(alert); return true },
    now: () => nowMs,
    // A call that hangs is cut off on the next turn of the event loop, after
    // every fake that answers at once has answered: no test waits a real deadline.
    callDeadline: () => new Promise((resolve) => setTimeout(resolve, 0)),
    ...over,
  }
}

beforeEach(() => {
  seq = 0
  rows = []
  nowMs = T0
  kv = memoryKv()
  alerts = []
})

describe('runWritebackDrain', () => {
  it('replays a pending replayable row and finishes it', async () => {
    rows.push(await row())
    const sf = salesforce()
    const s = await runWritebackDrain(deps(sf.port))
    expect(s).toMatchObject({ listed: 1, replayed: 1 })
    expect(sf.patches()).toHaveLength(1)
    expect(JSON.parse(sf.patches()[0].body!)).toEqual({ Status__c: 'No Bid' })
    expect(rows[0]).toMatchObject({ status: 'replayed', attempts: 1 })
    expect(alerts).toEqual([])
  })

  it('reads nothing at all when no row is pending', async () => {
    let asked = false
    const s = await runWritebackDrain(deps(salesforce().port, { busy: async () => { asked = true; return null } }))
    expect(s).toMatchObject({ listed: 0, replayed: 0 })
    expect(asked).toBe(false)
  })

  it('closes a rejected resend as refused, alerts, and never sends it again', async () => {
    rows.push(await row())
    const sf = salesforce({ patch: () => ({ status: 400, text: '[{"errorCode":"FIELD_CUSTOM_VALIDATION_EXCEPTION"}]' }) })
    expect(await runWritebackDrain(deps(sf.port))).toMatchObject({ refused: 1 })
    expect(rows[0]).toMatchObject({ status: 'refused', replayable: false })
    expect(alerts).toEqual([{ kind: 'refused', tries: DRAIN_MAX_ATTEMPTS, writes: [{ sf_object: 'Prospect__c', resent: true }] }])
    nowMs += DRAIN_BACKOFF_MS * 10
    await runWritebackDrain(deps(sf.port))
    expect(sf.patches()).toHaveLength(1)
  })

  it('closes a row as abandoned after two failed attempts, waiting the backoff between them', async () => {
    rows.push(await row())
    const sf = salesforce({ patch: () => ({ status: 503, text: 'unavailable' }) })
    expect(await runWritebackDrain(deps(sf.port))).toMatchObject({ retrying: 1 })
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1 })

    // Inside the backoff: nothing is read or sent.
    nowMs += DRAIN_BACKOFF_MS - 1
    expect(await runWritebackDrain(deps(sf.port))).toMatchObject({ waiting: 1 })
    expect(sf.sent).toHaveLength(2)

    nowMs += 1
    expect(await runWritebackDrain(deps(sf.port))).toMatchObject({ abandoned: 1 })
    expect(rows[0]).toMatchObject({ status: 'abandoned', attempts: 2 })
    expect(sf.patches()).toHaveLength(2)
    expect(alerts).toEqual([{ kind: 'abandoned', tries: DRAIN_MAX_ATTEMPTS, writes: [{ sf_object: 'Prospect__c', answered: true }] }])
  })

  it('closes as abandoned a row whose attempts a person already spent, once no replay can be in flight', async () => {
    rows.push(await row({ attempts: 2, updated_at: new Date(T0 - 10 * 60_000).toISOString() }))
    const sf = salesforce()
    expect(await runWritebackDrain(deps(sf.port))).toMatchObject({ abandoned: 1 })
    expect(sf.sent).toEqual([])
    expect(rows[0].status).toBe('abandoned')
    expect(alerts).toHaveLength(1)
  })

  it('skips a row the Salesforce read-back holds, sending nothing and spending nothing', async () => {
    rows.push(await row())
    const sf = salesforce()
    const s = await runWritebackDrain(deps(sf.port, { readBackHolds: async () => true }))
    expect(s).toMatchObject({ skipped: 1, replayed: 0 })
    expect(sf.sent).toEqual([])
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('sends one record\'s rows in the order they were written, and holds the later one while the earlier is retrying', async () => {
    rows.push(await row({ body: { Status__c: 'Processing' } }), await row({ body: { Status__c: 'No Bid' } }))
    // The later row is listed first, to prove the order is the drain's.
    const listed = listOf(rows)
    const reversed = async () => (await listed()).reverse()
    const ok = salesforce()
    await runWritebackDrain(deps(ok.port, { list: reversed }))
    expect(ok.patches().map((p) => JSON.parse(p.body!).Status__c)).toEqual(['Processing', 'No Bid'])

    // An earlier row still waiting out its backoff holds the record's later row,
    // while another record's row goes ahead.
    rows.length = 0
    rows.push(
      await row({ body: { Status__c: 'Processing' }, attempts: 1, updated_at: new Date(nowMs - 1000).toISOString() }),
      await row({ body: { Status__c: 'No Bid' } }),
      await row({ sf_record_id: 'a0B000000000002AAA' }),
    )
    const next = salesforce()
    expect(await runWritebackDrain(deps(next.port))).toMatchObject({ waiting: 2, replayed: 1 })
    expect(next.patches().map((p) => p.path)).toEqual(['/sobjects/Prospect__c/a0B000000000002AAA'])
    expect(rows[1]).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('does not count a value the drain itself just wrote to the record as another writer\'s', async () => {
    rows.push(await row({ body: { Status__c: 'Processing' } }), await row({ body: { Status__c: 'No Bid' } }))
    // After the first PATCH, the record holds its value and was modified just now.
    let held: Record<string, unknown> = { LastModifiedDate: BEFORE_THE_ROWS }
    const sf = salesforce({
      read: () => ({ status: 200, text: JSON.stringify(held) }),
      patch: () => { held = { LastModifiedDate: '2026-10-15T20:00:00.000+0000', Status__c: 'Processing' }; return { status: 204, text: '' } },
    })
    expect(await runWritebackDrain(deps(sf.port))).toMatchObject({ replayed: 2, moved: 0 })
    expect(JSON.parse(sf.patches()[1].body!)).toEqual({ Status__c: 'No Bid' })
  })

  it('leaves out a field changed in Salesforce since the row was written, and names only the field in the alert', async () => {
    rows.push(await row({ body: { Status__c: 'No Bid', Amount__c: 5000 } }))
    const sf = salesforce({ read: () => ({ status: 200, text: JSON.stringify({ LastModifiedDate: '2026-10-15T20:10:00.000+0000', Status__c: 'Funded', Amount__c: null }) }) })
    expect(await runWritebackDrain(deps(sf.port))).toMatchObject({ replayed: 1, moved: 1 })
    expect(JSON.parse(sf.patches()[0].body!)).toEqual({ Amount__c: 5000 })
    expect(alerts).toEqual([{ kind: 'moved', tries: DRAIN_MAX_ATTEMPTS, writes: [{ sf_object: 'Prospect__c', fields: ['Status__c'], resent: true }] }])
    // No value, record id or run id reaches the alert.
    const said = JSON.stringify(alerts)
    for (const secret of ['Funded', 'No Bid', '5000', 'a0B000000000001AAA', rows[0].execution_id, rows[0].id]) expect(said).not.toContain(secret)
  })

  it('stops the tick at the first call Salesforce does not answer', async () => {
    rows.push(await row({ sf_record_id: 'a0B000000000001AAA' }), await row({ sf_record_id: 'a0B000000000002AAA' }))
    const sf = salesforce({ patch: () => 'hang' })
    const s = await runWritebackDrain(deps(sf.port))
    expect(s.stopped).toBe('salesforce_not_answering')
    expect(sf.patches()).toHaveLength(1)
    expect(rows[1]).toMatchObject({ attempts: 0 })
    // The unanswered attempt was spent: it may have landed.
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1 })
  })

  it('stops the tick at a read Salesforce does not answer, spending nothing', async () => {
    rows.push(await row({ sf_record_id: 'a0B000000000001AAA' }), await row({ sf_record_id: 'a0B000000000002AAA' }))
    const sf = salesforce({ read: () => 'hang' })
    expect((await runWritebackDrain(deps(sf.port))).stopped).toBe('salesforce_not_answering')
    expect(sf.sent).toHaveLength(1)
    expect(rows.map((r) => r.attempts)).toEqual([0, 0])
  })

  it('holds every row while the Salesforce bulkhead is full, or cannot be asked', async () => {
    rows.push(await row())
    const sf = salesforce()
    expect(await runWritebackDrain(deps(sf.port, { busy: async () => 'bulkhead_busy' }))).toMatchObject({ held: 'bulkhead_busy', replayed: 0 })
    expect(await runWritebackDrain(deps(sf.port, { busy: async () => { throw new Error('limiter down') } }))).toMatchObject({ held: 'bulkhead_unknown' })
    expect(sf.sent).toEqual([])
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('gives the attempt back and stops when the bulkhead refuses the call itself', async () => {
    rows.push(await row(), await row({ sf_record_id: 'a0B000000000002AAA' }))
    const shed = Object.assign(new Error('Salesforce bulkhead: at capacity (salesforce, 20/20 inflight, waited 0ms)'), { bulkheadShed: true })
    const sf = salesforce({ patch: () => shed })
    expect((await runWritebackDrain(deps(sf.port))).stopped).toBe('bulkhead_busy')
    expect(rows.map((r) => r.attempts)).toEqual([0, 0])
  })

  it('sends a row once when two ticks run at the same moment', async () => {
    rows.push(await row())
    const sf = salesforce()
    const store = memoryStore(rows, () => nowMs)
    const [a, b] = await Promise.all([runWritebackDrain(deps(sf.port, { store })), runWritebackDrain(deps(sf.port, { store }))])
    expect(sf.patches()).toHaveLength(1)
    expect(a.replayed + b.replayed).toBe(1)
    expect(a.deferred + b.deferred).toBe(1)
  })

  it('never writes the KV at-risk store, asking the read-back only through its own check', async () => {
    rows.push(await row())
    kv.data.set(`${AT_RISK_WRITE_PREFIX}${rows[0].execution_id}:${rows[0].step_namespace}`, 'not a record')
    const sf = salesforce({ patch: () => ({ status: 400, text: '[{"errorCode":"INVALID_FIELD"}]' }) })
    await runWritebackDrain(deps(sf.port, { readBackHolds: (e, s) => readBackHoldsStep(kv, KEY, e, s) }))
    expect(kv.writes.length).toBeGreaterThan(0)
    expect(kv.writes.filter((w) => w.includes(AT_RISK_WRITE_PREFIX))).toEqual([])
    expect(kv.writes.every((w) => w.startsWith(`put ${DRAIN_OUTBOX_PREFIX}`) || w.startsWith(`delete ${DRAIN_OUTBOX_PREFIX}`))).toBe(true)
  })

  it('keeps an alert Slack did not take, and says it on the next tick, once', async () => {
    rows.push(await row())
    const sf = salesforce({ patch: () => ({ status: 400, text: '[{"errorCode":"INVALID_FIELD"}]' }) })
    const failed = await runWritebackDrain(deps(sf.port, { sendAlert: async () => false }))
    expect(failed).toMatchObject({ refused: 1, alerts: 0, alert_failures: 1 })
    expect(alerts).toEqual([])
    await runWritebackDrain(deps(sf.port))
    expect(alerts).toHaveLength(1)
    await runWritebackDrain(deps(sf.port))
    expect(alerts).toHaveLength(1)
  })

  it('groups one organization\'s outcomes of a kind into one alert', async () => {
    rows.push(await row({ sf_record_id: 'a0B000000000001AAA' }), await row({ sf_record_id: 'a0B000000000002AAA', sf_object: 'Lead', body: { Status: 'Open' } }))
    const sf = salesforce({ patch: () => ({ status: 400, text: '[{"errorCode":"INVALID_FIELD"}]' }) })
    await runWritebackDrain(deps(sf.port))
    expect(alerts).toHaveLength(1)
    expect(alerts[0].writes.map((w) => w.sf_object).sort()).toEqual(['Lead', 'Prospect__c'])
  })

  it('reports a failed list as a failed read and sends nothing', async () => {
    const sf = salesforce()
    await expect(runWritebackDrain(deps(sf.port, { list: async () => { throw new Error('statement timeout') } }))).rejects.toThrow(/statement timeout/)
    expect(sf.sent).toEqual([])
  })
})

describe('listDrainRows', () => {
  function recordingDb(answer: { data: unknown; error: unknown }) {
    const calls: Array<[string, ...unknown[]]> = []
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'limit']) {
      chain[m] = (...args: unknown[]) => { calls.push([m, ...args]); return chain }
    }
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(answer).then(res)
    const client = { from: (t: string) => { calls.push(['from', t]); return chain } } as unknown as SupabaseClient
    return { client, calls }
  }

  it('reads only pending, replayable updates, oldest first, bounded, and never the encrypted columns', async () => {
    const db = recordingDb({ data: [], error: null })
    await listDrainRows(db.client)
    expect(db.calls).toContainEqual(['from', 'outcome_writeback_deadletters'])
    expect(db.calls).toContainEqual(['eq', 'status', 'pending'])
    expect(db.calls).toContainEqual(['eq', 'replayable', true])
    expect(db.calls).toContainEqual(['eq', 'sf_operation', 'update'])
    expect(db.calls).toContainEqual(['order', 'created_at', { ascending: true }])
    expect(db.calls).toContainEqual(['limit', DRAIN_LIST_LIMIT])
    const columns = String(db.calls.find((c) => c[0] === 'select')?.[1])
    expect(columns).not.toMatch(/encrypted/)
  })

  it('throws on a database error rather than reading it as nothing pending', async () => {
    await expect(listDrainRows(recordingDb({ data: null, error: { message: 'canceling statement' } }).client)).rejects.toThrow(/canceling statement/)
  })
})
