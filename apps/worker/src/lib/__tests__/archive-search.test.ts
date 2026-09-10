/**
 * Finding an archived run when you have no link (#874, Phase A6
 * discoverability).
 *
 * THE COVERAGE IS THE FEATURE, not a footnote. The SSN route resolves through
 * LEAD_SIGHTINGS, and until 2026-08-19 a workflow could opt out of recording
 * them; Main Flow, which carries the Equifax credit report, was opted out. The
 * archive holds thirteen months, so a large part of it predates the fix and an
 * SSN cannot reach those runs at all.
 *
 * The caveat names a DATE, never a list of workflows. The per-workflow opt-out
 * is retired and survives only as an inert column holding stale values, so
 * naming workflows from it would resurrect it and accuse flows that do record
 * sightings today. `capture-sightings-unwritable.test.ts` in the web guards is
 * what enforces that nothing reads the column; it is not repeated here.
 *
 * "No results" and "no results, and here is what this search cannot see" are
 * different answers, and only the second one is true (L92, L98). Every test
 * below that returns nothing also asserts the caveat is present, because the
 * empty case is exactly where the omission does its damage.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { searchArchive, SIGHTINGS_COMPLETE_FROM, type ArchiveReadDeps } from '../archive-read'
import type { Env } from '../../index'
import type { SnowflakeStatementResponse } from '../snowflake'

const ORG = '00000000-0000-4000-8000-00000000000a'
const READER = '00000000-0000-4000-8000-00000000000c'
const env = {
  ARCHIVE_READER_USER: 'reader',
  ARCHIVE_READER_PRIVATE_KEY: 'key',
  SNOWFLAKE_ACCOUNT: 'acct',
  SNOWFLAKE_WAREHOUSE: 'wh',
} as unknown as Env

interface Audited { entityType: string; action: string; changes?: Record<string, unknown> }

/** Answers the blind-workflow lookup from the workflows table, as the real one does. */
function supabaseDouble(blindNames: string[], failLookup = false) {
  return {
    from() {
      const chain: Record<string, unknown> = {
        select() { return chain },
        eq() { return chain },
        is() { return chain },
        order() { return chain },
        then(res: (v: unknown) => unknown) {
          return Promise.resolve({
            data: failLookup ? null : blindNames.map((name) => ({ name })),
            error: failLookup ? { message: 'statement timeout' } : null,
          }).then(res)
        },
      }
      return chain
    },
  } as unknown as SupabaseClient
}

function makeDeps(responses: unknown[][][]): {
  deps: ArchiveReadDeps
  statements: Array<{ sql: string; bindings: unknown[] }>
  audits: Audited[]
} {
  const statements: Array<{ sql: string; bindings: unknown[] }> = []
  const audits: Audited[] = []
  let call = 0
  return {
    statements,
    audits,
    deps: {
      execute: async (_c, sql, bindings) => {
        statements.push({ sql, bindings: bindings ?? [] })
        const rows = responses[call] ?? []
        call += 1
        return { data: rows } as SnowflakeStatementResponse
      },
      sleep: () => new Promise<void>(() => {}),
      writeAudit: async (_s, _o, entityType, _id, action, _by, changes) => {
        audits.push({ entityType, action, changes })
      },
    },
  }
}

const ROW = ['exec-1', 'wf-1', '2026-03-04', '2026-03-04T09:00:00', 'completed', 'bid_won', 'website_form']

describe('searchArchive by trace id', () => {
  it('returns the runs carrying that trace id', async () => {
    const { deps } = makeDeps([[ROW]])

    const result = await searchArchive(
      env, supabaseDouble([]), { traceId: 'trace-abc', orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({ execution_id: 'exec-1', workflow_id: 'wf-1' })
  })

  it('reports complete coverage, because every archived run carries its trace id', async () => {
    const { deps } = makeDeps([[]])

    const result = await searchArchive(
      env, supabaseDouble(['Main Flow']), { traceId: 'trace-abc', orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    // A trace id is on every archived row, so this search has no blind spot and
    // a caveat here would be a warning about nothing.
    expect(result.coverage.complete).toBe(true)
    expect(result.coverage.note).toBeNull()
  })

  it('binds the trace id and scopes to the organization', async () => {
    const { deps, statements } = makeDeps([[]])

    await searchArchive(
      env, supabaseDouble([]), { traceId: "trace' OR 1=1--", orgId: ORG, readBy: READER }, deps
    )

    expect(statements[0].sql).toContain('organization_id = ?')
    expect(statements[0].bindings).toEqual(["trace' OR 1=1--", ORG])
  })
})

describe('searchArchive by SSN', () => {
  it('resolves execution ids through the sightings table, then reads those runs', async () => {
    const { deps, statements } = makeDeps([[['exec-1']], [ROW]])

    const result = await searchArchive(
      env, supabaseDouble(['Main Flow']), { ssn: '123-45-6789', orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.results).toHaveLength(1)
    expect(statements[0].sql).toContain('LEAD_SIGHTINGS')
    expect(statements[0].bindings[0]).toBe('123-45-6789')
  })

  it('states the date its coverage begins, because older runs may record nothing', async () => {
    const { deps } = makeDeps([[['exec-1']], [ROW]])

    const result = await searchArchive(
      env, supabaseDouble([]), { ssn: '123-45-6789', orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.coverage.complete).toBe(false)
    expect(result.coverage.completeFrom).toBe(SIGHTINGS_COMPLETE_FROM)
    expect(result.coverage.note).toContain(SIGHTINGS_COMPLETE_FROM)
  })

  it('states the gap even when it finds nothing, which is where it matters most', async () => {
    // Nothing found. Without the caveat this reads as "we never saw this
    // person", and for a Main Flow lead that is false (L92, L98).
    const { deps } = makeDeps([[]])

    const result = await searchArchive(
      env, supabaseDouble(['Main Flow']), { ssn: '123-45-6789', orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.results).toEqual([])
    expect(result.coverage.complete).toBe(false)
    expect(result.coverage.note).toContain(SIGHTINGS_COMPLETE_FROM)
  })

  it('never puts the SSN itself in the audit row', async () => {
    const { deps, audits } = makeDeps([[['exec-1']], [ROW]])

    await searchArchive(
      env, supabaseDouble([]), { ssn: '123-45-6789', orgId: ORG, readBy: READER }, deps
    )

    expect(audits).toHaveLength(1)
    expect(audits[0].action).toBe('archive_searched')
    // The point of the audit row is that a search HAPPENED. Writing the
    // identity into it would copy the PII into a second, longer lived place.
    expect(JSON.stringify(audits[0])).not.toContain('123-45-6789')
    expect(audits[0].changes?.by).toBe('ssn')
  })
})

describe('searchArchive refusals', () => {
  it('refuses a search with no term rather than returning everything', async () => {
    const { deps, statements } = makeDeps([[ROW]])

    const result = await searchArchive(
      env, supabaseDouble([]), { orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('refused')
    expect(statements).toHaveLength(0)
  })

  it('reports unavailable rather than an empty result when the archive fails', async () => {
    const deps: ArchiveReadDeps = {
      execute: async () => { throw new Error('warehouse suspended') },
      sleep: () => new Promise<void>(() => {}),
      writeAudit: async () => {},
    }

    const result = await searchArchive(
      env, supabaseDouble([]), { traceId: 'trace-abc', orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('unavailable')
  })
})
