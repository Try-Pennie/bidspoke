/**
 * Zero-row finalize writes on lead_sightings / lead_sighting_bids (#583).
 *
 * PostgREST answers an UPDATE that matched nothing with `{ data: [], error: null }`.
 * Both finalize writes only checked `error`, so a write against a row that does
 * not exist reported success:
 *
 *   - the sighting UPDATE silently leaves the sighting stuck at 'in_flight',
 *   - the winner UPDATE silently leaves is_winner=false forever, which is the
 *     exact failure engine/index.ts already warns about in prose ("if it ran
 *     before an insert committed it would match zero rows and leave the winner
 *     is_winner=false forever") without ever checking for it.
 *
 * Both now report the miss, which dead-letters when outcome deps are supplied.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { finalizeSighting, type FinalizeSightingInput } from '../lead-sightings'

// Per-table control over how many rows each UPDATE ... .select('id') matched.
function makeSupabase(rowsByTable: Record<string, unknown[]>) {
  const tablesUpdated: string[] = []
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {
        update() {
          tablesUpdated.push(table)
          return chain
        },
        eq() {
          return chain
        },
        select() {
          return Promise.resolve({ data: rowsByTable[table] ?? [], error: null })
        },
      }
      return chain
    },
  }
  return { client: client as unknown as SupabaseClient, tablesUpdated }
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

const ONE_ROW = [{ id: 'r-1' }]

let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

const logged = () => errSpy.mock.calls.map((c: unknown[]) => c.map(String).join(' ')).join('\n')

describe('finalizeSighting: sighting UPDATE matched zero rows (#583)', () => {
  it('reports the miss instead of returning as though the sighting was finalized', async () => {
    const { client } = makeSupabase({ lead_sightings: [] })
    await finalizeSighting(client, baseInput({ winning_partner_slug: 'tripoint' }))
    expect(logged()).toContain('matched zero rows')
  })

  it('does not attempt the winner mark once the sighting row is known missing', async () => {
    const { client, tablesUpdated } = makeSupabase({ lead_sightings: [] })
    await finalizeSighting(client, baseInput({ winning_partner_slug: 'tripoint' }))
    expect(tablesUpdated).not.toContain('lead_sighting_bids')
  })
})

describe('finalizeSighting: winner UPDATE matched zero rows (#583)', () => {
  it('reports the miss rather than leaving is_winner=false forever', async () => {
    const { client } = makeSupabase({ lead_sightings: ONE_ROW, lead_sighting_bids: [] })
    await finalizeSighting(client, baseInput({ winning_partner_slug: 'tripoint', winning_bid_cents: 5000 }))
    expect(logged()).toContain('lead_sighting_bids.winner')
  })

  it('names the partner slug so the miss is diagnosable', async () => {
    const { client } = makeSupabase({ lead_sightings: ONE_ROW, lead_sighting_bids: [] })
    await finalizeSighting(client, baseInput({ winning_partner_slug: 'tripoint', winning_bid_cents: 5000 }))
    expect(logged()).toContain('tripoint')
  })
})

describe('finalizeSighting: rows matched (#583 regression guards)', () => {
  it('stays silent when both writes touch a row', async () => {
    const { client } = makeSupabase({ lead_sightings: ONE_ROW, lead_sighting_bids: ONE_ROW })
    await finalizeSighting(client, baseInput({ winning_partner_slug: 'tripoint', winning_bid_cents: 5000 }))
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('stays silent and skips the winner mark when there is no winner', async () => {
    const { client, tablesUpdated } = makeSupabase({ lead_sightings: ONE_ROW })
    await finalizeSighting(client, baseInput({ winning_partner_slug: null }))
    expect(errSpy).not.toHaveBeenCalled()
    expect(tablesUpdated).not.toContain('lead_sighting_bids')
  })
})
