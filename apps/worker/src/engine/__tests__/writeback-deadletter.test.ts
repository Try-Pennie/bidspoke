/**
 * Capturing a failed post-answer Salesforce write for replay (#1993).
 *
 * The failed step carries the request its executor resolved (#1992). This turns
 * it into one encrypted row, written through the durable outcome path, or says
 * why it cannot: a write the replay could not resend must never become a row
 * that looks replayable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptSecret } from '../../lib/secret-crypto'
import {
  writebackFromFailure,
  captureFailedWriteback,
  WRITEBACK_STORE_LABEL,
  WRITEBACK_UNCAPTURABLE_LABEL,
  WRITEBACK_HELD_LABEL,
} from '../writeback-deadletter'
import type { ResolvedStepInput } from '../../types'

vi.mock('../durability', async (importOriginal) => {
  const real = await importOriginal<typeof import('../durability')>()
  return { ...real, recordOutcomeDeadLetter: vi.fn().mockResolvedValue(true) }
})
import { recordOutcomeDeadLetter } from '../durability'

// A real AES key, so the round trip is the shipped encryption, not a stub.
const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 1)).toString('base64')

const update = (resolved: Record<string, unknown>): ResolvedStepInput => ({
  template: {},
  resolved: { operation: 'update', object: 'Submission__c', method: 'PATCH', url: 'https://sf/x', record_id: 'a04Ui00000NkhG1IAJ', body: { External_Exchange_Status__c: 'Completed', Email__c: 'p@example.com' }, ...resolved },
})

function fakeSupabase(opts: { duplicate?: boolean } = {}) {
  const inserts: Record<string, unknown>[] = []
  const client = {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        inserts.push({ table, ...row })
        // An earlier attempt that landed but timed out: the retry meets the unique key.
        return { error: opts.duplicate ? { code: '23505', message: 'duplicate key value violates unique constraint' } : null }
      },
    }),
  }
  return { client: client as unknown as SupabaseClient, inserts }
}

const kv = { get: async () => null, put: async () => {}, delete: async () => {} }
const run = {
  orgId: '11111111-1111-1111-1111-111111111993',
  workflowId: '44444444-4444-4444-4444-444444441993',
  workflowName: 'Main Flow',
  executionId: '01920000-0000-7000-8000-000000001993',
  stepNamespace: 'patch_submission',
  isTest: false,
}

beforeEach(() => vi.mocked(recordOutcomeDeadLetter).mockClear())

describe('which failures can be stored for replay', () => {
  it('stores a Salesforce update with its record and body', () => {
    expect(writebackFromFailure('salesforce', update({}))).toEqual({
      ok: true,
      sf_object: 'Submission__c',
      sf_record_id: 'a04Ui00000NkhG1IAJ',
      sf_operation: 'update',
      body: { External_Exchange_Status__c: 'Completed', Email__c: 'p@example.com' },
    })
  })

  it('leaves a step that is not a Salesforce write alone, since nothing replays it', () => {
    expect(writebackFromFailure('code', update({}))).toEqual({ ok: false, reason: 'not_salesforce' })
  })

  it('refuses what the replay could not resend, saying why', () => {
    // Only updates are written after the answer today; a create has no record to aim at.
    expect(writebackFromFailure('salesforce', update({ operation: 'create' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/create/) })
    expect(writebackFromFailure('salesforce', update({ record_id: '' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/record id/) })
    expect(writebackFromFailure('salesforce', update({ body: null }))).toMatchObject({ ok: false, reason: expect.stringMatching(/body/) })
    expect(writebackFromFailure('salesforce', update({ object: '' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/object/) })
    expect(writebackFromFailure('salesforce', null)).toMatchObject({ ok: false, reason: expect.stringMatching(/no resolved request/) })
  })
})

describe('captureFailedWriteback', () => {
  it('writes one row with the body and the error encrypted, never in the clear', async () => {
    const db = fakeSupabase()
    const result = await captureFailedWriteback(
      { ...run, nodeType: 'salesforce', errorType: 'transient', error: new Error('Salesforce API error (503): unavailable for p@example.com'), resolvedInput: update({}) },
      { supabase: db.client, kv, orgId: run.orgId, appUrl: 'https://app', encryptionKeys: KEY },
    )
    expect(result).toEqual({ kind: 'stored' })
    expect(db.inserts).toHaveLength(1)
    const row = db.inserts[0]
    expect(row).toMatchObject({
      table: 'outcome_writeback_deadletters',
      organization_id: run.orgId,
      workflow_id: run.workflowId,
      execution_id: run.executionId,
      step_namespace: 'patch_submission',
      sf_object: 'Submission__c',
      sf_record_id: 'a04Ui00000NkhG1IAJ',
      sf_operation: 'update',
      error_type: 'transient',
      replayable: true,
    })
    expect(JSON.stringify(row)).not.toContain('p@example.com')
    expect(JSON.parse(await decryptSecret(row.body_encrypted as string, KEY))).toEqual({ External_Exchange_Status__c: 'Completed', Email__c: 'p@example.com' })
    expect(await decryptSecret(row.error_encrypted as string, KEY)).toContain('unavailable for p@example.com')
  })

  it('stores a permanent failure as already refused and finished, so the replay leaves it and retention reaches it', async () => {
    const db = fakeSupabase()
    await captureFailedWriteback(
      { ...run, nodeType: 'salesforce', errorType: 'permanent', error: new Error('Salesforce API error (400): INVALID_FIELD'), resolvedInput: update({}) },
      { supabase: db.client, kv, orgId: run.orgId, appUrl: 'https://app', encryptionKeys: KEY },
    )
    expect(db.inserts[0]).toMatchObject({ replayable: false, status: 'refused' })
    expect(typeof db.inserts[0].finished_at).toBe('string')
  })

  it('stores a replayable failure as pending, with no finish time', async () => {
    const db = fakeSupabase()
    await captureFailedWriteback(
      { ...run, nodeType: 'salesforce', errorType: 'transient', error: new Error('x'), resolvedInput: update({}) },
      { supabase: db.client, kv, orgId: run.orgId, appUrl: 'https://app', encryptionKeys: KEY },
    )
    expect(db.inserts[0]).toMatchObject({ replayable: true, status: 'pending', finished_at: null })
  })

  it('counts a retried insert that meets its own earlier row as stored, not lost', async () => {
    const db = fakeSupabase({ duplicate: true })
    const result = await captureFailedWriteback(
      { ...run, nodeType: 'salesforce', errorType: 'transient', error: new Error('x'), resolvedInput: update({}) },
      { supabase: db.client, kv, orgId: run.orgId, appUrl: 'https://app', encryptionKeys: KEY },
    )
    expect(result).toEqual({ kind: 'stored' })
    expect(recordOutcomeDeadLetter).not.toHaveBeenCalled()
  })

  it('stores nothing for a test run, and something for the same failure on a live one', async () => {
    const test = fakeSupabase()
    const args = { ...run, nodeType: 'salesforce', errorType: 'transient' as const, error: new Error('x'), resolvedInput: update({}) }
    expect(await captureFailedWriteback({ ...args, isTest: true }, { supabase: test.client, kv, orgId: run.orgId, appUrl: 'https://app', encryptionKeys: KEY })).toEqual({ kind: 'skipped', reason: 'test run' })
    expect(test.inserts).toHaveLength(0)
    const live = fakeSupabase()
    await captureFailedWriteback(args, { supabase: live.client, kv, orgId: run.orgId, appUrl: 'https://app', encryptionKeys: KEY })
    expect(live.inserts).toHaveLength(1)
  })

  it('dead-letters a Salesforce failure it cannot store, rather than storing a row the replay could not resend', async () => {
    const db = fakeSupabase()
    const result = await captureFailedWriteback(
      { ...run, nodeType: 'salesforce', errorType: 'transient', error: new Error('x'), resolvedInput: update({ record_id: '' }) },
      { supabase: db.client, kv, orgId: run.orgId, appUrl: 'https://app', encryptionKeys: KEY },
    )
    expect(result).toMatchObject({ kind: 'uncapturable' })
    expect(db.inserts).toHaveLength(0)
    expect(recordOutcomeDeadLetter).toHaveBeenCalledWith(WRITEBACK_UNCAPTURABLE_LABEL, expect.anything(), expect.anything(), expect.objectContaining({ execution_id: run.executionId }))
  })

  it('does nothing at all for a step that is not a Salesforce write', async () => {
    const db = fakeSupabase()
    expect(await captureFailedWriteback({ ...run, nodeType: 'code', errorType: 'transient', error: new Error('x'), resolvedInput: null }, { supabase: db.client, kv, orgId: run.orgId, appUrl: 'https://app', encryptionKeys: KEY })).toEqual({ kind: 'skipped', reason: 'not_salesforce' })
    expect(db.inserts).toHaveLength(0)
    expect(recordOutcomeDeadLetter).not.toHaveBeenCalled()
  })

  // A missing or malformed SECRET_ENCRYPTION_KEY fails at encryption, inside the
  // capture: it is dead-lettered under the store's label, never thrown into the
  // finalize and never silent.
  it('dead-letters the write when the encryption key is missing, rather than throwing or storing it in the clear', async () => {
    const db = fakeSupabase()
    const result = await captureFailedWriteback(
      { ...run, nodeType: 'salesforce', errorType: 'transient', error: new Error('x'), resolvedInput: update({}) },
      { supabase: db.client, kv, orgId: run.orgId, appUrl: 'https://app', encryptionKeys: '' },
    )
    expect(result).toMatchObject({ kind: 'store_failed' })
    expect(db.inserts).toHaveLength(0)
    expect(recordOutcomeDeadLetter).toHaveBeenCalledWith(WRITEBACK_STORE_LABEL, expect.anything(), expect.anything(), expect.objectContaining({ execution_id: run.executionId }))
  })

  it('logs the lost write when its dead letter fails too, rather than dropping it in silence', async () => {
    vi.mocked(recordOutcomeDeadLetter).mockRejectedValueOnce(new Error('kv down'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await captureFailedWriteback(
        { ...run, nodeType: 'salesforce', errorType: 'transient', error: new Error('x'), resolvedInput: update({}) },
        { supabase: fakeSupabase().client, kv, orgId: run.orgId, appUrl: 'https://app', encryptionKeys: '' },
      )
      expect(result).toMatchObject({ kind: 'store_failed' })
      const line = logged.mock.calls.map((c) => c.join(' ')).find((l) => l.includes(WRITEBACK_STORE_LABEL))
      expect(line).toMatch(/kv down/)
      expect(line).toContain(run.executionId)
    } finally {
      logged.mockRestore()
    }
  })

  it('names its store label for the durable path', () => {
    expect(WRITEBACK_STORE_LABEL).toBe('outcome_writeback_deadletters.insert')
  })
})

/**
 * #2163: a timed out update is an unknown outcome, held in KV by the at-risk
 * watch, not a refusal for the replay store and never "cannot be replayed". The
 * request the failure carries came from the watch, with the held record's expiry.
 */
