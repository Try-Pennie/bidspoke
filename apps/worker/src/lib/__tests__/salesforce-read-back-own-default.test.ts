/**
 * The read-back resending a timed out reject patch (#2264).
 *
 * Engine Bidding's reject patch starts milliseconds after the run's own
 * prospect_trades Apex update writes other fields of the same Prospect. So the
 * record's LastModifiedDate is always inside the margin, the record is judged
 * written since, and BidStatus__c, still at "No Bid" (its create default, the
 * value the patch exists to replace), was called moved and left out. Twice in
 * production (2026-10-16 and 2026-10-19), replayed here from the fixture.
 *
 * Salesforce is a double that answers the record read, the two field history
 * queries and the PATCH; the history and tracked field list are the real ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { encryptSecret } from '../secret-crypto'
import { atRiskKey, type AtRiskEntry } from '../../engine/at-risk-writes'
import { WRITE_MARKER_FIELD } from '../../engine/write-marker'
import type { SalesforcePort } from '../writeback-replay'
import type { SalesforceReadBackAlert } from '../salesforce-read-back-alert'
import { runSalesforceReadBack, type SalesforceReadBackDeps } from '../salesforce-read-back'
import { readFieldHistory } from '../salesforce-field-conflict'
import { PROSPECT_TRACKED_FIELDS, REJECT_RESEND_RUNS, type RejectResendRun } from './fixtures/reject-patch-resend-2264'

const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 7)).toString('base64')
const ORG = '11111111-1111-1111-1111-111111112264'
const WF = '22222222-2222-2222-2222-222222222264'

/** Salesforce's own spelling of a time: whole seconds, +0000. */
const sfTime = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('Z', '+0000')

interface SfState {
  record: Record<string, unknown>
  history: Array<{ Field: string; CreatedDate: string }>
  tracked: string[]
  /** How the history queries answer. */
  historyMode: 'answers' | 'no answer' | 'refused'
}

function makeSalesforce(id: string, s: SfState) {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
  const port: SalesforcePort = {
    async send(method, path, body) {
      calls.push({ method, path, ...(body ? { body: JSON.parse(body) as Record<string, unknown> } : {}) })
      if (path.startsWith('/query?q=')) {
        if (s.historyMode === 'no answer') throw new Error('Salesforce did not answer')
        if (s.historyMode === 'refused') return { status: 400, text: JSON.stringify([{ errorCode: 'INVALID_FIELD', message: 'No such column' }]) }
        const soql = decodeURIComponent(path.slice('/query?q='.length))
        const asked = [...(soql.match(/IN \(([^)]*)\)/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
        if (/FROM FieldDefinition /.test(soql)) {
          const records = s.tracked.filter((f) => asked.includes(f)).map((f) => ({ QualifiedApiName: f }))
          return { status: 200, text: JSON.stringify({ totalSize: records.length, done: true, records }) }
        }
        const history = soql.match(/FROM (\w+) WHERE ParentId = '(\w+)'/)
        if (history?.[1] === 'Prospect__History' && history[2] === id) {
          const from = Date.parse(soql.match(/CreatedDate >= (\S+)/)![1])
          const records = s.history.filter((h) => asked.includes(h.Field) && Date.parse(h.CreatedDate.replace('+0000', 'Z')) >= from)
          return { status: 200, text: JSON.stringify({ totalSize: records.length, done: true, records }) }
        }
        return { status: 400, text: JSON.stringify([{ errorCode: 'INVALID_TYPE', message: 'not supported' }]) }
      }
      if (path.split('?')[0] !== `/sobjects/Prospect__c/${id}`) return { status: 404, text: '[]' }
      if (method === 'GET') {
        const fields = new URL(`https://x${path}`).searchParams.get('fields')!.split(',')
        return { status: 200, text: JSON.stringify(Object.fromEntries(fields.map((f) => [f, s.record[f] ?? null]))) }
      }
      Object.assign(s.record, JSON.parse(body!))
      return { status: 204, text: '' }
    },
    postApex: () => Promise.reject(new Error('an update was posted to Apex')),
  }
  return { port, calls }
}

async function rigFor(run: RejectResendRun, change?: (s: SfState) => void) {
  const state: SfState = { record: { ...run.readAtResend }, history: [...run.historyAtResend], tracked: [...PROSPECT_TRACKED_FIELDS], historyMode: 'answers' }
  change?.(state)
  const sf = makeSalesforce(run.prospectId, state)
  const store = new Map<string, string>()
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async (o: { prefix: string }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(o.prefix)).sort().map((name) => ({ name })), list_complete: true }),
  }
  const step = 'patch_prospect_reject'
  const entry: AtRiskEntry = {
    v: 1,
    org_id: ORG,
    workflow_id: WF,
    execution_id: run.executionId,
    step_namespace: step,
    sf_object: 'Prospect__c',
    sf_record_id: run.prospectId,
    sf_operation: 'update',
    body_encrypted: await encryptSecret(JSON.stringify(run.patchProspectReject.body), KEY),
    first_attempt_at: run.patchProspectReject.startedAt,
    recorded_at: new Date(Date.parse(run.patchProspectReject.startedAt) + 2000).toISOString(),
  }
  store.set(atRiskKey(run.executionId, step), JSON.stringify(entry))
  const alerts: SalesforceReadBackAlert[] = []
  const deps: SalesforceReadBackDeps = {
    kv,
    keys: KEY,
    portFor: async () => sf.port,
    busy: async () => null,
    resendClaims: { claim: async () => 'claimed' as const, release: async () => {} },
    slackFor: async () => ({ bot_token: 'x', default_channel: '#alerts', config_alerts_enabled: true }),
    sendAlert: async (_slack, payload) => { alerts.push(payload); return true },
    workflowNames: async () => new Map([[WF, 'Engine Bidding Workflow']]),
    appUrl: 'https://app.test',
    now: () => Date.parse(run.resendTickStartedAt),
    callDeadline: () => new Promise<void>(() => {}),
  }
  return { sf, state, alerts, deps, store }
}

