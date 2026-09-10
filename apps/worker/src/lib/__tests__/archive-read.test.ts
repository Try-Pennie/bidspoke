/**
 * Reading one archived execution back out of Snowflake (#874, Phase A6).
 *
 * Drives the real `readArchivedExecution` against a recording Snowflake double,
 * so what is asserted is the statement it actually issued and the outcome it
 * reported, not which functions ran.
 *
 * The outcomes this phase requires a test for, each produced here: found;
 * a foreign organization; no such execution; the read exceeding its deadline;
 * and a non-v7 id, which cannot be pruned by day and must still be found.
 *
 * The deadline is driven through an injected sleep rather than a real timer, so
 * the expiry case is instant (L524).
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  readArchivedExecution,
  ARCHIVE_READ_WAITING_FOR,
  type ArchiveReadDeps,
} from '../archive-read'
import type { Env } from '../../index'
import type { SnowflakeStatementResponse } from '../snowflake'
import { encodeBundle } from '../../archive/bundle'

// A v7 id whose own timestamp is 2026-09-01T12:00:00Z, so the day it prunes to
// is stated here rather than derived by the code under test.
const EXECUTION_ID = '01a05cd7-2a00-7000-8000-000000000001'
const EXECUTION_DAY = '2026-09-01'
const DAY_BEFORE = '2026-08-31'
const DAY_AFTER = '2026-09-02'

// A v4 id. Real executions minted before the v7 cutover carry these, and they
// carry no timestamp, so no day can be derived from them.
const NON_V7_ID = 'a39376f1-0063-4b04-a1f7-0c0f42962ae6'

const ORG = '00000000-0000-4000-8000-00000000000a'
const OTHER_ORG = '00000000-0000-4000-8000-00000000000b'
const READER = '00000000-0000-4000-8000-00000000000c'

const env = {
  ARCHIVE_READER_USER: 'reader',
  ARCHIVE_READER_PRIVATE_KEY: 'key',
  SNOWFLAKE_ACCOUNT: 'acct',
  SNOWFLAKE_WAREHOUSE: 'wh',
} as unknown as Env

interface Audited {
  orgId: string
  entityType: string
  entityId: string
  action: string
  changedBy: string
  changes?: Record<string, unknown>
}

async function archivedRow(opts: {
  organizationId?: string
  archiveDay?: string
  incomplete?: boolean
  steps?: unknown[]
} = {}) {
  const execution = { id: EXECUTION_ID, status: 'completed', workflow_id: 'wf-1' }
  const steps = opts.steps ?? [{ id: 'step-1', step_namespace: 'validate', step_order: 0 }]
  const encoded = await encodeBundle({ execution, steps })
  return [
    opts.organizationId ?? ORG,
    opts.archiveDay ?? EXECUTION_DAY,
    // Snowflake's SQL API answers every cell as a string, booleans included, so
    // the fixture says "false" rather than false. Writing the JS boolean here
    // would have left the branch that actually runs in production untested
    // (L52).
    String(opts.incomplete ?? false),
    encoded.wire,
  ]
}

/**
 * Records every statement and its bindings, and answers with the rows given.
 *
 * `never` is the query that does not resolve, which is what the deadline case
 * needs: a read that hangs, not one that fails.
 */
function makeDeps(opts: {
  rows?: unknown[][]
  never?: boolean
  expire?: boolean
}): { deps: ArchiveReadDeps; statements: Array<{ sql: string; bindings: unknown[] }>; audits: Audited[] } {
  const statements: Array<{ sql: string; bindings: unknown[] }> = []
  const audits: Audited[] = []
  const deps: ArchiveReadDeps = {
    execute: async (_config, sql, bindings) => {
      statements.push({ sql, bindings: bindings ?? [] })
      if (opts.never) return new Promise<SnowflakeStatementResponse>(() => {})
      return { data: opts.rows ?? [] } as SnowflakeStatementResponse
    },
    // Resolves at once when the case under test is an expiry, and never
    // otherwise, so no test waits on a real clock in either direction.
    sleep: () => (opts.expire ? Promise.resolve() : new Promise<void>(() => {})),
    writeAudit: async (_supabase, orgId, entityType, entityId, action, changedBy, changes) => {
      audits.push({ orgId, entityType, entityId, action, changedBy, changes })
    },
  }
  return { deps, statements, audits }
}

const supabase = {} as unknown as SupabaseClient

