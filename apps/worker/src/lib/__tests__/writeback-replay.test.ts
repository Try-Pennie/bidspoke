/**
 * Replaying a held Salesforce write by hand (#471).
 *
 * A failed post-answer write is kept, encrypted, in outcome_writeback_deadletters
 * (#1993). This is the escape hatch for it: preview what would be sent beside
 * what Salesforce holds now, send it once, and record how it ended. A person can
 * also close a row they dealt with by hand.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { encryptSecret, decryptSecret } from '../secret-crypto'
import {
  previewReplay,
  replayHeldWrite,
  abandonHeldWrite,
  type HeldWriteRow,
  type HeldWriteStore,
  type SalesforcePort,
} from '../writeback-replay'

const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 3)).toString('base64')
const ORG = '11111111-1111-1111-1111-111111111471'
const ID = '22222222-2222-2222-2222-222222222471'

async function row(over: Partial<HeldWriteRow> = {}): Promise<HeldWriteRow> {
  return {
    id: ID,
    organization_id: ORG,
    workflow_id: '44444444-4444-4444-4444-444444444471',
    execution_id: '01920000-0000-7000-8000-000000000471',
    step_namespace: 'patch_submission',
    sf_object: 'Submission__c',
    sf_record_id: 'a04Ui00000NkhG1IAJ',
    sf_operation: 'update',
    body_encrypted: await encryptSecret(JSON.stringify({ External_Exchange_Status__c: 'Completed', Offer_Amount__c: 5000 }), KEY),
    error_encrypted: await encryptSecret('Salesforce API error (503): unavailable', KEY),
    error_type: 'transient',
    replayable: true,
    status: 'pending',
    attempts: 0,
    last_error_encrypted: null,
    created_at: '2026-10-13T20:00:00Z',
    updated_at: '2026-10-13T20:00:00Z',
    finished_at: null,
    ...over,
  }
}

/** Holds rows in memory and applies the same compare-and-set the real store does. */
function memoryStore(rows: HeldWriteRow[]) {
  const finishes: Array<{ id: string; patch: Record<string, unknown> }> = []
  const store: HeldWriteStore = {
    async get(orgId, id) {
      return rows.find((r) => r.id === id && r.organization_id === orgId) ?? null
    },
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
      finishes.push({ id, patch })
      return true
    },
    async list() {
      return rows
    },
  }
  return { store, finishes }
}

