/**
 * The Salesforce read-back of post-answer writes (#2023, phase E of #2015).
 *
 * On 2026-10-13, 8 of 18 post-answer writes cut off by a Salesforce slowdown
 * never landed, and in the week to 2026-10-15, 19 of 42 timed out Prospect
 * reject patches never did (#2163). The at-risk watch (#2022) keeps each such
 * write's request in KV; this job reads the record back, judges "landed" by the
 * write's own marker (never by its fields looking equal), and resends the ones
 * that did not land.
 *
 * Salesforce here is a double holding records by id, the KV is a map, the
 * clock is a number each test moves, and nothing waits in real time (L524).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { encryptSecret } from '../secret-crypto'
import { atRiskKey, type AtRiskEntry } from '../../engine/at-risk-writes'
import { WRITE_MARKER_FIELD } from '../../engine/write-marker'
import type { SalesforcePort } from '../writeback-replay'
import type { AlertClaims, SendClaims } from '../alert-claim'
import type { SalesforceReadBackAlert } from '../salesforce-read-back-alert'
import {
  runSalesforceReadBack,
  checkSalesforceReadBackLiveness,
  decideRecord,
  sameSalesforceValue,
  SF_READ_BACK_JOB,
  SF_READ_BACK_MIN_AGE_MS,
  UNKNOWN_WINDOW_MS,
  UNREAD_ALERT_AFTER_MS,
  MAX_RESENDS,
  SF_CONCURRENCY,
  LONGEST_MEASURED_SALESFORCE_ANSWER_MS,
  type SalesforceReadBackDeps,
} from '../salesforce-read-back'
import { WAIT_UNTIL_LIMIT_MS } from '../post-response-budget'
import { completedKey } from '../cron-heartbeat'
import { runUnconfirmedWriteSweep } from '../unconfirmed-write-sweep'
import { putUnconfirmedWrite, UNCONFIRMED_WRITE_PREFIX } from '../../engine/unconfirmed-writes'

const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 123)).toString('base64')
const ORG = '11111111-1111-1111-1111-111111112023'
const WF = '22222222-2222-2222-2222-222222222023'
const T0 = Date.parse('2026-10-15T20:00:00.000Z')
const PROSPECT = 'a06Ui00002sLkNuIAK'
const EXEC_A = '01a13cf7-0191-7dc3-aada-59ceeacc1616'
const EXEC_B = '01a13cf7-0191-7dc3-aada-59ceeacc1617'
/** Salesforce's own spelling of a time, whole seconds and +0000. */
const BEFORE_THE_RUNS = '2026-10-15T19:00:00.000+0000'
const SINCE_THE_RUNS = '2026-10-15T19:58:00.000+0000'

function makeKv() {
  const store = new Map<string, string>()
  const puts: Array<{ key: string; value: string; opts?: { expiration?: number; expirationTtl?: number } }> = []
  return {
    store,
    puts,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string, opts?: { expiration?: number; expirationTtl?: number }) => {
      puts.push({ key: k, value: v, opts })
      store.set(k, v)
    }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
    // Pages as KV does: a cursor after each page that is not the last.
    list: vi.fn(async (opts: { prefix?: string; limit?: number; cursor?: string }) => {
      const names = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort()
      const start = opts.cursor ? Number(opts.cursor) : 0
      const end = start + (opts.limit ?? 1000)
      const complete = end >= names.length
      return { keys: names.slice(start, end).map((name) => ({ name })), list_complete: complete, ...(complete ? {} : { cursor: String(end) }) }
    }),
  }
}
type Kv = ReturnType<typeof makeKv>

/** Settled held writes from older runs, which sort before EXEC_A and stay in KV until they expire. */
async function settledAhead(kv: Kv, n: number) {
  const entry = JSON.parse(kv.store.get(await hold(kv, { exec: '00000000-0000-7000-8000-000000000000', step: 'seed', body: {} }))!) as AtRiskEntry
  kv.store.delete(atRiskKey('00000000-0000-7000-8000-000000000000', 'seed'))
  for (let i = 0; i < n; i++) {
    const exec = `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`
    kv.store.set(atRiskKey(exec, 'patch_prospect_reject'), JSON.stringify({ ...entry, execution_id: exec, step_namespace: 'patch_prospect_reject' }))
    kv.store.set(`sf-read-back:state:${exec}:patch_prospect_reject`, JSON.stringify({ v: 1, attempts: 2, done: { kind: 'unknown', at: new Date(T0).toISOString(), fields: ['BidStatus__c'] }, alerted: { done: new Date(T0).toISOString() } }))
  }
}

interface Held {
  exec?: string
  step: string
  object?: string
  record?: string
  body: Record<string, unknown>
  /** Minutes before T0 the step started. */
  ago?: number
  /** Leave the engine stamp out, as a write held from before it shipped. */
  unstamped?: boolean
}

async function hold(kv: Kv, h: Held): Promise<string> {
  const exec = h.exec ?? EXEC_A
  const object = h.object ?? 'Prospect__c'
  const at = new Date(T0 - (h.ago ?? 10) * 60_000).toISOString()
  const body = h.unstamped ? h.body : { ...h.body, [WRITE_MARKER_FIELD]: `${exec}:${h.step}:0` }
  const entry: AtRiskEntry = {
    v: 1,
    org_id: ORG,
    workflow_id: WF,
    execution_id: exec,
    step_namespace: h.step,
    sf_object: object,
    sf_record_id: h.record ?? PROSPECT,
    sf_operation: 'update',
    body_encrypted: await encryptSecret(JSON.stringify(body), KEY),
    first_attempt_at: at,
    recorded_at: new Date(Date.parse(at) + 2000).toISOString(),
  }
  const key = atRiskKey(exec, h.step)
  kv.store.set(key, JSON.stringify(entry))
  return key
}