describe('readArchivedExecution', () => {
  it('finds an archived execution and returns its bundle', async () => {
    const { deps } = makeDeps({ rows: [await archivedRow()] })

    const result = await readArchivedExecution(
      env, supabase, { executionId: EXECUTION_ID, orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('found')
    if (result.kind !== 'found') return
    expect(result.execution).toMatchObject({ id: EXECUTION_ID, status: 'completed' })
    expect(result.steps).toHaveLength(1)
    expect(result.archiveDay).toBe(EXECUTION_DAY)
    expect(result.archivedIncomplete).toBe(false)
  })

  it('prunes to the id’s own day and the day either side, so a midnight execution is still found', async () => {
    const { deps, statements } = makeDeps({ rows: [await archivedRow()] })

    await readArchivedExecution(
      env, supabase, { executionId: EXECUTION_ID, orgId: ORG, readBy: READER }, deps
    )

    expect(statements).toHaveLength(1)
    // The days are BOUND, never interpolated, so this also holds the read to
    // the binding contract from the start (#1006).
    expect(statements[0].sql).toContain('archive_day IN')
    expect(statements[0].bindings).toEqual([DAY_BEFORE, EXECUTION_DAY, DAY_AFTER, EXECUTION_ID])
  })

  it('falls back to an unpruned lookup when the id carries no day', async () => {
    const { deps, statements } = makeDeps({
      rows: [await archivedRow({ archiveDay: '2025-11-04' })],
    })

    const result = await readArchivedExecution(
      env, supabase, { executionId: NON_V7_ID, orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('found')
    expect(statements[0].sql).not.toContain('archive_day IN')
    expect(statements[0].bindings).toEqual([NON_V7_ID])
  })

  it('answers not-found for another organization’s execution, leaking no shape', async () => {
    const { deps, audits } = makeDeps({
      rows: [await archivedRow({ organizationId: OTHER_ORG })],
    })

    const result = await readArchivedExecution(
      env, supabase, { executionId: EXECUTION_ID, orgId: ORG, readBy: READER }, deps
    )

    expect(result).toEqual({ kind: 'not-found' })
    // A refused read is not an archived read, so it must not appear in the
    // audit trail as one.
    expect(audits).toHaveLength(0)
  })

  it('answers not-found when the archive holds no such execution', async () => {
    const { deps } = makeDeps({ rows: [] })

    const result = await readArchivedExecution(
      env, supabase, { executionId: EXECUTION_ID, orgId: ORG, readBy: READER }, deps
    )

    expect(result).toEqual({ kind: 'not-found' })
  })

  it('reports unavailable, naming what it waited for, rather than not-found when the deadline expires', async () => {
    const { deps } = makeDeps({ never: true, expire: true })

    const result = await readArchivedExecution(
      env, supabase, { executionId: EXECUTION_ID, orgId: ORG, readBy: READER, deadlineMs: 20_000 }, deps
    )

    // Collapsing this into not-found would tell an operator a lead never ran
    // when it did.
    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') return
    expect(result.waitingFor).toBe(ARCHIVE_READ_WAITING_FOR)
    // Stated in the operator's units, because this sentence is rendered on the
    // execution page rather than written to a log.
    expect(result.detail).toContain('20 seconds')
    expect(result.detail).not.toContain('20000')
  })

  it('reports unavailable when the archive query itself fails', async () => {
    const deps: ArchiveReadDeps = {
      execute: async () => { throw new Error('warehouse suspended') },
      sleep: () => new Promise<void>(() => {}),
      writeAudit: async () => {},
    }

    const result = await readArchivedExecution(
      env, supabase, { executionId: EXECUTION_ID, orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') return
    expect(result.detail).toContain('warehouse suspended')
  })

  it('writes one audit row naming the execution that was read', async () => {
    const { deps, audits } = makeDeps({ rows: [await archivedRow()] })

    await readArchivedExecution(
      env, supabase, { executionId: EXECUTION_ID, orgId: ORG, readBy: READER }, deps
    )

    expect(audits).toEqual([
      {
        orgId: ORG,
        entityType: 'execution_archive',
        entityId: EXECUTION_ID,
        action: 'archived_execution_read',
        changedBy: READER,
        changes: { archive_day: EXECUTION_DAY },
      },
    ])
  })

  it('surfaces archived_incomplete so the page can say the run was still going', async () => {
    const { deps } = makeDeps({ rows: [await archivedRow({ incomplete: true })] })

    const result = await readArchivedExecution(
      env, supabase, { executionId: EXECUTION_ID, orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('found')
    if (result.kind !== 'found') return
    expect(result.archivedIncomplete).toBe(true)
  })

  it('also accepts a real boolean, so a change in how the driver answers cannot silently read as false', async () => {
    const row = await archivedRow()
    const { deps } = makeDeps({ rows: [[row[0], row[1], true, row[3]]] })

    const result = await readArchivedExecution(
      env, supabase, { executionId: EXECUTION_ID, orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('found')
    if (result.kind !== 'found') return
    expect(result.archivedIncomplete).toBe(true)
  })
})
