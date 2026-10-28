/**
 * An untracked checkbox still at its create default (#2492).
 *
 * On 2026-10-28 Engine Bidding's bid patch timed out milliseconds after the
 * run's own prospect_trades Apex update wrote the same Prospect, so the resend
 * found the record written since and judged each field on its own.
 * Collections_Bid_Discount__c held false, its Checkbox default from when the
 * record was created, which nothing had ever written; the patch sent true.
 * false is not blank and differs from true, and Salesforce keeps no history of
 * the field to clear it, so it was left out and paged as a conflict.
 *
 * Salesforce cannot store a blank checkbox: false is how it holds "never set".
 * So an untracked Checkbox holding false reads as blank, and a resend may set
 * it, in both resenders. A tracked checkbox still answers through its history.
 *
 * Replayed from the run (fixtures/untracked-checkbox-resend-2492.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { encryptSecret } from '../secret-crypto'
import { atRiskKey, type AtRiskEntry } from '../../engine/at-risk-writes'
import { WRITE_MARKER_FIELD } from '../../engine/write-marker'
import { drainHeldWrite, type HeldWriteRow, type HeldWriteStore, type SalesforcePort } from '../writeback-replay'
import type { SalesforceReadBackAlert } from '../salesforce-read-back-alert'
import { runSalesforceReadBack, type SalesforceReadBackDeps } from '../salesforce-read-back'
import { fieldsMovedSince, readFieldHistory, type HistoryGet } from '../salesforce-field-conflict'
import { BID_PATCH_FIELDS, UNTRACKED_CHECKBOX_RUN as RUN } from './fixtures/untracked-checkbox-resend-2492'

const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 13)).toString('base64')
const ORG = '11111111-1111-1111-1111-111111112492'
const STEP = 'patch_prospect'
const SINCE_MS = Date.parse(RUN.patchProspect.startedAt)

type Defs = Record<string, { type: string; tracked: boolean }>
type HistoryRow = { Field: string; CreatedDate: string }

/** Answers the record read, the two field history queries and the PATCH for one Prospect. */
function makeSalesforce(record: Record<string, unknown>, history: HistoryRow[], defs: Defs = BID_PATCH_FIELDS) {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
  const port: SalesforcePort = {
    async send(method, path, body) {
      calls.push({ method, path, ...(body ? { body: JSON.parse(body) as Record<string, unknown> } : {}) })
      if (path.startsWith('/query?q=')) {
        const soql = decodeURIComponent(path.slice('/query?q='.length))
        const asked = [...(soql.match(/IN \(([^)]*)\)/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
        const records = /FROM FieldDefinition /.test(soql)
          ? asked.map((f) => ({ QualifiedApiName: f, DataType: defs[f]?.type ?? 'Text(255)', IsFieldHistoryTracked: defs[f]?.tracked === true }))
          : history.filter((h) => asked.includes(h.Field))
        return { status: 200, text: JSON.stringify({ totalSize: records.length, done: true, records }) }
      }
      if (path.split('?')[0] !== `/sobjects/Prospect__c/${RUN.prospectId}`) return { status: 404, text: '[]' }
      if (method === 'GET') {
        const fields = new URL(`https://x${path}`).searchParams.get('fields')!.split(',')
        return { status: 200, text: JSON.stringify(Object.fromEntries(fields.map((f) => [f, record[f] ?? null]))) }
      }
      Object.assign(record, JSON.parse(body!))
      return { status: 204, text: '' }
    },
    postApex: () => Promise.reject(new Error('an update was posted to Apex')),
  }
  return { port, calls }
}

const patches = (calls: Array<{ method: string; body?: Record<string, unknown> }>) => calls.filter((c) => c.method === 'PATCH').map((c) => c.body)
const withoutMarker = Object.fromEntries(Object.entries(RUN.patchProspect.body).filter(([f]) => f !== WRITE_MARKER_FIELD))

async function readBackRig(record: Record<string, unknown>) {
  const sf = makeSalesforce(record, [...RUN.historyAtResend])
  const store = new Map<string, string>()
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async (o: { prefix: string }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(o.prefix)).sort().map((name) => ({ name })), list_complete: true }),
  }
  const entry: AtRiskEntry = {
    v: 1,
    org_id: ORG,
    workflow_id: RUN.workflowId,
    execution_id: RUN.executionId,
    step_namespace: STEP,
    sf_object: 'Prospect__c',
    sf_record_id: RUN.prospectId,
    sf_operation: 'update',
    body_encrypted: await encryptSecret(JSON.stringify(RUN.patchProspect.body), KEY),
    first_attempt_at: RUN.patchProspect.startedAt,
    recorded_at: new Date(SINCE_MS + 2000).toISOString(),
  }
  store.set(atRiskKey(RUN.executionId, STEP), JSON.stringify(entry))
  const alerts: SalesforceReadBackAlert[] = []
  const deps: SalesforceReadBackDeps = {
    kv,
    keys: KEY,
    portFor: async () => sf.port,
    busy: async () => null,
    resendClaims: { claim: async () => 'claimed' as const, release: async () => {} },
    slackFor: async () => ({ bot_token: 'x', default_channel: '#alerts', config_alerts_enabled: true }),
    sendAlert: async (_slack, payload) => { alerts.push(payload); return true },
    workflowNames: async () => new Map([[RUN.workflowId, 'Engine Bidding Workflow']]),
    appUrl: 'https://app.test',
    now: () => Date.parse(RUN.resendTickStartedAt),
    callDeadline: () => new Promise<void>(() => {}),
  }
  return { sf, alerts, deps }
}