type PatchMode = 'lands' | 'refused' | 'no answer' | 'lands, no answer'

/**
 * Salesforce as the record store the read-back sees through the node's one call
 * path: a GET reads the named fields, a PATCH writes the body (all or nothing).
 */
function makeSalesforce(records: Record<string, Record<string, unknown>>) {
  const state = { down: false, patch: 'lands' as PatchMode, inflight: 0, maxInflight: 0, gate: null as Promise<void> | null }
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
  const port: SalesforcePort = {
    async send(method, path, body) {
      state.inflight++
      state.maxInflight = Math.max(state.maxInflight, state.inflight)
      try {
        if (state.gate) await state.gate
        calls.push({ method, path, ...(body ? { body: JSON.parse(body) as Record<string, unknown> } : {}) })
        if (state.down) throw new Error('fetch failed: connect ETIMEDOUT')
        const [, , object, id] = path.split('?')[0].split('/')
        const record = records[id]
        if (!record) return { status: 404, text: JSON.stringify([{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]) }
        if (method === 'GET') {
          const fields = new URL(`https://x${path}`).searchParams.get('fields')!.split(',')
          // A record nobody has written since an hour before the runs, unless a case says otherwise.
          const withStamp: Record<string, unknown> = { LastModifiedDate: BEFORE_THE_RUNS, ...record }
          return { status: 200, text: JSON.stringify(Object.fromEntries([['attributes', { type: object }], ...fields.map((f) => [f, withStamp[f] ?? null])])) }
        }
        if (state.patch === 'refused') return { status: 400, text: JSON.stringify([{ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Bid status cannot move back' }]) }
        if (state.patch === 'no answer') throw new Error('Salesforce did not answer')
        Object.assign(record, JSON.parse(body!), { LastModifiedDate: SINCE_THE_RUNS })
        if (state.patch === 'lands, no answer') throw new Error('Salesforce did not answer')
        return { status: 204, text: '' }
      } finally {
        state.inflight--
      }
    },
    // No update is ever posted to an Apex endpoint.
    postApex: () => Promise.reject(new Error('an update was posted to Apex')),
  }
  return { port, calls, state, records }
}

function makeClaims(): AlertClaims & { held: Set<string> } {
  const held = new Set<string>()
  return {
    held,
    async claim(key) {
      if (held.has(key)) return false
      held.add(key)
      return true
    },
    async release(key) { held.delete(key) },
  }
}

/** The send claim as the Durable Object answers it: one caller per key wins. */
function makeSendClaimsDouble(): SendClaims & { held: Set<string> } {
  const held = new Set<string>()
  return {
    held,
    claim(key) {
      if (held.has(key)) return Promise.resolve('taken' as const)
      held.add(key)
      return Promise.resolve('claimed' as const)
    },
    release(key) {
      held.delete(key)
      return Promise.resolve()
    },
  }
}

interface Rig {
  kv: Kv
  sf: ReturnType<typeof makeSalesforce>
  alerts: SalesforceReadBackAlert[]
  deps: SalesforceReadBackDeps
  clock: { now: number }
}

function rig(records: Record<string, Record<string, unknown>> = {}, overrides: Partial<SalesforceReadBackDeps> = {}): Rig {
  const kv = makeKv()
  const sf = makeSalesforce(records)
  const alerts: SalesforceReadBackAlert[] = []
  const clock = { now: T0 }
  const deps: SalesforceReadBackDeps = {
    kv,
    keys: KEY,
    portFor: async () => sf.port,
    busy: async () => null,
    resendClaims: makeSendClaimsDouble(),
    alertClaims: makeClaims(),
    slackFor: async () => ({ bot_token: 'x', default_channel: '#alerts', config_alerts_enabled: true }),
    sendAlert: async (_slack, payload) => { alerts.push(payload); return true },
    workflowNames: async () => new Map([[WF, 'Engine Bidding Workflow']]),
    appUrl: 'https://app.test',
    now: () => clock.now,
    callDeadline: () => new Promise<void>(() => {}),
    ...overrides,
  }
  return { kv, sf, alerts, deps, clock }
}

const REJECT = { BidStatus__c: 'Rejected', RejectionReason__c: 'unqualified_lead' }
const atRiskKeys = (kv: Kv) => [...kv.store.keys()].filter((k) => k.startsWith('at-risk-write:'))
const patches = (r: Rig) => r.sf.calls.filter((c) => c.method === 'PATCH')

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('the minimum age before a first read', () => {
  it('is the last moment a post-answer write can be sent plus the longest Salesforce answer measured, in whole minutes', () => {
    // A post-answer step starts after the answer, and Cloudflare stops all work
    // 30 s after the answer, so nothing is sent later than 30 s after the step
    // began; a sent PATCH has taken up to 91.5 s to answer (2026-07-22).
    expect(LONGEST_MEASURED_SALESFORCE_ANSWER_MS).toBe(91_500)
    expect(SF_READ_BACK_MIN_AGE_MS).toBeGreaterThanOrEqual(WAIT_UNTIL_LIMIT_MS + LONGEST_MEASURED_SALESFORCE_ANSWER_MS)
    expect(SF_READ_BACK_MIN_AGE_MS % 60_000).toBe(0)
    expect(SF_READ_BACK_MIN_AGE_MS).toBe(3 * 60_000)
  })

  it('does not read a write younger than that', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT, ago: 2 })
    const s = await runSalesforceReadBack(r.deps)
    expect(s.young).toBe(1)
    expect(r.sf.calls).toEqual([])
  })
})

describe('cut off, then landed', () => {
  it('finds its own stamp on the record, sends nothing, and drops the record', async () => {
    const r = rig({ [PROSPECT]: { ...REJECT, [WRITE_MARKER_FIELD]: `${EXEC_A}:patch_prospect_reject:0` } })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT })
    const s = await runSalesforceReadBack(r.deps)
    expect(s.landed).toBe(1)
    expect(patches(r)).toEqual([])
    expect(atRiskKeys(r.kv)).toEqual([])
    expect(r.alerts).toEqual([])
    // One read for the record, naming the marker and the fields it set.
    expect(r.sf.calls).toHaveLength(1)
    expect(r.sf.calls[0].path).toBe(`/sobjects/Prospect__c/${PROSPECT}?fields=${WRITE_MARKER_FIELD},LastModifiedDate,BidStatus__c,RejectionReason__c`)
  })
})

