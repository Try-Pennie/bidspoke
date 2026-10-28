/**
 * A field that moved on to a later state of the value being sent (#2895).
 *
 * On 2026-10-27 Engine Bidding's bid patch (BidStatus__c "Bid") timed out, and
 * 11 seconds later the person clicked the offer and converted, so another
 * integration set BidStatus__c to "Converted". The read-back rightly left the
 * field out of its resend, then alerted it as a conflict asking a person to
 * choose between "Converted" and "Bid". Converted is where every offered
 * Prospect goes once the person applies, so it is never a choice: setting it
 * back undoes a conversion. Both resenders (the read-back and the drain of
 * stored writes) still leave such a field out, but say nothing about it.
 *
 * Replayed from the run (fixtures/converted-during-bid-patch-2895.ts); the
 * history and tracked field list are the real ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { encryptSecret } from '../secret-crypto'
import { atRiskKey, type AtRiskEntry } from '../../engine/at-risk-writes'
import { WRITE_MARKER_FIELD } from '../../engine/write-marker'
import type { HeldWriteRow, HeldWriteStore, SalesforcePort } from '../writeback-replay'
import { drainHeldWrite } from '../writeback-replay'
import type { SalesforceReadBackAlert } from '../salesforce-read-back-alert'
import { runSalesforceReadBack, type SalesforceReadBackDeps } from '../salesforce-read-back'
import { LATER_STATES, laterStateFields } from '../salesforce-field-conflict'
import { runWritebackDrain, type DrainKv, type DrainRow } from '../writeback-drain'
import type { WritebackDrainAlert } from '../slack'
import { PROSPECT_FIELD_TYPES, PROSPECT_TRACKED_FIELDS } from './fixtures/reject-patch-resend-2264'
import { CONVERTED_RUN as RUN } from './fixtures/converted-during-bid-patch-2895'

const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 11)).toString('base64')
const ORG = '11111111-1111-1111-1111-111111112895'
const WF = '22222222-2222-2222-2222-222222222895'
const STEP = 'patch_prospect'

/** Answers the record read, the two field history queries and the PATCH for one Prospect. */
function makeSalesforce(record: Record<string, unknown>, history: Array<{ Field: string; CreatedDate: string }>) {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
  const port: SalesforcePort = {
    async send(method, path, body) {
      calls.push({ method, path, ...(body ? { body: JSON.parse(body) as Record<string, unknown> } : {}) })
      if (path.startsWith('/query?q=')) {
        const soql = decodeURIComponent(path.slice('/query?q='.length))
        const asked = [...(soql.match(/IN \(([^)]*)\)/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
        const records = /FROM FieldDefinition /.test(soql)
          ? asked.map((f) => ({ QualifiedApiName: f, DataType: PROSPECT_FIELD_TYPES[f] ?? 'Text(255)', IsFieldHistoryTracked: PROSPECT_TRACKED_FIELDS.includes(f) }))
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
const withoutBidStatus = Object.fromEntries(Object.entries(RUN.patchProspect.body).filter(([f]) => f !== 'BidStatus__c'))

async function readBackRig(body: Record<string, unknown>, record: Record<string, unknown>) {
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
    workflow_id: WF,
    execution_id: RUN.executionId,
    step_namespace: STEP,
    sf_object: 'Prospect__c',
    sf_record_id: RUN.prospectId,
    sf_operation: 'update',
    body_encrypted: await encryptSecret(JSON.stringify(body), KEY),
    first_attempt_at: RUN.patchProspect.startedAt,
    recorded_at: new Date(Date.parse(RUN.patchProspect.startedAt) + 2000).toISOString(),
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
    workflowNames: async () => new Map([[WF, 'Engine Bidding Workflow']]),
    appUrl: 'https://app.test',
    now: () => Date.parse(RUN.resendTickStartedAt),
    callDeadline: () => new Promise<void>(() => {}),
  }
  return { sf, alerts, deps, store }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('the later state rule', () => {
  it('names Converted as the later state of a Prospect\'s Bid, and nothing else', () => {
    expect(LATER_STATES).toEqual([{ sfObject: 'Prospect__c', field: 'BidStatus__c', from: 'Bid', later: ['Converted'] }])
  })

  it('picks out only the fields holding a later state of what was being sent', () => {
    const body = { BidStatus__c: 'Bid', Status__c: 'Open' }
    expect(laterStateFields({ sfObject: 'Prospect__c', fields: ['BidStatus__c', 'Status__c'], body, current: { BidStatus__c: 'Converted', Status__c: 'Closed' } })).toEqual(['BidStatus__c'])
    // Another value held, another value sent, or another object: still a conflict.
    expect(laterStateFields({ sfObject: 'Prospect__c', fields: ['BidStatus__c'], body, current: { BidStatus__c: 'Rejected' } })).toEqual([])
    expect(laterStateFields({ sfObject: 'Prospect__c', fields: ['BidStatus__c'], body: { BidStatus__c: 'Rejected' }, current: { BidStatus__c: 'Converted' } })).toEqual([])
    expect(laterStateFields({ sfObject: 'Applicant__c', fields: ['BidStatus__c'], body, current: { BidStatus__c: 'Converted' } })).toEqual([])
  })
})

describe('the read-back resending the 2026-10-27 bid patch after the person converted', () => {
  it('sends everything but BidStatus__c, leaves Converted in place, and alerts nothing', async () => {
    const record = { ...RUN.readAtResend }
    const r = await readBackRig(RUN.patchProspect.body, record)
    const s = await runSalesforceReadBack(r.deps)
    expect(patches(r.sf.calls)).toEqual([{ ...withoutBidStatus, [WRITE_MARKER_FIELD]: `${RUN.executionId}:${STEP}:1` }])
    expect(record.BidStatus__c).toBe('Converted')
    expect(r.alerts).toEqual([])
    expect(s).toMatchObject({ resent: 1, resent_confirmed: 1, conflicts: 0, later_states: 1 })
    // A later state is not a clash, so it does not count against the field's conflict rate.
    expect(s.conflict_fields['Prospect__c.BidStatus__c']).toEqual({ conflicts: 0, candidates: 1 })
    // Settled: neither the held write nor its state is left to read again.
    expect([...r.store.keys()].filter((k) => k.includes(RUN.executionId))).toEqual([])
  })

  it('settles a write whose only field is at its later state without sending or alerting', async () => {
    const record = { ...RUN.readAtResend }
    const r = await readBackRig({ BidStatus__c: 'Bid', [WRITE_MARKER_FIELD]: RUN.patchProspect.body[WRITE_MARKER_FIELD] }, record)
    const s = await runSalesforceReadBack(r.deps)
    expect(patches(r.sf.calls)).toEqual([])
    expect(r.alerts).toEqual([])
    expect(s).toMatchObject({ resent: 0, conflicts: 0, later_states: 1 })
    expect([...r.store.keys()].filter((k) => k.includes(RUN.executionId))).toEqual([])
  })

  it('never puts Converted back to Bid, even on a record nobody wrote since the patch began', async () => {
    // Untouched since the write began, the moved field rule would send every field.
    const record: Record<string, unknown> = { ...RUN.readAtResend, LastModifiedDate: '2026-10-27T17:18:00.000+0000' }
    const r = await readBackRig(RUN.patchProspect.body, record)
    await runSalesforceReadBack(r.deps)
    expect(patches(r.sf.calls)[0]).not.toHaveProperty('BidStatus__c')
    expect(record.BidStatus__c).toBe('Converted')
    expect(r.alerts).toEqual([])
  })

  it('the control: a value that is not a later state of Bid is still alerted as a conflict', async () => {
    const record = { ...RUN.readAtResend, BidStatus__c: 'Rejected' }
    const r = await readBackRig(RUN.patchProspect.body, record)
    const s = await runSalesforceReadBack(r.deps)
    expect(patches(r.sf.calls)[0]).not.toHaveProperty('BidStatus__c')
    expect(s).toMatchObject({ conflicts: 1, later_states: 0 })
    expect(r.alerts).toHaveLength(1)
    expect(r.alerts[0]).toMatchObject({ kind: 'conflict', writes: [{ conflict_fields: ['BidStatus__c'], conflict_values: [{ field: 'BidStatus__c', held: 'Rejected', sending: 'Bid' }] }] })
  })
})

describe('the drain resending the same patch from a stored row', () => {
  async function storedRow(body: Record<string, unknown>): Promise<HeldWriteRow> {
    return {
      id: '33333333-3333-3333-3333-333333332895',
      organization_id: ORG,
      workflow_id: WF,
      execution_id: RUN.executionId,
      step_namespace: STEP,
      sf_object: 'Prospect__c',
      sf_record_id: RUN.prospectId,
      sf_operation: 'update',
      body_encrypted: await encryptSecret(JSON.stringify(body), KEY),
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
  const replayDeps = (rows: HeldWriteRow[], port: SalesforcePort) => ({ store: memoryStore(rows), salesforce: async () => port, keys: KEY, readBackHolds: async () => false })

  it('sends everything but BidStatus__c and reports it as a later state, not as moved', async () => {
    const rows = [await storedRow(RUN.patchProspect.body)]
    const sf = makeSalesforce({ ...RUN.readAtResend }, [...RUN.historyAtResend])
    const r = await drainHeldWrite(replayDeps(rows, sf.port), ORG, rows[0].id, { maxAttempts: 2 })
    expect(r).toMatchObject({ kind: 'replayed', moved: [], later: ['BidStatus__c'] })
    expect(patches(sf.calls)).toEqual([withoutBidStatus])
  })

  it('closes a row whose only field is at its later state, sending nothing, and the drain alerts nothing', async () => {
    const rows = [await storedRow({ BidStatus__c: 'Bid', [WRITE_MARKER_FIELD]: RUN.patchProspect.body[WRITE_MARKER_FIELD] })]
    const sf = makeSalesforce({ ...RUN.readAtResend }, [...RUN.historyAtResend])
    const data = new Map<string, string>()
    const kv: DrainKv = {
      get: async (k) => data.get(k) ?? null,
      put: async (k, v) => { data.set(k, v) },
      delete: async (k) => { data.delete(k) },
      list: async ({ prefix }) => ({ keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
    }
    const alerts: WritebackDrainAlert[] = []
    const s = await runWritebackDrain({
      list: async (): Promise<DrainRow[]> => rows.filter((r) => r.status === 'pending').map((r) => ({ ...r })),
      store: memoryStore(rows),
      keys: KEY,
      salesforceFor: async () => sf.port,
      readBackHolds: async () => false,
      busy: async () => null,
      kv,
      slackFor: async () => ({ bot_token: 'xoxb', default_channel: 'C1', config_alerts_enabled: true }),
      sendAlert: async (_slack, alert) => { alerts.push(alert); return true },
      now: () => Date.parse(RUN.resendTickStartedAt),
      callDeadline: () => new Promise((resolve) => setTimeout(resolve, 0)),
    })
    expect(patches(sf.calls)).toEqual([])
    expect(rows[0].status).toBe('abandoned')
    expect(s).toMatchObject({ moved: 0, later_states: 1 })
    expect(alerts).toEqual([])
  })
})