const patches = (calls: Array<{ method: string; body?: Record<string, unknown> }>) => calls.filter((c) => c.method === 'PATCH').map((c) => c.body)

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('the fixture is the sequence the issue describes', () => {
  it.each(REJECT_RESEND_RUNS)('$label: created without BidStatus__c, traded, then the patch began inside the margin of the trades write', (run) => {
    expect(run.createProspect.bodyFields).not.toContain('BidStatus__c')
    expect(Date.parse(run.prospectTrades.startedAt)).toBeGreaterThan(Date.parse(run.createProspect.completedAt))
    const gap = Date.parse(run.patchProspectReject.startedAt) - Date.parse(run.prospectTrades.completedAt)
    expect(gap).toBeGreaterThanOrEqual(0)
    expect(gap).toBeLessThan(100)
    expect(run.readAtResend.BidStatus__c).toBe('No Bid')
    expect(PROSPECT_TRACKED_FIELDS).toContain('BidStatus__c')
    expect(PROSPECT_TRACKED_FIELDS).not.toContain('RejectionReason__c')
  })
})

describe('a timed out reject patch, resent after the run\'s own trades update touched the Prospect', () => {
  it.each(REJECT_RESEND_RUNS)('$label: sends BidStatus__c, because its history records no change since the patch began', async (run) => {
    const r = await rigFor(run)
    const s = await runSalesforceReadBack(r.deps)
    expect(patches(r.sf.calls)).toEqual([
      { BidStatus__c: 'Rejected', RejectionReason__c: 'unqualified_lead', [WRITE_MARKER_FIELD]: `${run.executionId}:patch_prospect_reject:1` },
    ])
    expect(r.state.record.BidStatus__c).toBe('Rejected')
    expect(s.conflicts).toBe(0)
    expect(r.alerts).toEqual([])
  })

  it('reads the history from the margin before the patch began, for the field the record read called moved only', async () => {
    const [run] = REJECT_RESEND_RUNS
    const r = await rigFor(run)
    await runSalesforceReadBack(r.deps)
    const queries = r.sf.calls.filter((c) => c.path.startsWith('/query?q=')).map((c) => decodeURIComponent(c.path.slice('/query?q='.length)))
    expect(queries).toEqual([
      "SELECT QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'Prospect__c' AND IsFieldHistoryTracked = true AND QualifiedApiName IN ('BidStatus__c')",
      `SELECT Field, CreatedDate FROM Prospect__History WHERE ParentId = '${run.prospectId}' AND Field IN ('BidStatus__c') AND CreatedDate >= 2026-10-16T12:53:54Z ORDER BY CreatedDate LIMIT 200`,
    ])
  })

  it('reads no history for a record nobody wrote since the write began', async () => {
    const [run] = REJECT_RESEND_RUNS
    const r = await rigFor(run, (s) => { s.record.LastModifiedDate = '2026-10-16T12:53:50.000+0000' })
    await runSalesforceReadBack(r.deps)
    expect(r.sf.calls.filter((c) => c.path.startsWith('/query'))).toEqual([])
    expect(patches(r.sf.calls)[0]).toMatchObject({ BidStatus__c: 'Rejected' })
  })
})