describe('cut off, then missing', () => {
  it('resends it once with attempt 1, and a 2xx confirms it', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid', RejectionReason__c: null } })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT })
    const s = await runSalesforceReadBack(r.deps)
    expect(patches(r)).toEqual([
      { method: 'PATCH', path: `/sobjects/Prospect__c/${PROSPECT}`, body: { BidStatus__c: 'Rejected', RejectionReason__c: 'unqualified_lead', [WRITE_MARKER_FIELD]: `${EXEC_A}:patch_prospect_reject:1` } },
    ])
    expect(s.resent_confirmed).toBe(1)
    expect(atRiskKeys(r.kv)).toEqual([])
    expect(r.alerts).toEqual([])
  })

  it('writes the attempt count before it sends', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT })
    const order: string[] = []
    r.kv.put.mockImplementation(async (k: string, v: string) => { order.push(`put ${k}`); r.kv.store.set(k, v) })
    const send = r.sf.port.send
    r.deps.portFor = async () => ({ ...r.sf.port, send: async (m, p, b) => { order.push(`${m}`); return send(m, p, b) } })
    await runSalesforceReadBack(r.deps)
    const statePut = order.findIndex((o) => o.startsWith('put sf-read-back:state:'))
    expect(statePut).toBeGreaterThan(-1)
    expect(statePut).toBeLessThan(order.indexOf('PATCH'))
  })

  it('confirms by its attempt 1 stamp on the next tick when the resend got no answer but landed', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT })
    r.sf.state.patch = 'lands, no answer'
    const first = await runSalesforceReadBack(r.deps)
    expect(first.resend_unanswered).toBe(1)
    expect(atRiskKeys(r.kv)).toHaveLength(1)
    // Next minute: too soon after the resend to read it.
    r.clock.now += 60_000
    expect((await runSalesforceReadBack(r.deps)).young).toBe(1)
    r.clock.now += SF_READ_BACK_MIN_AGE_MS
    const later = await runSalesforceReadBack(r.deps)
    expect(later.landed).toBe(1)
    expect(patches(r)).toHaveLength(1)
    expect(atRiskKeys(r.kv)).toEqual([])
  })

  it('resends at most twice, then says it is still not confirmed', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT })
    r.sf.state.patch = 'no answer'
    for (let i = 0; i < 4; i++) {
      await runSalesforceReadBack(r.deps)
      r.clock.now += SF_READ_BACK_MIN_AGE_MS
    }
    expect(patches(r).map((p) => p.body?.[WRITE_MARKER_FIELD])).toEqual([`${EXEC_A}:patch_prospect_reject:1`, `${EXEC_A}:patch_prospect_reject:2`])
    expect(MAX_RESENDS).toBe(2)
    const unknown = r.alerts.filter((a) => a.kind === 'unknown')
    expect(unknown).toHaveLength(1)
    expect(unknown[0].writes[0]).toMatchObject({ sf_object: 'Prospect__c', sf_record_id: PROSPECT, fields: ['BidStatus__c', 'RejectionReason__c'], resends: 2 })
  })

  it('says a write it resent is still not confirmed once its window has passed', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT, ago: UNKNOWN_WINDOW_MS / 60_000 - 1 })
    r.sf.state.patch = 'no answer'
    await runSalesforceReadBack(r.deps)
    expect(r.alerts).toEqual([])
    r.clock.now += 2 * 60_000
    await runSalesforceReadBack(r.deps)
    expect(r.alerts.map((a) => a.kind)).toEqual(['unknown'])
    // Once said, not said again.
    r.clock.now += SF_READ_BACK_MIN_AGE_MS
    await runSalesforceReadBack(r.deps)
    expect(r.alerts.map((a) => a.kind)).toEqual(['unknown'])
  })

  it('alerts that the resend failed when Salesforce refuses it, and does not try again', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT })
    r.sf.state.patch = 'refused'
    const s = await runSalesforceReadBack(r.deps)
    expect(s.resend_refused).toBe(1)
    expect(r.alerts).toHaveLength(1)
    expect(r.alerts[0]).toMatchObject({ kind: 'resend_failed', writes: [{ sf_record_id: PROSPECT, fields: ['BidStatus__c', 'RejectionReason__c'], detail: 'Salesforce answered 400 FIELD_CUSTOM_VALIDATION_EXCEPTION' }] })
    r.clock.now += SF_READ_BACK_MIN_AGE_MS
    await runSalesforceReadBack(r.deps)
    expect(patches(r)).toHaveLength(1)
    expect(r.alerts).toHaveLength(1)
  })

  it('alerts that the resend failed when the record no longer exists', async () => {
    const r = rig({})
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT })
    await runSalesforceReadBack(r.deps)
    expect(patches(r)).toEqual([])
    expect(r.alerts[0]).toMatchObject({ kind: 'resend_failed', writes: [{ detail: 'the record no longer exists in Salesforce' }] })
  })
})

