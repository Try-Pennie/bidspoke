/**
 * The Salesforce read-back of a credit inquiry post whose outcome is unknown
 * (#2172, Dan's D5 on #1680, 2026-10-15: never resend an inquiry post blind).
 *
 * `POST /services/apexrest/credit-inquiries` attaches a NEW `Inquiries_<leadId>`
 * file to the Lead on every call that carries inquiries, so a blind resend
 * duplicates it. The engine records each post before it goes out (the at-risk
 * record) and clears it on a confirmed answer. This job reads what is left once
 * it is old enough: the Submission's Lead, then whether that Lead holds an
 * Inquiries file created since the post began. Present is landed. Absent is
 * resent ONCE, under a claim that fails closed. An empty list landed by
 * definition (it writes nothing), and a missing list is answered 500 before any
 * write, so neither is ever sent again.
 *
 * Salesforce is a double holding Submissions, Leads' files and the posts it is
 * sent; KV is a map; the clock is a number each test moves (L524).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { encryptSecret } from '../secret-crypto'
import { atRiskKey, startAtRiskWatch, type AtRiskEntry } from '../../engine/at-risk-writes'
import { CREDIT_INQUIRY_APEX_PATH } from '../../engine/inquiry-post'
import type { SalesforcePort } from '../writeback-replay'
import type { AlertClaims, SendClaims } from '../alert-claim'
import type { SalesforceReadBackAlert } from '../salesforce-read-back-alert'
import {
  runSalesforceReadBack,
  checkSalesforceReadBackLiveness,
  SF_READ_BACK_JOB,
  SF_READ_BACK_MIN_AGE_MS,
  UNKNOWN_WINDOW_MS,
  MAX_INQUIRY_RESENDS,
  type SalesforceReadBackDeps,
} from '../salesforce-read-back'
import { completedKey } from '../cron-heartbeat'

const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 91)).toString('base64')
const ORG = '11111111-1111-1111-1111-111111112172'
const WF = '22222222-2222-2222-2222-222222222172'
const T0 = Date.parse('2026-10-15T20:00:00.000Z')
const EXEC = '01a13cf7-0191-7dc3-aada-59ceeacc2172'
const STEP = 'inquiry_apex_send_salesforce'
const SUB = 'a0XUi00000AbCdEFGH'
const LEAD = '00QUi00000XyZaBCDE'
const INQUIRIES = JSON.stringify({ inquiries: [{ type: 'H', customerName: 'BANK' }] })

function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
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

/** The post as the engine's watch recorded it before sending, `ago` minutes before T0. */
async function holdPost(kv: Kv, opts: { body?: Record<string, unknown>; ago?: number; sub?: string } = {}): Promise<string> {
  const sub = opts.sub ?? SUB
  const at = new Date(T0 - (opts.ago ?? 10) * 60_000).toISOString()
  const entry: AtRiskEntry = {
    v: 1,
    org_id: ORG,
    workflow_id: WF,
    execution_id: EXEC,
    step_namespace: STEP,
    sf_object: 'Submission__c',
    sf_record_id: sub,
    sf_operation: 'apex',
    apex_path: CREDIT_INQUIRY_APEX_PATH,
    body_encrypted: await encryptSecret(JSON.stringify(opts.body ?? { submissionId: sub, inquiriesJson: INQUIRIES }), KEY),
    first_attempt_at: at,
    recorded_at: at,
  }
  const key = atRiskKey(EXEC, STEP)
  kv.store.set(key, JSON.stringify(entry))
  return key
}

type PostMode = 'lands' | 'refused' | 'no answer' | 'lands, no answer' | 'server error'

/**
 * Salesforce as the read-back sees it: a Submission with its Lead, the Lead's
 * Inquiries files by creation time, and the credit-inquiries endpoint, which
 * attaches a new file every time it lands.
 */