function salesforce(answer: { status: number; text: string } | Error, current: Record<string, unknown> = {}) {
  const sent: Array<{ method: string; path: string; body?: string }> = []
  const port: SalesforcePort = {
    async send(method, path, body) {
      sent.push({ method, path, body })
      if (method === 'GET') return { status: 200, text: JSON.stringify(current) }
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  return { port, sent }
}

const deps = (store: HeldWriteStore, sf: SalesforcePort) => ({ store, salesforce: async () => sf, keys: KEY })

let rows: HeldWriteRow[]
beforeEach(async () => {
  rows = [await row()]
})

describe('previewReplay', () => {
  it('shows each field to be sent beside its current Salesforce value, and sends nothing', async () => {
    const { store } = memoryStore(rows)
    const sf = salesforce({ status: 204, text: '' }, { External_Exchange_Status__c: 'Pending', Offer_Amount__c: 5000 })
    const p = await previewReplay(deps(store, sf.port), ORG, ID)
    expect(p).toMatchObject({ kind: 'preview', sf_object: 'Submission__c', sf_record_id: 'a04Ui00000NkhG1IAJ' })
    if (p.kind !== 'preview') throw new Error('not a preview')
    expect(p.fields).toEqual([
      { field: 'External_Exchange_Status__c', send: 'Completed', current: 'Pending', differs: true },
      { field: 'Offer_Amount__c', send: 5000, current: 5000, differs: false },
    ])
    expect(sf.sent.map((s) => s.method)).toEqual(['GET'])
    expect(sf.sent[0].path).toBe('/sobjects/Submission__c/a04Ui00000NkhG1IAJ?fields=External_Exchange_Status__c,Offer_Amount__c')
    expect(rows[0].attempts).toBe(0)
  })

  it('still previews the fields when Salesforce cannot be read, and says so', async () => {
    const { store } = memoryStore(rows)
    const port: SalesforcePort = { send: async () => { throw new Error('token refused') } }
    const p = await previewReplay(deps(store, port), ORG, ID)
    if (p.kind !== 'preview') throw new Error('not a preview')
    expect(p.current_unreadable).toMatch(/token refused/)
    expect(p.fields.every((f) => f.current === undefined && f.differs === null)).toBe(true)
  })

  it('finds nothing in another organization', async () => {
    const { store } = memoryStore(rows)
    expect(await previewReplay(deps(store, salesforce({ status: 204, text: '' }).port), 'other-org', ID)).toEqual({ kind: 'not_found' })
  })
})

describe('replayHeldWrite', () => {
  it('sends the captured body as literal JSON and marks the row replayed', async () => {
    const { store } = memoryStore(rows)
    const sf = salesforce({ status: 204, text: '' })
    const r = await replayHeldWrite(deps(store, sf.port), ORG, ID)
    expect(r).toEqual({ kind: 'replayed', recorded: true })
    const patch = sf.sent.find((s) => s.method === 'PATCH')
    expect(patch?.path).toBe('/sobjects/Submission__c/a04Ui00000NkhG1IAJ')
    expect(JSON.parse(patch!.body!)).toEqual({ External_Exchange_Status__c: 'Completed', Offer_Amount__c: 5000 })
    expect(rows[0]).toMatchObject({ status: 'replayed', attempts: 1 })
    expect(typeof rows[0].finished_at).toBe('string')
  })

  // The body was resolved once, in the run. Sending it through a template engine
  // again would let a lead's own text reach for a secret.
  it('never resolves a template inside the captured values', async () => {
    rows[0] = await row({ body_encrypted: await encryptSecret(JSON.stringify({ Notes__c: '{{env.SALESFORCE_CLIENT_SECRET}}' }), KEY) })
    const { store } = memoryStore(rows)
    const sf = salesforce({ status: 204, text: '' })
    await replayHeldWrite(deps(store, sf.port), ORG, ID)
    expect(JSON.parse(sf.sent.find((s) => s.method === 'PATCH')!.body!)).toEqual({ Notes__c: '{{env.SALESFORCE_CLIENT_SECRET}}' })
  })

  it('marks a business rejection refused and finished, keeping the error encrypted', async () => {
    const { store } = memoryStore(rows)
    const r = await replayHeldWrite(deps(store, salesforce({ status: 400, text: '[{"errorCode":"FIELD_CUSTOM_VALIDATION_EXCEPTION","message":"Bad for p@example.com"}]' }).port), ORG, ID)
    expect(r).toMatchObject({ kind: 'refused', recorded: true })
    expect(rows[0]).toMatchObject({ status: 'refused', replayable: false })
    expect(rows[0].last_error_encrypted).not.toContain('p@example.com')
    expect(await decryptSecret(rows[0].last_error_encrypted!, KEY)).toContain('FIELD_CUSTOM_VALIDATION_EXCEPTION')
  })

  // A credential or permission fault is ours, not Salesforce rejecting this
  // write: closing the row would lose a write that fixing the login lets through.
  it('leaves a write pending when Salesforce refuses the login or the permission, not the write', async () => {
    for (const status of [401, 403]) {
      rows = [await row()]
      const { store } = memoryStore(rows)
      const r = await replayHeldWrite(deps(store, salesforce({ status, text: '[{"errorCode":"INSUFFICIENT_ACCESS"}]' }).port), ORG, ID)
      expect(r.kind, String(status)).toBe('still_pending')
      expect(rows[0], String(status)).toMatchObject({ status: 'pending', replayable: true })
    }
  })

  it('leaves a transient failure pending with its error, so it can be sent again', async () => {
    const { store } = memoryStore(rows)
    const r = await replayHeldWrite(deps(store, salesforce({ status: 503, text: 'unavailable' }).port), ORG, ID)
    expect(r).toMatchObject({ kind: 'still_pending', recorded: true })
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1, finished_at: null })
    expect(await decryptSecret(rows[0].last_error_encrypted!, KEY)).toContain('503')
  })

  it('leaves a network failure pending, since nothing says Salesforce refused it', async () => {
    const { store } = memoryStore(rows)
    const r = await replayHeldWrite(deps(store, salesforce(new Error('connection reset')).port), ORG, ID)
    expect(r).toMatchObject({ kind: 'still_pending' })
    expect(rows[0].status).toBe('pending')
  })

  it('sends once when two replays race, and tells the second it lost', async () => {
    const { store } = memoryStore(rows)
    const sf = salesforce({ status: 204, text: '' })
    const [a, b] = await Promise.all([replayHeldWrite(deps(store, sf.port), ORG, ID), replayHeldWrite(deps(store, sf.port), ORG, ID)])
    expect([a.kind, b.kind].sort()).toEqual(['conflict', 'replayed'])
    expect(sf.sent.filter((s) => s.method === 'PATCH')).toHaveLength(1)
  })

  it('refuses a row that is not pending or not replayable, sending nothing', async () => {
    rows[0] = await row({ status: 'refused', replayable: false, finished_at: '2026-10-13T20:00:01Z' })
    const { store } = memoryStore(rows)
    const sf = salesforce({ status: 204, text: '' })
    expect(await replayHeldWrite(deps(store, sf.port), ORG, ID)).toMatchObject({ kind: 'not_replayable' })
    expect(sf.sent).toEqual([])
  })

  it('reports a sent write whose outcome the database refused to record, rather than throwing over it', async () => {
    const { store } = memoryStore(rows)
    store.finish = async () => { throw new Error('statement timeout') }
    expect(await replayHeldWrite(deps(store, salesforce({ status: 204, text: '' }).port), ORG, ID)).toEqual({ kind: 'replayed', recorded: false })
  })

  it('reports a write that landed but could not be recorded, rather than claiming it was', async () => {
    const { store } = memoryStore(rows)
    store.finish = async () => false
    expect(await replayHeldWrite(deps(store, salesforce({ status: 204, text: '' }).port), ORG, ID)).toEqual({ kind: 'replayed', recorded: false })
  })
})

describe('abandonHeldWrite', () => {
  it('closes a pending row as abandoned and finished', async () => {
    const { store } = memoryStore(rows)
    expect(await abandonHeldWrite(store, ORG, ID)).toEqual({ kind: 'abandoned' })
    expect(rows[0]).toMatchObject({ status: 'abandoned' })
    expect(typeof rows[0].finished_at).toBe('string')
  })

  it('leaves a finished row alone', async () => {
    rows[0] = await row({ status: 'replayed', finished_at: '2026-10-13T20:00:01Z' })
    const { store } = memoryStore(rows)
    expect(await abandonHeldWrite(store, ORG, ID)).toMatchObject({ kind: 'not_pending' })
  })
})