describe('two writes to one record in one run', () => {
  // Lead Economy writes a Prospect with patch_prospect, then patch_prospect_success.
  const WIN = { BidStatus__c: 'Bid', ExternalExchangeStatus__c: 'Bid', Tripoint_Response__c: 'Pending' }
  const SUCCESS = { TripointLeadID__c: 'TP-1', Tripoint_Response__c: 'Success' }

  async function holdBoth(kv: Kv) {
    // Listed newest first: the later step's key sorts before the earlier one's.
    await hold(kv, { step: 'a_patch_prospect_success', body: SUCCESS, ago: 9 })
    await hold(kv, { step: 'z_patch_prospect', body: WIN, ago: 10 })
  }

  it('does not judge the earlier write landed because the later one\'s stamp is present', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: null, TripointLeadID__c: 'TP-1', Tripoint_Response__c: 'Success', [WRITE_MARKER_FIELD]: `${EXEC_A}:a_patch_prospect_success:0`, LastModifiedDate: SINCE_THE_RUNS } })
    await holdBoth(r.kv)
    const s = await runSalesforceReadBack(r.deps)
    expect(s.landed).toBe(1)
    // The earlier write is resent, without the field the later one owns (newer wins).
    expect(patches(r)).toEqual([
      { method: 'PATCH', path: `/sobjects/Prospect__c/${PROSPECT}`, body: { BidStatus__c: 'Bid', ExternalExchangeStatus__c: 'Bid', [WRITE_MARKER_FIELD]: `${EXEC_A}:z_patch_prospect:1` } },
    ])
    expect(r.sf.records[PROSPECT].Tripoint_Response__c).toBe('Success')
    expect(r.alerts).toEqual([])
    // One read for both writes to the record.
    expect(r.sf.calls.filter((c) => c.method === 'GET')).toHaveLength(1)
  })

  it('resends both, oldest first, when neither landed, and the newer value wins', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } })
    await holdBoth(r.kv)
    await runSalesforceReadBack(r.deps)
    expect(patches(r).map((p) => p.body)).toEqual([
      { BidStatus__c: 'Bid', ExternalExchangeStatus__c: 'Bid', [WRITE_MARKER_FIELD]: `${EXEC_A}:z_patch_prospect:1` },
      { TripointLeadID__c: 'TP-1', Tripoint_Response__c: 'Success', [WRITE_MARKER_FIELD]: `${EXEC_A}:a_patch_prospect_success:1` },
    ])
    expect(r.sf.records[PROSPECT]).toMatchObject({ Tripoint_Response__c: 'Success', [WRITE_MARKER_FIELD]: `${EXEC_A}:a_patch_prospect_success:1` })
    expect(r.alerts).toEqual([])
  })

  it('keeps leaving out the later write\'s field on a later resend, once the later one is gone', async () => {
    const r = rig({ [PROSPECT]: { TripointLeadID__c: 'TP-1', Tripoint_Response__c: 'Success', [WRITE_MARKER_FIELD]: `${EXEC_A}:a_patch_prospect_success:0` } })
    await holdBoth(r.kv)
    r.sf.state.patch = 'no answer'
    await runSalesforceReadBack(r.deps)
    r.clock.now += SF_READ_BACK_MIN_AGE_MS
    await runSalesforceReadBack(r.deps)
    expect(patches(r).map((p) => Object.keys(p.body!).sort())).toEqual([
      ['BidStatus__c', WRITE_MARKER_FIELD, 'ExternalExchangeStatus__c'],
      ['BidStatus__c', WRITE_MARKER_FIELD, 'ExternalExchangeStatus__c'],
    ])
    // The later write's value is ours, never a conflict.
    expect(r.alerts.filter((a) => a.kind === 'conflict')).toEqual([])
  })
})

