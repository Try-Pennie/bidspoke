/**
 * Reconstruct a lost lead_sightings row at finalize (#686).
 *
 * The trigger-boundary insertSighting can fail in the same window the execution
 * insert does (a schema-cache 503 during the nightly purge, a partition-purge
 * lock), and finalizeSighting then UPDATEs a row that does not exist and reports
 * the miss (#583) without recovering it. The lost row makes a served lead
 * invisible in the Snowflake repeat-lead and bid-outcome reporting that reads
 * lead_sightings. Mirroring #584/#629 for the execution row, finalize now rebuilds
 * the missing sighting row, finalized, from the same insert fields.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { finalizeSighting, type FinalizeSightingInput, type SightingInsert } from '../lead-sightings'

// Per-table control: how many rows each UPDATE matched, and whether an insert
// errors. Records the rows inserted per table so the reconstruction is checkable.
function makeSupabase(opts: {
  updateRows?: Record<string, unknown[]>
  // Rows the UPDATE matches AFTER an insert has run on that table (the row that
  // landed late in the concurrent-landing branch). Falls back to updateRows.
  updateRowsAfterInsert?: Record<string, unknown[]>
  insertError?: Record<string, { code?: string; message?: string }>
}) {
  const inserted: Record<string, unknown[]> = {}
  const tablesUpdated: string[] = []
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {
        update() {
          tablesUpdated.push(table)
          return chain
        },
        eq() { return chain },
        gte() { return chain },
        select() {
          const rows = inserted[table]?.length && opts.updateRowsAfterInsert?.[table]
            ? opts.updateRowsAfterInsert[table]
            : (opts.updateRows?.[table] ?? [])
          return Promise.resolve({ data: rows, error: null })
        },
        insert(row: unknown) {
          ;(inserted[table] ??= []).push(row)
          return Promise.resolve({ error: opts.insertError?.[table] ?? null })
        },
      }
      return chain
    },
  }
  return { client: client as unknown as SupabaseClient, inserted, tablesUpdated }
}

function baseInput(overrides: Partial<FinalizeSightingInput> = {}): FinalizeSightingInput {
  return {
    sighting_id: 'sight-1',
    execution_id: 'exec-1',
    execution_started_at_utc: new Date('2026-06-12T08:59:59Z'),
    execution_finished_at_et: new Date('2026-06-12T05:00:01-04:00'),
    execution_ended_at_utc: new Date('2026-06-12T09:00:01Z'),
    duration_ms: 2000,
    ...overrides,
  }
}

function reconstructFields(overrides: Partial<SightingInsert> = {}): SightingInsert {
  return {
    id: 'sight-1',
    trace_id: 'trace-1',
    execution_id: 'exec-1',
    workflow_id: 'wf-1',
    workflow_version_id: 'v1',
    source_name: 'engine',
    is_test: false,
    execution_started_at_utc: new Date('2026-06-12T08:59:59Z'),
    execution_started_at_et: new Date('2026-06-12T04:59:59-04:00'),
    payload_fields: { lead_uuid: 'lead-123' },
    ssn: '123-45-6789',
    person_id: null,
    ...overrides,
  }
}

let errSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => vi.restoreAllMocks())
const logged = () => errSpy.mock.calls.map((c: unknown[]) => c.map(String).join(' ')).join('\n')

describe('finalizeSighting reconstruction (#686)', () => {
  it('rebuilds the missing sighting row, finalized, when the UPDATE matched zero rows and reconstruct fields are given', async () => {
    const { client, inserted } = makeSupabase({ updateRows: { lead_sightings: [] } })

    await finalizeSighting(client, baseInput({ winning_partner_slug: 'tripoint', winning_bid_cents: 5000 }), undefined, reconstructFields())

    expect(inserted.lead_sightings).toHaveLength(1)
    const row = inserted.lead_sightings[0] as Record<string, unknown>
    // Carries the insert fields...
    expect(row).toMatchObject({
      id: 'sight-1',
      trace_id: 'trace-1',
      execution_id: 'exec-1',
      workflow_id: 'wf-1',
      source_name: 'engine',
      lead_uuid: 'lead-123',
      ssn: '123-45-6789',
    })
    // ...and is inserted already finalized, not in_flight.
    expect(row.outcome_state).toBe('finalized')
    expect(row.winning_partner_slug).toBe('tripoint')
  })

  it('does not report the zero-row match as a loss once it has been reconstructed', async () => {
    const { client, inserted } = makeSupabase({ updateRows: { lead_sightings: [] } })
    await finalizeSighting(client, baseInput(), undefined, reconstructFields())
    // The reconstruction actually happened (not a vacuous absence-of-log pass).
    expect(inserted.lead_sightings).toHaveLength(1)
    expect(logged()).not.toContain('matched zero rows')
  })

  it('still reports the miss (no reconstruction) when no reconstruct fields are given', async () => {
    const { client, inserted } = makeSupabase({ updateRows: { lead_sightings: [] } })
    await finalizeSighting(client, baseInput())
    expect(inserted.lead_sightings ?? []).toHaveLength(0)
    expect(logged()).toContain('matched zero rows')
  })

  it('does not insert when the sighting row existed and the UPDATE matched it', async () => {
    const { client, inserted } = makeSupabase({ updateRows: { lead_sightings: [{ id: 'sight-1' }] } })
    await finalizeSighting(client, baseInput(), undefined, reconstructFields())
    expect(inserted.lead_sightings ?? []).toHaveLength(0)
  })

  it('applies the finalize to a row that landed concurrently (reconstruction insert hit a duplicate)', async () => {
    // The original insert committed late: the first UPDATE missed, the rebuild
    // INSERT hits a duplicate, and the re-UPDATE now matches the landed row.
    const { client, inserted } = makeSupabase({
      updateRows: { lead_sightings: [] },
      updateRowsAfterInsert: { lead_sightings: [{ id: 'sight-1' }] },
      insertError: { lead_sightings: { code: '23505', message: 'duplicate key value violates unique constraint' } },
    })
    await finalizeSighting(client, baseInput(), undefined, reconstructFields())
    // It tried the rebuild, found the row present, and did not report a loss.
    expect(inserted.lead_sightings).toHaveLength(1)
    expect(logged()).not.toMatch(/sighting lost|matched zero rows/i)
  })

  it('surfaces a reconstruction insert that itself failed, so the loss is not silent', async () => {
    // A permanent error (not_null_violation) so withDbRetry fails fast rather than
    // retrying the real delays; a transient one would be retried, as designed.
    const { client } = makeSupabase({
      updateRows: { lead_sightings: [] },
      insertError: { lead_sightings: { code: '23502', message: 'null value in column violates not-null constraint' } },
    })
    await finalizeSighting(client, baseInput(), undefined, reconstructFields())
    expect(logged()).toMatch(/reconstruction insert failed|sighting lost/i)
  })
})
