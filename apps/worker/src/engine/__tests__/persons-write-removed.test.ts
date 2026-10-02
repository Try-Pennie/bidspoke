/**
 * The engine must not write the `persons` table (#765).
 *
 * `persons` was write-only: the sole `.from('persons')` in the codebase sat
 * inside its own writer, nothing ever read it back, and it is NOT in the
 * Snowflake path (the export reads `lead_sightings`, whose raw `ssn` is written
 * directly by insertSighting, independently of the persons write). Measured
 * 2026-08-13 it had reached 3,694,280 rows / 4,184 MB, the largest table in a
 * 27 GB database, and every trigger paid an AES-GCM encrypt per PII field for a
 * row nobody would read. It is also encrypted Social Security data with no
 * consumer, so it is pure compliance surface (#257).
 *
 * These tests assert the write is gone at the trigger boundary and in the admin
 * backfill, and that `lead_sightings.person_id` degrades to its already-supported
 * null state rather than the insert failing.
 *
 * The table-access assertions run against the REAL lead-sightings module with a
 * recording Supabase double, so they observe which tables the engine actually
 * touches rather than which functions it calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { WorkflowDefinition } from '../../types'

vi.mock('../definition-loader')
vi.mock('../../lib/env-loader', () => ({ loadEnvVars: vi.fn().mockResolvedValue({}) }))
vi.mock('../../lib/partner-constants-loader', () => ({ loadPartnerConstants: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../step-logger', () => ({
  NO_ROW_MATCHED_CODE: 'BIDSPOKE_NO_ROW_MATCHED',
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(null),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
vi.mock('../nodes/index')
vi.mock('../achieve-log', () => ({
  extractAchieveEvaluations: vi.fn().mockReturnValue([]),
  insertAchieveEvaluations: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/execution-alerts', () => ({ fireExecutionAlert: vi.fn().mockResolvedValue(undefined) }))
// writeOutcome must stay a real pass-through: it is the seam every lead_sightings
// write goes through, so stubbing it away makes the write vanish and any
// "persons is never written" assertion pass vacuously.
vi.mock('../durability', () => ({
  recordOutcomeDeadLetter: vi.fn().mockResolvedValue(true),
  writeOutcome: vi.fn((_label: string, op: () => Promise<unknown>) => op()),
}))
// Only finalizeSighting is stubbed: it UPDATEs lead_sightings after the walk and
// would add noise to the recorded table list. insertSighting stays REAL so the
// row it builds (and its person_id) is the thing under test.
vi.mock('../lead-sightings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lead-sightings')>()),
  finalizeSighting: vi.fn().mockResolvedValue(undefined),
}))

import { executeWorkflow, moneyRuntime } from '../index'
import { loadWorkflowDefinition } from '../definition-loader'
import { executeNode } from '../nodes/index'

const RESPONSE = { status: 200, headers: {}, body: { ok: true } }
const definition = {
  trigger: { id: 'trigger', type: 'trigger', config: {} },
  nodes: [{ id: 'r', namespace: 'resp', type: 'response', config: { retries: 0 } }],
  edges: [],
} as unknown as WorkflowDefinition

// A lead carrying every field the persons writer used to encrypt, in the shape
// the live Engine Bidding Workflow actually sends (nested under
// personalInformation, keys as extractPersonFields reads them). A flat fixture
// would make extractPersonFields return null and every assertion below pass
// without the write path ever being reached.
const PII_PAYLOAD = {
  personalInformation: {
    ssn: '123-45-6789',
    firstName: 'Ada',
    middleName: 'M',
    lastName: 'Lovelace',
    dateOfBirth: '1815-12-10',
    email: 'ada@example.test',
    primaryPhone: '5555550123',
    address1: '1 Analytical Engine Way',
    address2: '2B',
    city: 'London',
    state: 'NY',
    zipcode: '10001',
  },
}

function makeKV() {
  const store = new Map<string, string>()
  return {
    async get(k: string, t?: string) { const v = store.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v },
    async put(k: string, v: string) { store.set(k, v) },
    async delete(k: string) { store.delete(k) },
  } as unknown as KVNamespace
}

// Records every table `.from()` is called with, and every row handed to a write.
function makeRecordingSupabase(opts: { failOn?: string } = {}) {
  const tables: string[] = []
  const inserted: Record<string, unknown[]> = {}
  const client = {
    from(table: string) {
      tables.push(table)
      const result = opts.failOn === table
        ? { data: null, error: { message: `refused: ${table}`, code: '42501' } }
        : { data: { id: 'row-1' }, error: null }
      const chain: Record<string, unknown> = {
        insert(row: unknown) { (inserted[table] ??= []).push(row); return Promise.resolve(result) },
        upsert(row: unknown) { (inserted[table] ??= []).push(row); return chain },
        update(row: unknown) { (inserted[table] ??= []).push(row); return chain },
        select() { return chain },
        eq() { return chain },
        single() { return Promise.resolve(result) },
        maybeSingle() { return Promise.resolve(result) },
        then(res: (v: unknown) => unknown) { return Promise.resolve(result).then(res) },
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { client, tables, inserted }
}

function makeHarness() {
  const background: Promise<unknown>[] = []
  const env = {
    IDEMPOTENCY: makeKV(),
    WORKFLOW_CACHE: makeKV(),
    APP_URL: 'https://app.test',
    PII_REDACTION_FIELDS: '',
    // A real 32-byte base64 key, so a surviving encrypt path would succeed
    // rather than throw and look like it had been removed.
    SECRET_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    SSN_HASH_PEPPER: 'test-pepper',
  } as unknown as Env
  const executionCtx = { waitUntil: (p: Promise<unknown>) => background.push(p.catch(() => {})) }
  const drain = async () => {
    for (let i = 0; i < 8 && background.length; i++) await Promise.all(background.splice(0))
  }
  return { env, executionCtx, drain }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadWorkflowDefinition).mockResolvedValue({
    definition,
    workflow_version_id: 'v1',
    workflow_name: 'Persons Write Test',
    org_id: 'org-1',
    slack_channel: null, lane: 'money',
  })
  vi.mocked(executeNode).mockResolvedValue({ output: RESPONSE, earlyResponse: RESPONSE })
})

describe('engine trigger boundary: persons write removed (#765)', () => {
  it('never touches the persons table, even for a lead carrying every PII field', async () => {
    const db = makeRecordingSupabase()
    const harness = makeHarness()

    await executeWorkflow(
      { workflowId: 'wf-1', payload: PII_PAYLOAD, source: 'engine' },
      harness.env, moneyRuntime(db.client), harness.executionCtx,
    )
    await harness.drain()

    expect(db.tables).not.toContain('persons')
    expect(db.inserted.persons).toBeUndefined()
  })

  it('still writes the lead_sightings row, with person_id null and the SSN intact', async () => {
    const db = makeRecordingSupabase()
    const harness = makeHarness()

    await executeWorkflow(
      { workflowId: 'wf-1', payload: PII_PAYLOAD, source: 'engine' },
      harness.env, moneyRuntime(db.client), harness.executionCtx,
    )
    await harness.drain()

    const row = db.inserted.lead_sightings?.[0] as Record<string, unknown> | undefined
    expect(row).toBeDefined()
    // person_id is nullable by design; the sighting keeps its own raw ssn, which
    // is what the Snowflake export and repeat-lead grouping actually read.
    expect(row?.person_id).toBeNull()
    expect(row?.ssn).toBe('123-45-6789')
  })

  it('performs no AES-GCM encrypt at the trigger boundary', async () => {
    const db = makeRecordingSupabase()
    const harness = makeHarness()
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt')

    await executeWorkflow(
      { workflowId: 'wf-1', payload: PII_PAYLOAD, source: 'engine' },
      harness.env, moneyRuntime(db.client), harness.executionCtx,
    )
    await harness.drain()

    expect(encrypt).not.toHaveBeenCalled()
    encrypt.mockRestore()
  })

  it('still writes the sighting when the database refuses a persons write outright', async () => {
    // Failure path: a DB that hard-refuses `persons` (as a revoked grant would).
    // With the write gone this is inert; while it existed, the refusal ran through
    // the outcome/dead-letter machinery on every single lead.
    const db = makeRecordingSupabase({ failOn: 'persons' })
    const harness = makeHarness()

    const result = await executeWorkflow(
      { workflowId: 'wf-1', payload: PII_PAYLOAD, source: 'engine' },
      harness.env, moneyRuntime(db.client), harness.executionCtx,
    )
    await harness.drain()

    expect(result.status).toBe(200)
    expect(db.inserted.lead_sightings?.length).toBe(1)
    expect(db.tables).not.toContain('persons')
  })
})