describe('a field another writer has moved', () => {
  it('is not overwritten, and is named, by field name only, in a conflict alert', async () => {
    // Liberty1's update_prospect wrote Fail; another writer has since set Completed.
    const r = rig({ [PROSPECT]: { ExternalExchangeStatus__c: 'Completed', ExternalPartnerName__c: null, LastModifiedDate: SINCE_THE_RUNS } })
    await hold(r.kv, { step: 'update_prospect', body: { ExternalExchangeStatus__c: 'Fail', ExternalPartnerName__c: 'Liberty1' } })
    await runSalesforceReadBack(r.deps)
    expect(patches(r).map((p) => p.body)).toEqual([{ ExternalPartnerName__c: 'Liberty1', [WRITE_MARKER_FIELD]: `${EXEC_A}:update_prospect:1` }])
    expect(r.sf.records[PROSPECT].ExternalExchangeStatus__c).toBe('Completed')
    expect(r.alerts).toHaveLength(1)
    expect(r.alerts[0]).toMatchObject({ kind: 'conflict', writes: [{ conflict_fields: ['ExternalExchangeStatus__c'], resent: true }] })
    expect(JSON.stringify(r.alerts[0])).not.toMatch(/Completed|"Fail"/)
  })

  it('counts the conflict per field, against the resends that carried that field', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'Won Bid', LastModifiedDate: SINCE_THE_RUNS }, a06Ui00002rn8xtIAA: { BidStatus__c: null } })
    await hold(r.kv, { step: 'patch_prospect_reject', body: { BidStatus__c: 'Rejected' } })
    await hold(r.kv, { exec: EXEC_B, step: 'patch_prospect_reject', record: 'a06Ui00002rn8xtIAA', body: { BidStatus__c: 'Rejected' } })
    const s = await runSalesforceReadBack(r.deps)
    expect(s.conflict_fields).toEqual({ 'Prospect__c.BidStatus__c': { conflicts: 1, candidates: 2 } })
    const conflict = r.alerts.find((a) => a.kind === 'conflict')
    expect(conflict?.conflict_rates).toEqual([{ field: 'BidStatus__c', sf_object: 'Prospect__c', conflicts: 1, candidates: 2 }])
  })

  // A Prospect starts at No Bid, which every reject patch replaces: on a record
  // nobody has written since the write began, that is the value it was meant to
  // replace, never another writer's. The 19 lost reject patches of #2163 read so.
  it('replaces a value from before the write when nothing has written the record since', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT })
    await runSalesforceReadBack(r.deps)
    expect(patches(r).map((p) => p.body?.BidStatus__c)).toEqual(['Rejected'])
    expect(r.alerts).toEqual([])
  })

  it('reads a write made in the same second as the step began as moved since, given whole second stamps', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'Won Bid', LastModifiedDate: '2026-10-15T19:50:00.000+0000' } })
    // The step began at 19:50:00.000 UTC, ten minutes before T0, and Salesforce
    // keeps whole seconds, so a write in that second may have come after it.
    await hold(r.kv, { step: 'patch_prospect_reject', body: { BidStatus__c: 'Rejected' } })
    await runSalesforceReadBack(r.deps)
    expect(patches(r)).toEqual([])
    expect(r.alerts[0]).toMatchObject({ kind: 'conflict' })
  })

  it('sends nothing when every field it set has moved, and says so', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'Won Bid', LastModifiedDate: SINCE_THE_RUNS } })
    await hold(r.kv, { step: 'patch_prospect_reject', body: { BidStatus__c: 'Rejected' } })
    await runSalesforceReadBack(r.deps)
    expect(patches(r)).toEqual([])
    expect(r.alerts[0]).toMatchObject({ kind: 'conflict', writes: [{ conflict_fields: ['BidStatus__c'], resent: false }] })
  })
})

describe('the resend claim', () => {
  it('sends nothing when the claim gets no answer, since it fails closed', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } }, { resendClaims: { claim: () => Promise.resolve('unanswered' as const), release: async () => {} } })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT })
    const s = await runSalesforceReadBack(r.deps)
    expect(patches(r)).toEqual([])
    expect(s.deferred).toBe(1)
    expect(atRiskKeys(r.kv)).toHaveLength(1)
  })

  // A claim object down for two minutes used to spend both resends while
  // sending nothing, then report the write as tried twice (push review, #2023).
  it('spends no attempt while the claim gets no answer, so the resends are still there once it does', async () => {
    let answering = false
    const claims = makeSendClaimsDouble()
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } }, {
      resendClaims: { claim: (k, ttl) => (answering ? claims.claim(k, ttl) : Promise.resolve('unanswered' as const)), release: claims.release },
    })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT })
    for (let i = 0; i < 3; i++) {
      await runSalesforceReadBack(r.deps)
      r.clock.now += 60_000
    }
    expect(patches(r)).toEqual([])
    answering = true
    await runSalesforceReadBack(r.deps)
    expect(patches(r).map((p) => p.body?.[WRITE_MARKER_FIELD])).toEqual([`${EXEC_A}:patch_prospect_reject:1`])
    expect(r.alerts.filter((a) => a.kind === 'unknown')).toEqual([])
  })

  it('still says a write it could not resend is not confirmed once its window has passed', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } }, { resendClaims: { claim: () => Promise.resolve('unanswered' as const), release: async () => {} } })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT, ago: UNKNOWN_WINDOW_MS / 60_000 + 1 })
    await runSalesforceReadBack(r.deps)
    expect(r.alerts).toHaveLength(1)
    expect(r.alerts[0]).toMatchObject({ kind: 'unknown', writes: [{ sf_record_id: PROSPECT, resends: 0 }] })
  })

  it('frees its claim and sends nothing when it cannot count the attempt', async () => {
    const claims = makeSendClaimsDouble()
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } }, { resendClaims: claims })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT })
    r.kv.put.mockImplementation(async (k: string, v: string) => {
      if (k.startsWith('sf-read-back:state:')) throw new Error('KV PUT failed: 429 Too Many Requests')
      r.kv.store.set(k, v)
    })
    const s = await runSalesforceReadBack(r.deps)
    expect(patches(r)).toEqual([])
    expect(s.deferred).toBe(1)
    expect(claims.held.size).toBe(0)
  })

  it('lets two overlapping ticks send one resend between them', async () => {
    const claims = makeSendClaimsDouble()
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } }, { resendClaims: claims })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT })
    r.sf.state.patch = 'no answer'
    await Promise.all([runSalesforceReadBack(r.deps), runSalesforceReadBack(r.deps)])
    expect(patches(r)).toHaveLength(1)
  })
})