function makeSalesforce(opts: { lead?: string | null; files?: string[] } = {}) {
  const state = { down: false, post: 'lands' as PostMode, clock: { now: T0 } }
  const submissions: Record<string, { Lead__c: string | null }> = { [SUB]: { Lead__c: opts.lead === undefined ? LEAD : opts.lead } }
  /** Each file's CreatedDate, in ms. */
  const files: number[] = (opts.files ?? []).map((iso) => Date.parse(iso))
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const port: SalesforcePort = {
    async send(method, path, body) {
      calls.push({ method, path, ...(body ? { body: JSON.parse(body) as unknown } : {}) })
      if (state.down) throw new Error('fetch failed: connect ETIMEDOUT')
      if (method === 'GET' && path.startsWith('/sobjects/Submission__c/')) {
        const id = path.split('?')[0].split('/')[3]
        const s = submissions[id]
        if (!s) return { status: 404, text: JSON.stringify([{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]) }
        return { status: 200, text: JSON.stringify({ attributes: { type: 'Submission__c' }, Lead__c: s.Lead__c }) }
      }
      if (method === 'GET' && path.startsWith('/query?q=')) {
        const soql = decodeURIComponent(path.slice('/query?q='.length))
        const m = /LinkedEntityId = '([^']+)' AND ContentDocument\.Title = 'Inquiries_([^']+)' AND ContentDocument\.CreatedDate >= (\S+)$/.exec(soql)
        if (!m || m[1] !== LEAD || m[2] !== LEAD) return { status: 400, text: JSON.stringify([{ errorCode: 'MALFORMED_QUERY', message: soql }]) }
        const since = Date.parse(m[3])
        const rows = files.filter((t) => t >= since).map((_, i) => ({ attributes: { type: 'ContentDocumentLink' }, Id: `06A00000000000${i}` }))
        return { status: 200, text: JSON.stringify({ totalSize: rows.length, done: true, records: rows }) }
      }
      throw new Error(`unexpected ${method} ${path}`)
    },
    async postApex(path, body) {
      calls.push({ method: 'POST', path, body: JSON.parse(body) as unknown })
      if (state.down) throw new Error('fetch failed: connect ETIMEDOUT')
      if (state.post === 'refused') return { status: 404, text: JSON.stringify({ error: 'no connected Lead found', statusCode: '404' }) }
      if (state.post === 'no answer') throw new Error('Salesforce did not answer')
      if (state.post === 'server error') return { status: 500, text: JSON.stringify({ error: 'Error: insert failed', statusCode: '500' }) }
      files.push(state.clock.now)
      if (state.post === 'lands, no answer') throw new Error('Salesforce did not answer')
      return { status: 200, text: JSON.stringify({ message: 'ok', statusCode: '200', leadId: LEAD }) }
    },
  }
  return { port, calls, state, files }
}

function makeClaims(): AlertClaims {
  const held = new Set<string>()
  return {
    async claim(key) { if (held.has(key)) return false; held.add(key); return true },
    async release(key) { held.delete(key) },
  }
}

function makeSendClaims(answer?: 'unanswered'): SendClaims & { asked: string[] } {
  const held = new Set<string>()
  const asked: string[] = []
  return {
    asked,
    claim(key) {
      asked.push(key)
      if (answer) return Promise.resolve(answer)
      if (held.has(key)) return Promise.resolve('taken' as const)
      held.add(key)
      return Promise.resolve('claimed' as const)
    },
    release(key) { held.delete(key); return Promise.resolve() },
  }
}

function rig(sfOpts: Parameters<typeof makeSalesforce>[0] = {}, overrides: Partial<SalesforceReadBackDeps> = {}) {
  const kv = makeKv()
  const sf = makeSalesforce(sfOpts)
  const alerts: SalesforceReadBackAlert[] = []
  const clock = sf.state.clock
  const deps: SalesforceReadBackDeps = {
    kv,
    keys: KEY,
    portFor: async () => sf.port,
    busy: async () => null,
    resendClaims: makeSendClaims(),
    alertClaims: makeClaims(),
    slackFor: async () => ({ bot_token: 'x', default_channel: '#alerts', config_alerts_enabled: true }),
    sendAlert: async (_slack, payload) => { alerts.push(payload); return true },
    workflowNames: async () => new Map([[WF, 'Main Flow']]),
    appUrl: 'https://app.test',
    now: () => clock.now,
    callDeadline: () => new Promise<void>(() => {}),
    ...overrides,
  }
  return { kv, sf, alerts, deps, clock }
}

const posts = (r: ReturnType<typeof rig>) => r.sf.calls.filter((c) => c.method === 'POST')
const held = (r: ReturnType<typeof rig>) => r.kv.store.has(atRiskKey(EXEC, STEP))
/** Ten minutes before T0, in Salesforce's own spelling, whole seconds. */
const POST_STARTED = new Date(T0 - 10 * 60_000).toISOString()

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('a credit inquiry post the read-back finds landed', () => {
  it('cut off, then landed: the Lead holds an Inquiries file from after the post began, so nothing is sent', async () => {
    const r = rig({ files: [new Date(Date.parse(POST_STARTED) + 4_000).toISOString()] })
    await holdPost(r.kv)
    const s = await runSalesforceReadBack(r.deps)
    expect(s.landed).toBe(1)
    expect(posts(r)).toEqual([])
    expect(held(r)).toBe(false)
    expect(r.alerts).toEqual([])
    // The Submission's Lead, then the marker on that Lead.
    expect(r.sf.calls.map((c) => c.path.split('?')[0])).toEqual([`/sobjects/Submission__c/${SUB}`, '/query'])
    expect(r.sf.calls[0].path).toBe(`/sobjects/Submission__c/${SUB}?fields=Lead__c`)
  })

  it('landed late: a file created minutes after the post began, long after its step ended, still counts', async () => {
    const r = rig({ files: [new Date(Date.parse(POST_STARTED) + 150_000).toISOString()] })
    await holdPost(r.kv)
    await runSalesforceReadBack(r.deps)
    expect(posts(r)).toEqual([])
    expect(held(r)).toBe(false)
  })

  it('counts a file stamped up to 2 s before the post began, Salesforce keeping whole seconds on its own clock', async () => {
    const r = rig({ files: [new Date(Date.parse(POST_STARTED) - 1_500).toISOString()] })
    await holdPost(r.kv)
    await runSalesforceReadBack(r.deps)
    expect(posts(r)).toEqual([])
  })

  it('an empty inquiry list reads as landed: it writes nothing and leaves no file, so Salesforce is not even asked', async () => {
    const r = rig()
    await holdPost(r.kv, { body: { submissionId: SUB, inquiriesJson: JSON.stringify({ inquiries: [] }) } })
    const s = await runSalesforceReadBack(r.deps)
    expect(s.landed).toBe(1)
    expect(r.sf.calls).toEqual([])
    expect(held(r)).toBe(false)
    expect(r.alerts).toEqual([])
  })
})

describe('a credit inquiry post that can never write anything', () => {
  it('a missing inquiries list, which Salesforce answers 500 before any write, is never resent and never alerted', async () => {
    const r = rig()
    await holdPost(r.kv, { body: { submissionId: SUB, inquiriesJson: JSON.stringify({}) } })
    const s = await runSalesforceReadBack(r.deps)
    expect(s.nothing_to_send).toBe(1)
    expect(r.sf.calls).toEqual([])
    expect(held(r)).toBe(false)
    expect(r.alerts).toEqual([])
    // And it stays settled: a second tick sends nothing either.
    r.clock.now += 60 * 60_000
    await runSalesforceReadBack(r.deps)
    expect(r.sf.calls).toEqual([])
  })

  it('a body the endpoint cannot read is settled the same way', async () => {
    const r = rig()
    await holdPost(r.kv, { body: { submissionId: SUB, inquiriesJson: 'not json' } })
    const s = await runSalesforceReadBack(r.deps)
    expect(s.nothing_to_send).toBe(1)
    expect(r.sf.calls).toEqual([])
  })
})

describe('a credit inquiry post that did not land', () => {
  it('cut off, then missing: resent once, the held body as sent, and confirmed by its 200', async () => {
    const r = rig({ files: [new Date(Date.parse(POST_STARTED) - 86_400_000).toISOString()] })
    await holdPost(r.kv)
    const s = await runSalesforceReadBack(r.deps)
    expect(s.resent).toBe(1)
    expect(s.resent_confirmed).toBe(1)
    expect(posts(r)).toEqual([{ method: 'POST', path: CREDIT_INQUIRY_APEX_PATH, body: { submissionId: SUB, inquiriesJson: INQUIRIES } }])
    expect(held(r)).toBe(false)
    expect(r.alerts).toEqual([])
  })

  it('a resend with no answer that landed is confirmed by its file on the next read, not sent again', async () => {
    const r = rig()
    r.sf.state.post = 'lands, no answer'
    await holdPost(r.kv)
    await runSalesforceReadBack(r.deps)
    expect(posts(r)).toHaveLength(1)
    expect(held(r)).toBe(true)
    r.clock.now += SF_READ_BACK_MIN_AGE_MS
    const s = await runSalesforceReadBack(r.deps)
    expect(s.landed).toBe(1)
    expect(posts(r)).toHaveLength(1)
    expect(held(r)).toBe(false)
  })

  it('a resend that times out stays unknown, is never sent a second time, and is alerted once past its window', async () => {
    expect(MAX_INQUIRY_RESENDS).toBe(1)
    const r = rig()
    r.sf.state.post = 'no answer'
    await holdPost(r.kv, { ago: 5 })
    await runSalesforceReadBack(r.deps)
    expect(posts(r)).toHaveLength(1)
    expect(r.alerts).toEqual([])
    // Read again once old enough: still no file, and no resend left.
    r.clock.now = T0 - 5 * 60_000 + UNKNOWN_WINDOW_MS
    await runSalesforceReadBack(r.deps)
    expect(posts(r)).toHaveLength(1)
    expect(r.alerts.map((a) => a.kind)).toEqual(['unknown'])
    expect(r.alerts[0].writes[0]).toMatchObject({ inquiry_post: true, sf_object: 'Submission__c', sf_record_id: SUB, resends: 1, still_trying: false, fields: [] })
    // Settled: later ticks neither send nor alert again.
    r.clock.now += 60 * 60_000
    await runSalesforceReadBack(r.deps)
    expect(posts(r)).toHaveLength(1)
    expect(r.alerts).toHaveLength(1)
  })

  it('a 500 to the resend does not stop the tick, and is read back like no answer', async () => {
    const r = rig()
    r.sf.state.post = 'server error'
    await holdPost(r.kv)
    const s = await runSalesforceReadBack(r.deps)
    expect(s.resend_unanswered).toBe(1)
    expect(s.stopped).toBeUndefined()
    expect(held(r)).toBe(true)
  })

  it('a refused resend is alerted as could not be resent, and never tried again', async () => {
    const r = rig()
    r.sf.state.post = 'refused'
    await holdPost(r.kv)
    const s = await runSalesforceReadBack(r.deps)
    expect(s.resend_refused).toBe(1)
    expect(r.alerts.map((a) => a.kind)).toEqual(['resend_failed'])
    expect(r.alerts[0].writes[0]).toMatchObject({ inquiry_post: true, resent: true, detail: 'Salesforce answered 404' })
    r.clock.now += 60 * 60_000
    await runSalesforceReadBack(r.deps)
    expect(posts(r)).toHaveLength(1)
  })

  it('a Submission with no Lead is not resent, since Salesforce refuses the post, and is said', async () => {
    const r = rig({ lead: null })
    await holdPost(r.kv)
    await runSalesforceReadBack(r.deps)
    expect(posts(r)).toEqual([])
    expect(r.alerts.map((a) => a.kind)).toEqual(['resend_failed'])
    expect(r.alerts[0].writes[0]).toMatchObject({ inquiry_post: true, resent: false, detail: expect.stringMatching(/no Lead/) })
  })

  it('is alerted apart from an update settled the same way, so each alert is worded for what it names', async () => {
    const r = rig()
    r.sf.state.post = 'refused'
    await holdPost(r.kv)
    // An update the read-back settled as refused earlier, whose alert has not reached Slack yet.
    const updateExec = '01a13cf7-0191-7dc3-aada-59ceeacc2173'
    const entry = JSON.parse(r.kv.store.get(atRiskKey(EXEC, STEP))!) as AtRiskEntry
    r.kv.store.set(atRiskKey(updateExec, 'patch_prospect_reject'), JSON.stringify({ ...entry, execution_id: updateExec, step_namespace: 'patch_prospect_reject', sf_object: 'Prospect__c', sf_record_id: 'a06Ui00002sLkNuIAK', sf_operation: 'update', apex_path: undefined }))
    r.kv.store.set(`sf-read-back:state:${updateExec}:patch_prospect_reject`, JSON.stringify({ v: 1, attempts: 1, done: { kind: 'resend_failed', at: new Date(T0).toISOString(), fields: ['BidStatus__c'], detail: 'Salesforce answered 400' } }))
    await runSalesforceReadBack(r.deps)
    expect(r.alerts.map((a) => [a.kind, a.writes.length, a.writes[0].inquiry_post ?? false]).sort()).toEqual([
      ['resend_failed', 1, false],
      ['resend_failed', 1, true],
    ])
  })

  it('a Lead id that is not a record id never reaches the marker query, and the post is not resent', async () => {
    const r = rig({ lead: '' })
    await holdPost(r.kv)
    await runSalesforceReadBack(r.deps)
    expect(r.sf.calls.map((c) => c.path.split('?')[0])).toEqual([`/sobjects/Submission__c/${SUB}`])
    expect(r.alerts.map((a) => a.kind)).toEqual(['resend_failed'])
  })

  it('a Submission that no longer exists is not resent, and is said', async () => {
    const r = rig()
    await holdPost(r.kv, { sub: 'a0XUi00000ZZZZZZZZ' })
    await runSalesforceReadBack(r.deps)
    expect(posts(r)).toEqual([])
    expect(r.alerts.map((a) => a.kind)).toEqual(['resend_failed'])
  })
})

describe('a post recorded by the engine\'s own watch, not a fixture', () => {
  it('is read back and resent once, so the record the watch writes is the one this job reads', async () => {
    const r = rig()
    const startedAt = T0 - 10 * 60_000
    const watch = startAtRiskWatch({ kv: r.kv, keys: KEY, clock: { now: () => startedAt, sleep: () => Promise.resolve(), timer: () => new Promise<void>(() => {}) }, run: { orgId: ORG, workflowId: WF, executionId: EXEC }, stepNamespace: STEP })
    await watch.recordNow({ object: 'Submission__c', record_id: SUB, operation: 'apex', apex_path: CREDIT_INQUIRY_APEX_PATH, body: { submissionId: SUB, inquiriesJson: INQUIRIES } })
    await watch.settle('unknown')
    const s = await runSalesforceReadBack(r.deps)
    expect(s.resent_confirmed).toBe(1)
    expect(posts(r)).toEqual([{ method: 'POST', path: CREDIT_INQUIRY_APEX_PATH, body: { submissionId: SUB, inquiriesJson: INQUIRIES } }])
  })
})

describe('the resend claim', () => {
  it('a claim with no answer sends nothing and spends no attempt, since it fails closed', async () => {
    const claims = makeSendClaims('unanswered')
    const r = rig({}, { resendClaims: claims })
    await holdPost(r.kv)
    const s = await runSalesforceReadBack(r.deps)
    expect(claims.asked).toEqual([`sf-read-back-resend:${EXEC}:${STEP}:1`])
    expect(s.deferred).toBe(1)
    expect(posts(r)).toEqual([])
    // Once the claim answers, its one resend is still there.
    r.deps.resendClaims = makeSendClaims()
    r.clock.now += 60_000
    await runSalesforceReadBack(r.deps)
    expect(posts(r)).toHaveLength(1)
  })

  it('two overlapping ticks send one resend between them', async () => {
    const r = rig()
    await holdPost(r.kv)
    await Promise.all([runSalesforceReadBack(r.deps), runSalesforceReadBack(r.deps)])
    expect(posts(r)).toHaveLength(1)
  })
})

describe('when it is read', () => {
  it('not before the minimum age, counted from when the post began', async () => {
    const r = rig()
    await holdPost(r.kv, { ago: 2 })
    const s = await runSalesforceReadBack(r.deps)
    expect(s.young).toBe(1)
    expect(r.sf.calls).toEqual([])
  })

  it('not while Salesforce does not answer: nothing is sent, and the unread alert comes once it has waited too long', async () => {
    const r = rig()
    r.sf.state.down = true
    await holdPost(r.kv, { ago: 20 })
    const s = await runSalesforceReadBack(r.deps)
    expect(s.stopped).toBe('salesforce_not_answering')
    expect(posts(r)).toEqual([])
    expect(r.alerts).toMatchObject([{ kind: 'unread', count: 1, inquiry_posts: 1 }])
  })
})

describe('the read-back\'s own liveness counts a waiting credit inquiry post', () => {
  it('alerts when one is waiting and the read-back has not finished a run for 10 minutes', async () => {
    const r = rig()
    await holdPost(r.kv, { ago: 30 })
    r.kv.store.set(completedKey(SF_READ_BACK_JOB), new Date(T0 - 11 * 60_000).toISOString())
    const res = await checkSalesforceReadBackLiveness({ kv: r.kv, keys: KEY, now: () => T0, slackFor: r.deps.slackFor, sendAlert: r.deps.sendAlert!, alertClaims: makeClaims(), appUrl: 'https://app.test' })
    expect(res.alerted).toBe(true)
    expect(r.alerts).toMatchObject([{ kind: 'not_running', count: 1, inquiry_posts: 1 }])
  })

  it('stays quiet when the read-back finished a run recently', async () => {
    const r = rig()
    await holdPost(r.kv, { ago: 30 })
    r.kv.store.set(completedKey(SF_READ_BACK_JOB), new Date(T0 - 60_000).toISOString())
    const res = await checkSalesforceReadBackLiveness({ kv: r.kv, keys: KEY, now: () => T0, slackFor: r.deps.slackFor, sendAlert: r.deps.sendAlert!, alertClaims: makeClaims(), appUrl: 'https://app.test' })
    expect(res.alerted).toBe(false)
  })
})