describe('the control: another writer really set BidStatus__c after the patch began', () => {
  it.each(REJECT_RESEND_RUNS)('$label: leaves it out, sends the rest, and the alert names both values and when it changed', async (run) => {
    const changedMs = Date.parse(run.patchProspectReject.startedAt) + 90_000
    const r = await rigFor(run, (s) => {
      s.record.BidStatus__c = 'Won Bid'
      s.record.LastModifiedDate = sfTime(changedMs)
      s.history.push({ Field: 'BidStatus__c', CreatedDate: sfTime(changedMs) })
    })
    const s = await runSalesforceReadBack(r.deps)
    expect(patches(r.sf.calls)).toEqual([{ RejectionReason__c: 'unqualified_lead', [WRITE_MARKER_FIELD]: `${run.executionId}:patch_prospect_reject:1` }])
    expect(r.state.record.BidStatus__c).toBe('Won Bid')
    expect(s.conflicts).toBe(1)
    expect(r.alerts).toHaveLength(1)
    expect(r.alerts[0]).toMatchObject({
      kind: 'conflict',
      writes: [{ conflict_fields: ['BidStatus__c'], resent: true, conflict_values: [{ field: 'BidStatus__c', held: 'Won Bid', sending: 'Rejected', history: 'changed', changed_at: new Date(Math.floor(changedMs / 1000) * 1000).toISOString() }] }],
    })
  })

  it('leaves it out when the recorded change is inside the margin before the patch began, since that may be after it', async () => {
    const [run] = REJECT_RESEND_RUNS
    const r = await rigFor(run, (s) => {
      s.record.BidStatus__c = 'Won Bid'
      s.history.push({ Field: 'BidStatus__c', CreatedDate: '2026-10-16T12:53:55.000+0000' })
    })
    await runSalesforceReadBack(r.deps)
    expect(patches(r.sf.calls)[0]).not.toHaveProperty('BidStatus__c')
  })

  it('sends it when the only recorded change is well before the patch began, which the patch was sent to replace', async () => {
    const [run] = REJECT_RESEND_RUNS
    const r = await rigFor(run, (s) => {
      s.record.BidStatus__c = 'Won Bid'
      s.history.push({ Field: 'BidStatus__c', CreatedDate: '2026-10-16T12:53:51.000+0000' })
    })
    await runSalesforceReadBack(r.deps)
    expect(patches(r.sf.calls)[0]).toMatchObject({ BidStatus__c: 'Rejected' })
  })
})