describe('Salesforce not answering', () => {
  it('stops after the first call that gets no answer, and resends nothing', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' }, a06Ui00002rn8xtIAA: {} })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT })
    await hold(r.kv, { exec: EXEC_B, step: 'patch_prospect_reject', record: 'a06Ui00002rn8xtIAA', body: REJECT })
    r.sf.state.down = true
    const s = await runSalesforceReadBack({ ...r.deps, now: () => r.clock.now })
    expect(r.sf.calls.length).toBeLessThanOrEqual(SF_CONCURRENCY)
    expect(patches(r)).toEqual([])
    expect(s.unread).toBe(2)
    expect(atRiskKeys(r.kv)).toHaveLength(2)
  })

  it('leaves the database read-back working: its entries still resolve', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } })
    r.sf.state.down = true
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT })
    await putUnconfirmedWrite(r.kv, {
      id: 'execution_finalize:e1',
      label: 'execution_finalize',
      org_id: ORG,
      first_seen_at: new Date(T0 - 10 * 60_000).toISOString(),
      read_back: { kind: 'execution_finalized', execution_id: EXEC_A, started_at: '2026-10-15T19:50:00.000Z' },
      error_message: 'no answer within the budget',
    }, T0 - 10 * 60_000)
    const supabase = {
      from: () => {
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'gte', 'lt', 'in', 'limit']) chain[m] = () => chain
        chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: EXEC_A, status: 'completed' }], error: null }).then(ok)
        return chain
      },
    }
    const [sf, db] = await Promise.all([
      runSalesforceReadBack(r.deps),
      runUnconfirmedWriteSweep({ kv: r.kv as never, supabase: supabase as never, appUrl: 'https://app.test', now: () => T0, slackFor: async () => null, readDeadline: () => new Promise<void>(() => {}) }),
    ])
    expect(db.landed).toBe(1)
    expect([...r.kv.store.keys()].filter((k) => k.startsWith(UNCONFIRMED_WRITE_PREFIX))).toEqual([])
    expect(sf.unread).toBe(1)
    expect(atRiskKeys(r.kv)).toHaveLength(1)
  })

  it('says how old the oldest unread write is once it has waited too long', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } })
    r.sf.state.down = true
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT, ago: UNREAD_ALERT_AFTER_MS / 60_000 - 1 })
    await runSalesforceReadBack(r.deps)
    expect(r.alerts).toEqual([])
    r.clock.now += 2 * 60_000
    await runSalesforceReadBack(r.deps)
    expect(r.alerts).toHaveLength(1)
    expect(r.alerts[0]).toMatchObject({ kind: 'unread', count: 1, reason: 'salesforce_not_answering', oldest_at: new Date(T0 - (UNREAD_ALERT_AFTER_MS - 60_000)).toISOString() })
  })

  it('counts as waiting only the writes it owns and has not settled', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } })
    r.sf.state.down = true
    const ago = UNREAD_ALERT_AFTER_MS / 60_000 + 1
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT, ago })
    await hold(r.kv, { exec: EXEC_B, step: 'patch_prospect_reject', body: REJECT, ago })
    r.kv.store.set(`sf-read-back:state:${EXEC_B}:patch_prospect_reject`, JSON.stringify({ v: 1, attempts: 2, done: { kind: 'unknown', at: new Date(T0).toISOString(), fields: ['BidStatus__c'] }, alerted: { done: new Date(T0).toISOString() } }))
    await hold(r.kv, { exec: '01a13cf7-0191-7dc3-aada-59ceeacc1618', step: 'patch_prospect_reject', body: REJECT, ago, unstamped: true })
    await runSalesforceReadBack(r.deps)
    expect(r.alerts).toHaveLength(1)
    expect(r.alerts[0]).toMatchObject({ kind: 'unread', count: 1 })
  })

  it('sends nothing while the Salesforce limiter is full', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } }, { busy: async () => 'bulkhead_busy' })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT })
    const s = await runSalesforceReadBack(r.deps)
    expect(r.sf.calls).toEqual([])
    expect(s.unread).toBe(1)
    expect(s.stopped).toBe('bulkhead_busy')
  })

  it('never has more than its cap of calls out at once', async () => {
    const records: Record<string, Record<string, unknown>> = {}
    const r = rig(records)
    let open: () => void = () => {}
    r.sf.state.gate = new Promise<void>((resolve) => { open = resolve })
    for (let i = 0; i < 6; i++) {
      const id = `a06Ui00002rn8x${i}IAA`
      records[id] = { BidStatus__c: 'No Bid' }
      await hold(r.kv, { exec: `01a13cf7-0191-7dc3-aada-59ceeacc160${i}`, step: 'patch_prospect_reject', record: id, body: REJECT })
    }
    const done = runSalesforceReadBack(r.deps)
    // Decrypting the held bodies is real WebCrypto work, so wait on the condition
    // rather than a fixed number of turns (L290), then a few more turns to see
    // that nothing past the cap starts.
    const turn = () => new Promise((resolve) => setImmediate(resolve))
    for (let i = 0; i < 500 && r.sf.state.inflight < SF_CONCURRENCY; i++) await turn()
    for (let i = 0; i < 20; i++) await turn()
    expect(r.sf.state.inflight).toBe(SF_CONCURRENCY)
    r.sf.state.gate = null
    open()
    await done
    expect(r.sf.state.maxInflight).toBe(SF_CONCURRENCY)
    expect(patches(r)).toHaveLength(6)
  })
})