async function storedRow(): Promise<HeldWriteRow> {
  return {
    id: '33333333-3333-3333-3333-333333332492',
    organization_id: ORG,
    workflow_id: RUN.workflowId,
    execution_id: RUN.executionId,
    step_namespace: STEP,
    sf_object: 'Prospect__c',
    sf_record_id: RUN.prospectId,
    sf_operation: 'update',
    body_encrypted: await encryptSecret(JSON.stringify(RUN.patchProspect.body), KEY),
    error_encrypted: await encryptSecret('Salesforce API error (503): unavailable', KEY),
    error_type: 'transient',
    replayable: true,
    status: 'pending',
    attempts: 0,
    last_error_encrypted: null,
    created_at: RUN.patchProspect.startedAt,
    updated_at: RUN.patchProspect.startedAt,
    finished_at: null,
  }
}

function memoryStore(rows: HeldWriteRow[]): HeldWriteStore {
  return {
    get: async (orgId, id) => rows.find((r) => r.id === id && r.organization_id === orgId) ?? null,
    async claim(orgId, id, attempts) {
      const r = rows.find((x) => x.id === id && x.organization_id === orgId && x.status === 'pending' && x.attempts === attempts)
      if (!r) return false
      r.attempts = attempts + 1
      return true
    },
    async finish(id, attempts, patch) {
      const r = rows.find((x) => x.id === id && x.attempts === attempts && x.status === 'pending')
      if (!r) return false
      Object.assign(r, patch)
      return true
    },
    list: async () => rows,
  }
}