describe('readFieldHistory, the one history read both resenders use', () => {
  const answer = (body: unknown) => ({ kind: 'answer' as const, status: 200, text: JSON.stringify(body) })
  const SINCE = Date.parse('2026-10-19T13:39:06.360Z')
  const tracked = answer({ totalSize: 1, done: true, records: [{ QualifiedApiName: 'BidStatus__c' }] })

  it('reads Lead history by LeadId, and has none for another standard object', async () => {
    const paths: string[] = []
    await readFieldHistory(async (p) => { paths.push(decodeURIComponent(p)); return paths.length === 1 ? answer({ totalSize: 1, done: true, records: [{ QualifiedApiName: 'Email' }] }) : answer({ totalSize: 0, done: true, records: [] }) }, { sfObject: 'Lead', recordId: '00QUi00000AbCdEIAV', fields: ['Email'], sinceMs: SINCE })
    expect(paths[1]).toContain("FROM LeadHistory WHERE LeadId = '00QUi00000AbCdEIAV'")
    const get = vi.fn()
    expect(await readFieldHistory(get, { sfObject: 'Opportunity', recordId: '006Ui00000AbCdEIAV', fields: ['StageName'], sinceMs: SINCE })).toEqual({ kind: 'not_kept' })
    expect(get).not.toHaveBeenCalled()
  })

  it('takes an incomplete answer, or a row it cannot place, as unread, which clears nothing', async () => {
    const args = { sfObject: 'Prospect__c', recordId: 'a06Ui00002srFqSIAU', fields: ['BidStatus__c'], sinceMs: SINCE }
    const twice = (second: ReturnType<typeof answer>) => { let n = 0; return async () => (n++ === 0 ? tracked : second) }
    expect(await readFieldHistory(twice(answer({ totalSize: 300, done: false, records: [] })), args)).toMatchObject({ kind: 'unread' })
    expect(await readFieldHistory(twice(answer({ totalSize: 300, done: true, records: [] })), args)).toMatchObject({ kind: 'unread' })
    expect(await readFieldHistory(twice(answer({ totalSize: 1, done: true, records: [{ Field: 'BidStatus__c', CreatedDate: 'yesterday' }] })), args)).toMatchObject({ kind: 'unread' })
    expect(await readFieldHistory(twice(answer({ totalSize: 0, done: true, records: [] })), { ...args, sinceMs: Number.NaN })).toMatchObject({ kind: 'unread' })
  })

  it('refuses a name that is not a plain Salesforce name, so nothing else reaches a query', async () => {
    const get = vi.fn()
    expect(await readFieldHistory(get, { sfObject: 'Prospect__c', recordId: "a06' OR Id != '", fields: ['BidStatus__c'], sinceMs: SINCE })).toEqual({ kind: 'not_kept' })
    expect(await readFieldHistory(get, { sfObject: 'Prospect__c', recordId: 'a06Ui00002srFqSIAU', fields: ["BidStatus__c') OR ('x"], sinceMs: SINCE })).toEqual({ kind: 'not_kept' })
    expect(get).not.toHaveBeenCalled()
  })
})

describe('when the history cannot clear the field, it stays left out', () => {
  it('a field Salesforce keeps no history of: left out, and the alert says so', async () => {
    const [run] = REJECT_RESEND_RUNS
    const r = await rigFor(run, (s) => { s.tracked = s.tracked.filter((f) => f !== 'BidStatus__c') })
    await runSalesforceReadBack(r.deps)
    expect(patches(r.sf.calls)[0]).not.toHaveProperty('BidStatus__c')
    // Untracked, so the second query is never made.
    expect(r.sf.calls.filter((c) => c.path.startsWith('/query'))).toHaveLength(1)
    expect(r.alerts[0].writes[0].conflict_values).toEqual([{ field: 'BidStatus__c', held: 'No Bid', sending: 'Rejected', history: 'not_kept' }])
  })

  it('a history query Salesforce refuses: left out, and the alert says the history could not be read', async () => {
    const [run] = REJECT_RESEND_RUNS
    const r = await rigFor(run, (s) => { s.historyMode = 'refused' })
    await runSalesforceReadBack(r.deps)
    expect(patches(r.sf.calls)[0]).not.toHaveProperty('BidStatus__c')
    expect(r.alerts[0].writes[0].conflict_values).toEqual([{ field: 'BidStatus__c', held: 'No Bid', sending: 'Rejected', history: 'unread' }])
  })

  it('a history query with no answer: nothing is sent, nothing is settled, and the tick stops as on any unanswered call', async () => {
    const [run] = REJECT_RESEND_RUNS
    const r = await rigFor(run, (s) => { s.historyMode = 'no answer' })
    const s = await runSalesforceReadBack(r.deps)
    expect(patches(r.sf.calls)).toEqual([])
    expect(s.stopped).toBe('salesforce_not_answering')
    expect(s.unread).toBe(1)
    expect(s.conflicts).toBe(0)
    expect(r.alerts.filter((a) => a.kind === 'conflict')).toEqual([])
    expect([...r.store.keys()].filter((k) => k.startsWith('sf-read-back:state:'))).toEqual([])
  })
})