describe('a held write it cannot open', () => {
  // The capture left it to the read-back, so no held alert went out for it: if
  // the read-back only logged it, the write would be lost in silence (L13).
  it('says so once it has waited too long, rather than only logging it', async () => {
    const r = rig({ [PROSPECT]: {} })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT, ago: UNREAD_ALERT_AFTER_MS / 60_000 + 1 })
    const key = atRiskKeys(r.kv)[0]
    const entry = JSON.parse(r.kv.store.get(key)!) as AtRiskEntry
    r.kv.store.set(key, JSON.stringify({ ...entry, body_encrypted: await encryptSecret('{}', Buffer.from(new Uint8Array(32).fill(9)).toString('base64')) }))
    const s = await runSalesforceReadBack(r.deps)
    expect(s.unreadable_entries).toBe(1)
    expect(r.sf.calls).toEqual([])
    expect(r.alerts).toHaveLength(1)
    expect(r.alerts[0]).toMatchObject({ kind: 'unread', count: 1, reason: 'held_unreadable' })
  })
})

describe('a record of its own it cannot read', () => {
  it('treats an unreadable resend time as just sent, the side that sends nothing early', async () => {
    const r = rig({ [PROSPECT]: { BidStatus__c: 'No Bid' } })
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT })
    r.kv.store.set(`sf-read-back:state:${EXEC_A}:patch_prospect_reject`, JSON.stringify({ v: 1, attempts: 1, last_attempt_at: 'not a time' }))
    const s = await runSalesforceReadBack(r.deps)
    expect(s.young).toBe(1)
    expect(r.sf.calls).toEqual([])
  })
})

describe('what the read-back leaves alone', () => {
  it('still reads a write behind more settled ones than one page of the list holds', async () => {
    const r = rig({ [PROSPECT]: { [WRITE_MARKER_FIELD]: `${EXEC_A}:patch_prospect_reject:0` } })
    await settledAhead(r.kv, 260)
    await hold(r.kv, { step: 'patch_prospect_reject', body: REJECT })
    const s = await runSalesforceReadBack(r.deps)
    expect(s.finished).toBe(260)
    expect(s.landed).toBe(1)
  })

  it('does not read a Submission update, or one held from before the stamp shipped', async () => {
    const r = rig({ [PROSPECT]: {}, a04Ui00000NkhG1IAJ: {} })
    await hold(r.kv, { step: 'update_submission', object: 'Submission__c', record: 'a04Ui00000NkhG1IAJ', body: { PDFlow_3__c: 'x' }, unstamped: true })
    await hold(r.kv, { exec: EXEC_B, step: 'patch_prospect_reject', body: REJECT, unstamped: true })
    const s = await runSalesforceReadBack(r.deps)
    expect(s.not_ours).toBe(2)
    expect(r.sf.calls).toEqual([])
    expect(atRiskKeys(r.kv)).toHaveLength(2)
  })
})

describe('decideRecord', () => {
  const entry = (id: string, body: Record<string, unknown>, attempts = 0, ownedByLater: string[] = []) => ({ id, body, attempts, ownedByLater })

  it('judges each write by its own stamp, never another\'s', () => {
    const d = decideRecord(
      [entry(`${EXEC_A}:one`, { A__c: 1 }), entry(`${EXEC_A}:two`, { B__c: 2 })],
      { A__c: null, B__c: 2, [WRITE_MARKER_FIELD]: `${EXEC_A}:two:0` },
    )
    expect(d.map((x) => x.verdict)).toEqual(['resend', 'landed'])
  })

  it('calls a write whose every field a later write of the run sets superseded', () => {
    const d = decideRecord([entry(`${EXEC_A}:one`, { A__c: 1 }), entry(`${EXEC_A}:two`, { A__c: 2 })], { A__c: null })
    expect(d.map((x) => x.verdict)).toEqual(['superseded', 'resend'])
  })

  it('replaces a different value on a record nobody wrote since the write began, and keeps it otherwise', () => {
    const untouched = decideRecord([{ ...entry(`${EXEC_A}:one`, { A__c: 'new' }), firstAttemptMs: T0 }], { A__c: 'old', LastModifiedDate: BEFORE_THE_RUNS })
    expect(untouched[0]).toMatchObject({ verdict: 'resend', send: { A__c: 'new' }, conflicts: [] })
    const moved = decideRecord([{ ...entry(`${EXEC_A}:one`, { A__c: 'new' }), firstAttemptMs: T0 }], { A__c: 'old', LastModifiedDate: '2026-10-15T20:00:05.000+0000' })
    expect(moved[0]).toMatchObject({ verdict: 'conflict_only', conflicts: ['A__c'] })
    // No readable stamp: judged as moved, the side that overwrites nothing.
    const unknown = decideRecord([{ ...entry(`${EXEC_A}:one`, { A__c: 'new' }), firstAttemptMs: T0 }], { A__c: 'old' })
    expect(unknown[0]).toMatchObject({ verdict: 'conflict_only' })
  })

  it('does not call a value an earlier write of the run sent a conflict', () => {
    const d = decideRecord([entry(`${EXEC_A}:one`, { A__c: 'x', C__c: 1 }), entry(`${EXEC_A}:two`, { A__c: 'y' })], { A__c: 'x', C__c: null })
    expect(d[1]).toMatchObject({ verdict: 'resend', send: { A__c: 'y' }, conflicts: [] })
  })
})

