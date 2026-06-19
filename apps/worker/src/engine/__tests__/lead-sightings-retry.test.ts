/**
 * Transient-retry hardening for the lead-sightings writes (#237).
 *
 * The nightly partition purge forces a PostgREST schema-cache reload (PGRST002
 * 503) that previously dropped lead_sightings / lead_sighting_bids rows because
 * these writes had no retry. They now go through withDbRetry, the same
 * classification the execution log uses: transient errors are retried, permanent
 * ones fail fast.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  insertSighting,
  recordBidAttempt,
  finalizeSighting,
  type SightingInsert,
  type BidAttemptInsert,
  type FinalizeSightingInput,
} from '../lead-sightings'

afterEach(() => {
  vi.useRealTimers()
})

const SCHEMA_CACHE_503 = { code: 'PGRST002', message: 'Could not query the database for the schema cache.' }
const NOT_NULL = { code: '23502', message: 'null value in column violates not-null constraint' }

// A supabase stub whose insert/update resolves to a scripted sequence of
// `{ error }` results — one per call — so a test can model "fail twice, then
// succeed". Counts calls per table.
function scriptedSupabase(script: { insert?: Array<{ error: unknown }>; update?: Array<{ error: unknown }> }) {
  const calls = { insert: 0, update: 0 }
  const next = (kind: 'insert' | 'update') => {
    const seq = script[kind] ?? [{ error: null }]
    const i = Math.min(calls[kind], seq.length - 1)
    calls[kind]++
    return Promise.resolve(seq[i])
  }
  const client = {
    from() {
      const chain: Record<string, unknown> = {
        insert: () => next('insert'),
        update: () => chain,
        eq: () => chain,
        then: (resolve: (v: unknown) => unknown) => next('update').then(resolve),
      }
      return chain
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

function sightingInput(): SightingInsert {
  return {
    id: 'sight-1',
    trace_id: 'trace-1',
    execution_id: 'exec-1',
    workflow_id: 'wf-1',
    is_test: false,
    execution_started_at_utc: new Date('2026-06-19T03:30:00Z'),
    execution_started_at_et: new Date('2026-06-18T23:30:00-04:00'),
    payload_fields: {},
  }
}

function bidInput(): BidAttemptInsert {
  return {
    sighting_id: 'sight-1',
    trace_id: 'trace-1',
    execution_id: 'exec-1',
    partner_slug: 'tripoint',
    attempted_at_utc: new Date('2026-06-19T03:30:00Z'),
    attempted_at_et: new Date('2026-06-18T23:30:00-04:00'),
    is_test: false,
  }
}

function finalizeInput(): FinalizeSightingInput {
  return {
    sighting_id: 'sight-1',
    execution_id: 'exec-1',
    execution_started_at_utc: new Date('2026-06-19T03:30:00Z'),
    execution_finished_at_et: new Date('2026-06-18T23:30:01-04:00'),
    execution_ended_at_utc: new Date('2026-06-19T03:30:01Z'),
    duration_ms: 1000,
  }
}

describe('insertSighting — transient retry', () => {
  it('retries a schema-cache 503 and returns the id once the write lands', async () => {
    vi.useFakeTimers()
    const { client, calls } = scriptedSupabase({
      insert: [{ error: SCHEMA_CACHE_503 }, { error: SCHEMA_CACHE_503 }, { error: null }],
    })
    const p = insertSighting(client, sightingInput())
    await vi.runAllTimersAsync()
    expect(await p).toBe('sight-1')
    expect(calls.insert).toBe(3)
  })

  it('does not retry a permanent error and returns null', async () => {
    const { client, calls } = scriptedSupabase({ insert: [{ error: NOT_NULL }] })
    expect(await insertSighting(client, sightingInput())).toBeNull()
    expect(calls.insert).toBe(1)
  })
})

describe('recordBidAttempt — transient retry', () => {
  it('retries a schema-cache 503 until the bid row lands', async () => {
    vi.useFakeTimers()
    const { client, calls } = scriptedSupabase({
      insert: [{ error: SCHEMA_CACHE_503 }, { error: null }],
    })
    const p = recordBidAttempt(client, bidInput())
    await vi.runAllTimersAsync()
    await p
    expect(calls.insert).toBe(2)
  })
})

describe('finalizeSighting — transient retry', () => {
  it('retries a schema-cache 503 on the sighting update', async () => {
    vi.useFakeTimers()
    const { client, calls } = scriptedSupabase({
      update: [{ error: SCHEMA_CACHE_503 }, { error: null }],
    })
    const p = finalizeSighting(client, finalizeInput())
    await vi.runAllTimersAsync()
    await p
    expect(calls.update).toBe(2)
  })
})