/** The moved field rule over one checkbox, with the field history read through a Salesforce double. */
async function judge(args: { defs: Defs; current: Record<string, unknown>; body: Record<string, unknown>; history?: HistoryRow[]; definitions?: 'answers' | 'refused'; changes?: 'answers' | 'refused' }) {
  const fields = Object.keys(args.body)
  const get: HistoryGet = async (path) => {
    const soql = decodeURIComponent(path.slice('/query?q='.length))
    const asked = [...(soql.match(/IN \(([^)]*)\)/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    if (/FROM FieldDefinition /.test(soql)) {
      if (args.definitions === 'refused') return { kind: 'answer', status: 500, text: '[]' }
      const records = asked.map((f) => ({ QualifiedApiName: f, DataType: args.defs[f].type, IsFieldHistoryTracked: args.defs[f].tracked }))
      return { kind: 'answer', status: 200, text: JSON.stringify({ totalSize: records.length, done: true, records }) }
    }
    if (args.changes === 'refused') return { kind: 'answer', status: 500, text: '[]' }
    const records = (args.history ?? []).filter((h) => asked.includes(h.Field))
    return { kind: 'answer', status: 200, text: JSON.stringify({ totalSize: records.length, done: true, records }) }
  }
  const current = { LastModifiedDate: RUN.readAtResend.LastModifiedDate, ...args.current }
  const firstPass = fieldsMovedSince({ fields, body: args.body, current, sinceMs: SINCE_MS, earlier: [] })
  const history = await readFieldHistory(get, { sfObject: 'Prospect__c', recordId: RUN.prospectId, fields: firstPass, sinceMs: SINCE_MS })
  if (history.kind === 'no_answer') throw new Error('the double always answers')
  return fieldsMovedSince({ fields, body: args.body, current, sinceMs: SINCE_MS, earlier: [], history })
}

const CHECKBOX = 'Collections_Bid_Discount__c'
const untracked: Defs = { [CHECKBOX]: { type: 'Checkbox', tracked: false } }
const tracked: Defs = { [CHECKBOX]: { type: 'Checkbox', tracked: true } }

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('the fixture is the sequence the alert came from', () => {
  it('the patch began inside the margin of the run\'s own trades write, with the checkbox untracked and at false', () => {
    const gap = SINCE_MS - Date.parse(RUN.prospectTrades.completedAt)
    expect(gap).toBeGreaterThanOrEqual(0)
    expect(gap).toBeLessThan(100)
    expect(BID_PATCH_FIELDS[CHECKBOX]).toEqual({ type: 'Checkbox', tracked: false })
    expect(RUN.readAtResend[CHECKBOX]).toBe(false)
    expect(RUN.patchProspect.body[CHECKBOX]).toBe(true)
    // Without the history the record read alone calls both fields still at their create values moved.
    expect(fieldsMovedSince({ fields: Object.keys(withoutMarker), body: RUN.patchProspect.body, current: RUN.readAtResend, sinceMs: SINCE_MS, earlier: [] })).toEqual(['BidStatus__c', CHECKBOX])
  })
})

describe('the read-back resending the 2026-10-28 bid patch', () => {
  it('sends the untracked checkbox still at its default false, and alerts nothing', async () => {
    const record = { ...RUN.readAtResend }
    const r = await readBackRig(record)
    const s = await runSalesforceReadBack(r.deps)
    expect(patches(r.sf.calls)).toEqual([{ ...withoutMarker, [WRITE_MARKER_FIELD]: `${RUN.executionId}:${STEP}:1` }])
    expect(record[CHECKBOX]).toBe(true)
    expect(s).toMatchObject({ resent: 1, conflicts: 0, history_cleared: 2 })
    expect(r.alerts).toEqual([])
  })
})

describe('the drain resending the same patch from a stored row', () => {
  it('sends the untracked checkbox still at its default false', async () => {
    const rows = [await storedRow()]
    const record = { ...RUN.readAtResend }
    const sf = makeSalesforce(record, [...RUN.historyAtResend])
    const r = await drainHeldWrite({ store: memoryStore(rows), salesforce: async () => sf.port, keys: KEY, readBackHolds: async () => false }, ORG, rows[0].id, { maxAttempts: 2 })
    expect(r).toMatchObject({ kind: 'replayed', moved: [] })
    expect(patches(sf.calls)).toEqual([RUN.patchProspect.body])
    expect(record[CHECKBOX]).toBe(true)
  })
})

describe('which checkboxes stay a conflict', () => {
  it('an untracked checkbox at false, sent true: sent (the 2026-10-28 case)', async () => {
    expect(await judge({ defs: untracked, current: { [CHECKBOX]: false }, body: { [CHECKBOX]: true } })).toEqual([])
  })

  it('reads false however Salesforce spells it', async () => {
    expect(await judge({ defs: untracked, current: { [CHECKBOX]: 'false' }, body: { [CHECKBOX]: true } })).toEqual([])
  })

  it('a tracked checkbox whose history shows another writer set false after the write began: left out', async () => {
    const at = new Date(Math.floor((SINCE_MS + 60_000) / 1000) * 1000).toISOString().replace('Z', '+0000')
    expect(await judge({ defs: tracked, current: { [CHECKBOX]: false }, body: { [CHECKBOX]: true }, history: [{ Field: CHECKBOX, CreatedDate: at }] })).toEqual([CHECKBOX])
  })

  it('a tracked checkbox whose history cannot be read: left out, since false may be a deliberate uncheck', async () => {
    expect(await judge({ defs: tracked, current: { [CHECKBOX]: false }, body: { [CHECKBOX]: true }, changes: 'refused' })).toEqual([CHECKBOX])
  })

  it('a tracked checkbox with no change recorded since the write began: sent through its history, as before', async () => {
    expect(await judge({ defs: tracked, current: { [CHECKBOX]: false }, body: { [CHECKBOX]: true } })).toEqual([])
  })

  it('an untracked checkbox at true, sent false: left out, since true is something somebody set', async () => {
    expect(await judge({ defs: untracked, current: { [CHECKBOX]: true }, body: { [CHECKBOX]: false } })).toEqual([CHECKBOX])
  })

  it('an untracked field of another type holding a different value: left out, as before, even when it reads "false"', async () => {
    const text: Defs = { Note__c: { type: 'Text(255)', tracked: false } }
    expect(await judge({ defs: text, current: { Note__c: 'false' }, body: { Note__c: 'true' } })).toEqual(['Note__c'])
    expect(await judge({ defs: text, current: { Note__c: 'other' }, body: { Note__c: 'sent' } })).toEqual(['Note__c'])
  })

  it('a checkbox whose field definitions cannot be read: left out, since its type and tracking are unknown', async () => {
    expect(await judge({ defs: untracked, current: { [CHECKBOX]: false }, body: { [CHECKBOX]: true }, definitions: 'refused' })).toEqual([CHECKBOX])
  })

  it('an untracked checkbox at false whose definitions were read but whose neighbours\' history query failed: sent, since it has no history to wait for', async () => {
    const defs: Defs = { ...untracked, BidStatus__c: { type: 'Picklist', tracked: true } }
    expect(await judge({ defs, current: { [CHECKBOX]: false, BidStatus__c: 'No Bid' }, body: { [CHECKBOX]: true, BidStatus__c: 'Bid' }, changes: 'refused' })).toEqual(['BidStatus__c'])
  })

  it('with no history read at all (the first pass), the checkbox is still called moved, so the history is asked', () => {
    const current = { LastModifiedDate: RUN.readAtResend.LastModifiedDate, [CHECKBOX]: false }
    expect(fieldsMovedSince({ fields: [CHECKBOX], body: { [CHECKBOX]: true }, current, sinceMs: SINCE_MS, earlier: [] })).toEqual([CHECKBOX])
  })
})