describe('sameSalesforceValue', () => {
  it('reads Salesforce\'s own spelling of a value as the same value', () => {
    expect(sameSalesforceValue(4, '4')).toBe(true)
    expect(sameSalesforceValue(4.0, 4)).toBe(true)
    expect(sameSalesforceValue('2026-10-15T12:00:00.000+0000', '2026-10-15T12:00:00.123Z')).toBe(true)
    expect(sameSalesforceValue(true, 'true')).toBe(true)
  })

  it('reads a genuinely different value as different', () => {
    expect(sameSalesforceValue('Completed', 'Pending')).toBe(false)
    expect(sameSalesforceValue(2065, 1965)).toBe(false)
    expect(sameSalesforceValue('2026-10-15T12:00:01.000+0000', '2026-10-15T12:00:00.000Z')).toBe(false)
    expect(sameSalesforceValue('4', 'four')).toBe(false)
  })
})

describe('the read-back\'s own liveness', () => {
  async function waiting(kv: Kv, ago = 30) {
    await hold(kv, { step: 'patch_prospect_reject', body: REJECT, ago })
  }

  it('alerts when writes are waiting and the read-back has not finished a run for 10 minutes', async () => {
    const r = rig()
    await waiting(r.kv)
    r.kv.store.set(completedKey(SF_READ_BACK_JOB), new Date(T0 - 11 * 60_000).toISOString())
    const res = await checkSalesforceReadBackLiveness({ kv: r.kv, keys: KEY, now: () => T0, slackFor: r.deps.slackFor, sendAlert: r.deps.sendAlert!, alertClaims: makeClaims(), appUrl: 'https://app.test' })
    expect(res.alerted).toBe(true)
    expect(r.alerts).toHaveLength(1)
    expect(r.alerts[0]).toMatchObject({ kind: 'not_running', count: 1, last_finished_at: new Date(T0 - 11 * 60_000).toISOString() })
  })

  it('stays quiet when the read-back finished a run recently', async () => {
    const r = rig()
    await waiting(r.kv)
    r.kv.store.set(completedKey(SF_READ_BACK_JOB), new Date(T0 - 60_000).toISOString())
    const res = await checkSalesforceReadBackLiveness({ kv: r.kv, keys: KEY, now: () => T0, slackFor: r.deps.slackFor, sendAlert: r.deps.sendAlert!, alertClaims: makeClaims(), appUrl: 'https://app.test' })
    expect(res.alerted).toBe(false)
    expect(r.alerts).toEqual([])
  })

  it('stays quiet when nothing is waiting, however long the read-back has been dark', async () => {
    const r = rig()
    const res = await checkSalesforceReadBackLiveness({ kv: r.kv, keys: KEY, now: () => T0, slackFor: r.deps.slackFor, sendAlert: r.deps.sendAlert!, alertClaims: makeClaims(), appUrl: 'https://app.test' })
    expect(res.alerted).toBe(false)
  })

  // A settled write waits only for KV to expire it, and an unstamped one is the
  // held alert's: neither is waiting for the read-back (merge review, #2201).
  it('counts only writes the read-back owns and has not settled', async () => {
    const r = rig()
    r.kv.store.set(completedKey(SF_READ_BACK_JOB), new Date(T0 - 11 * 60_000).toISOString())
    const deps = { kv: r.kv, keys: KEY, now: () => T0, slackFor: r.deps.slackFor, sendAlert: r.deps.sendAlert!, alertClaims: makeClaims(), appUrl: 'https://app.test' }
    await hold(r.kv, { exec: EXEC_B, step: 'patch_prospect_reject', body: REJECT, ago: 30 })
    r.kv.store.set(`sf-read-back:state:${EXEC_B}:patch_prospect_reject`, JSON.stringify({ v: 1, attempts: 2, done: { kind: 'unknown', at: new Date(T0).toISOString(), fields: ['BidStatus__c'] } }))
    await hold(r.kv, { exec: '01a13cf7-0191-7dc3-aada-59ceeacc1618', step: 'patch_prospect_reject', body: REJECT, ago: 30, unstamped: true })
    expect((await checkSalesforceReadBackLiveness(deps)).waiting).toBe(0)
    expect(r.alerts).toEqual([])
    await waiting(r.kv)
    const res = await checkSalesforceReadBackLiveness(deps)
    expect(res).toMatchObject({ waiting: 1, alerted: true })
    expect(r.alerts[0]).toMatchObject({ kind: 'not_running', count: 1 })
  })

  // Settled writes sort first and stay until they expire, so a scan of the first
  // keys alone could be filled by them and miss the write still waiting (#2201 review).
  it('still finds a waiting write behind more settled ones than one page holds', async () => {
    const r = rig()
    r.kv.store.set(completedKey(SF_READ_BACK_JOB), new Date(T0 - 11 * 60_000).toISOString())
    await settledAhead(r.kv, 260)
    await waiting(r.kv)
    const res = await checkSalesforceReadBackLiveness({ kv: r.kv, keys: KEY, now: () => T0, slackFor: r.deps.slackFor, sendAlert: r.deps.sendAlert!, alertClaims: makeClaims(), appUrl: 'https://app.test' })
    expect(res).toMatchObject({ waiting: 1, alerted: true })
  })

  it('gives a read-back that has never finished a run the same grace before it accuses it', async () => {
    const r = rig()
    await waiting(r.kv)
    const deps = { kv: r.kv, keys: KEY, now: () => r.clock.now, slackFor: r.deps.slackFor, sendAlert: r.deps.sendAlert!, alertClaims: makeClaims(), appUrl: 'https://app.test' }
    expect((await checkSalesforceReadBackLiveness(deps)).alerted).toBe(false)
    r.clock.now += 11 * 60_000
    expect((await checkSalesforceReadBackLiveness(deps)).alerted).toBe(true)
    expect(r.alerts[0]).toMatchObject({ kind: 'not_running', last_finished_at: null })
  })
})