describe('a timed out update the at-risk record holds (#2163)', () => {
  const UNTIL = '2026-10-16T00:29:54.000Z'
  const timedOut = new Error('Step timed out after 1500ms (in-flight upstream call canceled via abort signal)')
  const noted = (object: string, recordId: string, body: Record<string, unknown>): ResolvedStepInput => ({
    template: null,
    resolved: { operation: 'update', object, record_id: recordId, body },
  })
  const prospect = noted('Prospect__c', 'a06Ui00002sLkNuIAK', { BidStatus__c: 'Rejected', RejectionReason__c: 'unqualified_lead' })

  it('stores no row and is not dead-lettered as uncapturable, but as held, naming the record, the fields and the expiry', async () => {
    const db = fakeSupabase()
    const result = await captureFailedWriteback(
      { ...run, stepNamespace: 'patch_prospect_reject', nodeType: 'salesforce', errorType: 'transient', error: timedOut, resolvedInput: prospect, heldUntil: UNTIL },
      { supabase: db.client, kv, orgId: run.orgId, appUrl: 'https://app', encryptionKeys: KEY },
    )
    expect(result).toEqual({ kind: 'held', until: UNTIL })
    expect(db.inserts).toHaveLength(0)
    const labels = vi.mocked(recordOutcomeDeadLetter).mock.calls.map((c) => c[0])
    expect(labels).not.toContain(WRITEBACK_UNCAPTURABLE_LABEL)
    expect(labels).toEqual([WRITEBACK_HELD_LABEL])
    const [, error, , details] = vi.mocked(recordOutcomeDeadLetter).mock.calls[0]
    expect(error).toBe(timedOut)
    expect(details).toMatchObject({
      execution_id: run.executionId,
      held: {
        step: 'patch_prospect_reject',
        sf_object: 'Prospect__c',
        sf_record_id: 'a06Ui00002sLkNuIAK',
        fields: ['BidStatus__c', 'RejectionReason__c'],
        until: UNTIL,
      },
    })
    // Field names only: no value of the write reaches the alert.
    expect(JSON.stringify(details)).not.toMatch(/Rejected|unqualified_lead/)
  })

  it('treats Applicant and Lead the same way, since no read-back covers them either', async () => {
    for (const object of ['Applicant__c', 'Lead']) {
      vi.mocked(recordOutcomeDeadLetter).mockClear()
      await captureFailedWriteback(
        { ...run, nodeType: 'salesforce', errorType: 'transient', error: timedOut, resolvedInput: noted(object, '00QUi000001', { Status: 'Open' }), heldUntil: UNTIL },
        { supabase: fakeSupabase().client, kv, orgId: run.orgId, appUrl: 'https://app', encryptionKeys: KEY },
      )
      expect(vi.mocked(recordOutcomeDeadLetter).mock.calls.map((c) => c[0])).toEqual([WRITEBACK_HELD_LABEL])
    }
  })

  // The Submission read-back (#2023) is not live yet, so a held Submission
  // update is announced like any other: a wrong alert swapped for no alert
  // would be the worse failure. #2023 takes these over when it ships.
  it('announces a held Submission write too, and stores no row', async () => {
    const db = fakeSupabase()
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await captureFailedWriteback(
        { ...run, nodeType: 'salesforce', errorType: 'transient', error: timedOut, resolvedInput: noted('Submission__c', 'a04Ui00000NkhG1IAJ', { PDFlow_1__c: 'x' }), heldUntil: UNTIL },
        { supabase: db.client, kv, orgId: run.orgId, appUrl: 'https://app', encryptionKeys: KEY },
      )
      expect(result).toEqual({ kind: 'held', until: UNTIL })
      expect(warned.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('a04Ui00000NkhG1IAJ')
    } finally {
      warned.mockRestore()
    }
    expect(db.inserts).toHaveLength(0)
    expect(vi.mocked(recordOutcomeDeadLetter).mock.calls.map((c) => c[0])).toEqual([WRITEBACK_HELD_LABEL])
    expect(vi.mocked(recordOutcomeDeadLetter).mock.calls[0][3]).toMatchObject({
      held: { sf_object: 'Submission__c', sf_record_id: 'a04Ui00000NkhG1IAJ', fields: ['PDFlow_1__c'], until: UNTIL },
    })
  })

  it('still stores a refusal, which the watch does not hold', async () => {
    const db = fakeSupabase()
    const result = await captureFailedWriteback(
      { ...run, nodeType: 'salesforce', errorType: 'permanent', error: new Error('Salesforce API error (400): FIELD_CUSTOM_VALIDATION_EXCEPTION'), resolvedInput: update({}), heldUntil: null },
      { supabase: db.client, kv, orgId: run.orgId, appUrl: 'https://app', encryptionKeys: KEY },
    )
    expect(result).toEqual({ kind: 'stored' })
    expect(db.inserts[0]).toMatchObject({ status: 'refused' })
  })

  it('stores nothing and announces nothing for a test run, held or not', async () => {
    const db = fakeSupabase()
    const result = await captureFailedWriteback(
      { ...run, isTest: true, nodeType: 'salesforce', errorType: 'transient', error: timedOut, resolvedInput: prospect, heldUntil: UNTIL },
      { supabase: db.client, kv, orgId: run.orgId, appUrl: 'https://app', encryptionKeys: KEY },
    )
    expect(result).toEqual({ kind: 'skipped', reason: 'test run' })
    expect(recordOutcomeDeadLetter).not.toHaveBeenCalled()
  })
})
