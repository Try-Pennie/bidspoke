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
  drainHeldWrite,
  abandonHeldWrite,
  REPLAY_LEASE_MS,
  type HeldWriteRow,
  type HeldWriteStore,
  type SalesforcePort,
} from '../writeback-replay'
import { isSalesforceBulkheadShed } from '../../engine/nodes/salesforce'

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
    // The replay resends updates only.
    postApex: () => Promise.reject(new Error('the replay posted to Apex')),
  }
  return { port, sent }
}

const deps = (store: HeldWriteStore, sf: SalesforcePort, readBackHolds: (executionId: string, stepNamespace: string) => Promise<boolean> = async () => false) => ({
  store,
  salesforce: async () => sf,
  keys: KEY,
  readBackHolds,
})

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
    const port: SalesforcePort = { send: async () => { throw new Error('token refused') }, postApex: async () => { throw new Error('token refused') } }
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

  it('keeps the previous error when the new one cannot be locked, rather than wiping it', async () => {
    rows[0] = await row({ last_error_encrypted: 'earlier-locked-error' })
    const { store, finishes } = memoryStore(rows)
    // A key ring that opens the body but cannot lock: a malformed NEXT key mid rotation.
    const unlockable = { ...deps(store, salesforce({ status: 503, text: 'unavailable' }).port), keys: { encryptWith: 'not-a-key', decryptWith: [KEY] } }
    const r = await replayHeldWrite(unlockable, ORG, ID)
    expect(r.kind).toBe('still_pending')
    expect(finishes[0].patch).not.toHaveProperty('last_error_encrypted')
    expect(rows[0].last_error_encrypted).toBe('earlier-locked-error')
  })

  it('reports a write that landed but could not be recorded, rather than claiming it was', async () => {
    const { store } = memoryStore(rows)
    store.finish = async () => false
    expect(await replayHeldWrite(deps(store, salesforce({ status: 204, text: '' }).port), ORG, ID)).toEqual({ kind: 'replayed', recorded: false })
  })
})

/**
 * #468 step 1, the second guard: a write the Salesforce read-back holds (its
 * at-risk record, owned and unsettled) is the read-back's to resend. A row for
 * the same step must not be sent beside it, whatever put it in the store.
 */
describe('a row whose write the Salesforce read-back holds (#468)', () => {
  it('is refused by the replay, sending nothing and spending no attempt, asked by the row\'s own run and step', async () => {
    const { store } = memoryStore(rows)
    const sf = salesforce({ status: 204, text: '' })
    const asked: string[] = []
    const holds = async (executionId: string, stepNamespace: string) => { asked.push(`${executionId}:${stepNamespace}`); return true }
    const r = await replayHeldWrite(deps(store, sf.port, holds), ORG, ID)
    expect(r).toMatchObject({ kind: 'not_replayable', reason: expect.stringMatching(/read-back/) })
    expect(asked).toEqual(['01920000-0000-7000-8000-000000000471:patch_submission'])
    expect(sf.sent).toEqual([])
    expect(rows[0].attempts).toBe(0)
  })

  it('is refused by the preview too, which reads nothing from Salesforce', async () => {
    const { store } = memoryStore(rows)
    const sf = salesforce({ status: 204, text: '' })
    expect(await previewReplay(deps(store, sf.port, async () => true), ORG, ID)).toMatchObject({ kind: 'not_replayable', reason: expect.stringMatching(/read-back/) })
    expect(sf.sent).toEqual([])
  })

  it('sends nothing when whether the read-back holds it cannot be asked', async () => {
    const { store } = memoryStore(rows)
    const sf = salesforce({ status: 204, text: '' })
    const r = await replayHeldWrite(deps(store, sf.port, async () => { throw new Error('kv unavailable') }), ORG, ID)
    expect(r).toMatchObject({ kind: 'unreadable', error: expect.stringMatching(/read-back.*kv unavailable/) })
    expect(sf.sent).toEqual([])
    expect(rows[0].attempts).toBe(0)
  })

  it('replays a row the read-back does not hold', async () => {
    const { store } = memoryStore(rows)
    const sf = salesforce({ status: 204, text: '' })
    expect(await replayHeldWrite(deps(store, sf.port, async () => false), ORG, ID)).toEqual({ kind: 'replayed', recorded: true })
  })
})

describe('abandonHeldWrite', () => {
  // A replay claims the row (bumping attempts) before it sends, and records the
  // outcome after. An abandon between the two would close a row whose write may be
  // landing, so a recent claim holds the row for the longest a replay can take.
  it('refuses while a replay claimed the row moments ago, and abandons once that lease has passed', async () => {
    const claimedAt = Date.parse('2026-10-13T21:00:00Z')
    rows[0] = await row({ attempts: 1, updated_at: new Date(claimedAt).toISOString() })
    const { store } = memoryStore(rows)
    expect(await abandonHeldWrite(store, ORG, ID, claimedAt + 30_000)).toEqual({ kind: 'replay_in_flight' })
    expect(rows[0].status).toBe('pending')
    expect(await abandonHeldWrite(store, ORG, ID, claimedAt + REPLAY_LEASE_MS + 1)).toEqual({ kind: 'abandoned' })
  })

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

/**
 * The drain's send (#468 step 3): the same path as a person's replay, with the
 * three things a person decides by hand decided by rule. It reads the record
 * first and leaves out any field another writer changed since the row was
 * written (the read-back's conflict rule, newer wins on LastModifiedDate), it
 * closes the row as abandoned once its last allowed attempt fails, and a read
 * that gets no usable answer spends nothing.
 */
describe('drainHeldWrite (#468 step 3)', () => {
  // The row was written at 20:00:00 UTC (row()'s created_at).
  const BEFORE_THE_ROW = '2026-10-13T19:59:00.000+0000'
  const AFTER_THE_ROW = '2026-10-13T20:05:00.000+0000'

  /** A port whose GET answers `read` and whose PATCH answers `patch`. */
  function port(read: { status: number; text: string } | Error, patch: { status: number; text: string } | Error = { status: 204, text: '' }) {
    const sent: Array<{ method: string; path: string; body?: string }> = []
    const p: SalesforcePort = {
      async send(method, path, body) {
        sent.push({ method, path, body })
        const answer = method === 'GET' ? read : patch
        if (answer instanceof Error) throw answer
        return answer
      },
      postApex: () => Promise.reject(new Error('the drain posted to Apex')),
    }
    return { port: p, sent }
  }
  const current = (fields: Record<string, unknown>) => ({ status: 200, text: JSON.stringify(fields) })
  const patches = (sent: Array<{ method: string; body?: string }>) => sent.filter((s) => s.method === 'PATCH')

  it('reads the record first, naming LastModifiedDate and every field, then sends the patch and marks it replayed', async () => {
    const { store } = memoryStore(rows)
    const sf = port(current({ LastModifiedDate: BEFORE_THE_ROW, External_Exchange_Status__c: 'Pending', Offer_Amount__c: 1 }))
    const r = await drainHeldWrite(deps(store, sf.port), ORG, ID, { maxAttempts: 2 })
    expect(r).toMatchObject({ kind: 'replayed', recorded: true, moved: [] })
    expect(sf.sent[0]).toMatchObject({ method: 'GET', path: '/sobjects/Submission__c/a04Ui00000NkhG1IAJ?fields=LastModifiedDate,External_Exchange_Status__c,Offer_Amount__c' })
    expect(JSON.parse(patches(sf.sent)[0].body!)).toEqual({ External_Exchange_Status__c: 'Completed', Offer_Amount__c: 5000 })
    expect(rows[0]).toMatchObject({ status: 'replayed', attempts: 1 })
  })

  it('leaves out and names a field another writer changed since the row was written, and sends the rest', async () => {
    const { store } = memoryStore(rows)
    const sf = port(current({ LastModifiedDate: AFTER_THE_ROW, External_Exchange_Status__c: 'Funded', Offer_Amount__c: null }))
    const r = await drainHeldWrite(deps(store, sf.port), ORG, ID, { maxAttempts: 2 })
    expect(r).toMatchObject({ kind: 'replayed', moved: ['External_Exchange_Status__c'] })
    expect(JSON.parse(patches(sf.sent)[0].body!)).toEqual({ Offer_Amount__c: 5000 })
    expect(rows[0].status).toBe('replayed')
    expect(await decryptSecret(rows[0].last_error_encrypted!, KEY)).toContain('External_Exchange_Status__c')
  })

  it('treats a value an earlier write of the same record sent as its own, so the newer write wins', async () => {
    const { store } = memoryStore(rows)
    const sf = port(current({ LastModifiedDate: AFTER_THE_ROW, External_Exchange_Status__c: 'Pending', Offer_Amount__c: 5000 }))
    const r = await drainHeldWrite(deps(store, sf.port), ORG, ID, { maxAttempts: 2, earlier: [{ External_Exchange_Status__c: 'Pending' }] })
    expect(r).toMatchObject({ kind: 'replayed', moved: [] })
  })

  it('sends every field to a record nobody has written since the row, whatever it holds', async () => {
    const { store } = memoryStore(rows)
    const sf = port(current({ LastModifiedDate: BEFORE_THE_ROW, External_Exchange_Status__c: 'Funded', Offer_Amount__c: 1 }))
    expect(await drainHeldWrite(deps(store, sf.port), ORG, ID, { maxAttempts: 2 })).toMatchObject({ kind: 'replayed', moved: [] })
  })

  it('closes the row as abandoned, sending nothing and spending no attempt, when every field has moved', async () => {
    const { store } = memoryStore(rows)
    const sf = port(current({ LastModifiedDate: AFTER_THE_ROW, External_Exchange_Status__c: 'Funded', Offer_Amount__c: 7000 }))
    const r = await drainHeldWrite(deps(store, sf.port), ORG, ID, { maxAttempts: 2 })
    expect(r).toMatchObject({ kind: 'all_moved', moved: ['External_Exchange_Status__c', 'Offer_Amount__c'], recorded: true })
    expect(patches(sf.sent)).toEqual([])
    expect(rows[0]).toMatchObject({ status: 'abandoned', attempts: 0 })
  })

  it('spends nothing when the read gets no answer', async () => {
    const { store } = memoryStore(rows)
    const sf = port(new Error('socket hang up'))
    expect(await drainHeldWrite(deps(store, sf.port), ORG, ID, { maxAttempts: 2 })).toMatchObject({ kind: 'read_unanswered' })
    expect(patches(sf.sent)).toEqual([])
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('spends nothing when the read is answered with a failure that is not a refusal', async () => {
    for (const status of [503, 401, 429]) {
      rows = [await row()]
      const { store } = memoryStore(rows)
      const sf = port({ status, text: 'unavailable' })
      expect((await drainHeldWrite(deps(store, sf.port), ORG, ID, { maxAttempts: 2 })).kind, String(status)).toBe('read_failed')
      expect(rows[0], String(status)).toMatchObject({ status: 'pending', attempts: 0 })
    }
  })

  it('closes the row as refused, unsent, when Salesforce refuses the read itself (the record is gone)', async () => {
    const { store } = memoryStore(rows)
    const sf = port({ status: 404, text: '[{"errorCode":"NOT_FOUND"}]' })
    const r = await drainHeldWrite(deps(store, sf.port), ORG, ID, { maxAttempts: 2 })
    expect(r).toMatchObject({ kind: 'refused', resent: false, recorded: true })
    expect(patches(sf.sent)).toEqual([])
    expect(rows[0]).toMatchObject({ status: 'refused', replayable: false, attempts: 0 })
  })

  it('closes a rejected resend as refused, through the one rejection rule', async () => {
    const { store } = memoryStore(rows)
    const sf = port(current({ LastModifiedDate: BEFORE_THE_ROW }), { status: 400, text: '[{"errorCode":"FIELD_CUSTOM_VALIDATION_EXCEPTION"}]' })
    expect(await drainHeldWrite(deps(store, sf.port), ORG, ID, { maxAttempts: 2 })).toMatchObject({ kind: 'refused', resent: true })
    expect(rows[0]).toMatchObject({ status: 'refused', replayable: false, attempts: 1 })
  })

  it('leaves the first failed attempt pending and closes the last one as abandoned', async () => {
    const { store } = memoryStore(rows)
    const sf = port(current({ LastModifiedDate: BEFORE_THE_ROW }), { status: 503, text: 'unavailable' })
    expect(await drainHeldWrite(deps(store, sf.port), ORG, ID, { maxAttempts: 2 })).toMatchObject({ kind: 'still_pending', answered: true })
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1 })
    expect(await drainHeldWrite(deps(store, sf.port), ORG, ID, { maxAttempts: 2 })).toMatchObject({ kind: 'abandoned', answered: true, recorded: true })
    expect(rows[0]).toMatchObject({ status: 'abandoned', attempts: 2 })
    expect(typeof rows[0].finished_at).toBe('string')
  })

  it('says when the last attempt got no answer, since that write may have landed', async () => {
    rows = [await row({ attempts: 1 })]
    const { store } = memoryStore(rows)
    const sf = port(current({ LastModifiedDate: BEFORE_THE_ROW }), new Error('aborted'))
    expect(await drainHeldWrite(deps(store, sf.port), ORG, ID, { maxAttempts: 2 })).toMatchObject({ kind: 'abandoned', answered: false })
  })

  it('sends once when two drains race over one row', async () => {
    const { store } = memoryStore(rows)
    const sf = port(current({ LastModifiedDate: BEFORE_THE_ROW }))
    const [a, b] = await Promise.all([
      drainHeldWrite(deps(store, sf.port), ORG, ID, { maxAttempts: 2 }),
      drainHeldWrite(deps(store, sf.port), ORG, ID, { maxAttempts: 2 }),
    ])
    expect([a.kind, b.kind].sort()).toEqual(['conflict', 'replayed'])
    expect(patches(sf.sent)).toHaveLength(1)
  })

  it('reads nothing for a row the read-back holds', async () => {
    const { store } = memoryStore(rows)
    const sf = port(current({ LastModifiedDate: BEFORE_THE_ROW }))
    expect(await drainHeldWrite(deps(store, sf.port, async () => true), ORG, ID, { maxAttempts: 2 })).toMatchObject({ kind: 'not_replayable' })
    expect(sf.sent).toEqual([])
  })
})

/**
 * A full bulkhead refuses the call before anything leaves (#468): nothing was
 * sent, so it is a hold, not a failed attempt, for a person's replay and the
 * drain alike.
 */
describe('a send the Salesforce bulkhead refused', () => {
  const shed = () => Object.assign(new Error('Salesforce bulkhead: at capacity (salesforce, 8/8 inflight, waited 0ms)'), { bulkheadShed: true })

  it('gives the attempt back and keeps the row pending', async () => {
    const { store } = memoryStore(rows)
    const r = await replayHeldWrite(deps(store, salesforce(shed()).port), ORG, ID)
    expect(r).toMatchObject({ kind: 'held' })
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('never closes the row on the drain\'s last attempt', async () => {
    rows = [await row({ attempts: 1 })]
    const { store } = memoryStore(rows)
    const sf: SalesforcePort = {
      send: async (method) => {
        if (method === 'GET') return { status: 200, text: JSON.stringify({ LastModifiedDate: '2026-10-13T19:00:00.000+0000' }) }
        throw shed()
      },
      postApex: () => Promise.reject(new Error('no')),
    }
    expect(await drainHeldWrite(deps(store, sf), ORG, ID, { maxAttempts: 2 })).toMatchObject({ kind: 'held' })
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1 })
  })

  it('says held, not unanswered, when the bulkhead refuses the drain\'s read', async () => {
    const { store } = memoryStore(rows)
    const sf: SalesforcePort = { send: async () => { throw shed() }, postApex: () => Promise.reject(new Error('no')) }
    expect(await drainHeldWrite(deps(store, sf), ORG, ID, { maxAttempts: 2 })).toMatchObject({ kind: 'held' })
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('is recognised by the mark the Salesforce call path puts on its refusal, never by its wording', () => {
    expect(isSalesforceBulkheadShed(shed())).toBe(true)
    expect(isSalesforceBulkheadShed(new Error('Salesforce bulkhead: at capacity'))).toBe(false)
    expect(isSalesforceBulkheadShed('bulkheadShed')).toBe(false)
  })
})
