import { describe, it, expect } from 'vitest'
import { scalarsFor, toNtz } from '../scalars'

const execution = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'e1',
  workflow_id: 'wf-1',
  workflow_version_id: 'wv-1',
  status: 'success',
  outcome: 'bid_won',
  source: 'website',
  trace_id: 'trace-1',
  is_test: false,
  started_at: '2026-08-16T11:00:00.123+00:00',
  completed_at: '2026-08-16T11:00:09.456+00:00',
  duration_ms: 9333,
  cost_usd: '0.0031',
  ...over,
})

const ok = (result: ReturnType<typeof scalarsFor>) => {
  if (!result.ok) throw new Error(`expected scalars, got a refusal: ${result.reason}`)
  return result.scalars
}

describe('scalarsFor', () => {
  it('copies the fields the later phases read without decompressing', () => {
    const s = ok(scalarsFor(execution(), 'org-1', null))

    expect(s.organizationId).toBe('org-1')
    expect(s.workflowId).toBe('wf-1')
    expect(s.workflowVersionId).toBe('wv-1')
    expect(s.traceId).toBe('trace-1')
    expect(s.source).toBe('website')
    expect(s.status).toBe('success')
    expect(s.outcome).toBe('bid_won')
    expect(s.isTest).toBe(false)
    expect(s.durationMs).toBe(9333)
  })

  // Postgres returns an offset that Snowflake's TIMESTAMP_NTZ column does not
  // take. Trimming the 'Z' off an offset form leaves '+00:00' in place, which
  // reads as part of the seconds field rather than as a zone.
  it('renders a timestamp with an offset as UTC with no zone marker', () => {
    const s = ok(scalarsFor(execution(), 'org-1', null))

    expect(s.startedAtUtc).toBe('2026-08-16T11:00:00.123')
    expect(s.completedAtUtc).toBe('2026-08-16T11:00:09.456')
  })

  it('converts a non-UTC offset to UTC rather than dropping the zone', () => {
    const s = ok(scalarsFor(execution({ started_at: '2026-08-16T07:00:00.000-04:00' }), 'org-1', null))

    expect(s.startedAtUtc).toBe('2026-08-16T11:00:00.000')
  })

  // PostgREST returns NUMERIC as a string, so cost_usd is a string in
  // production and a number in every hand-written fixture. Reading only the
  // number form writes NULL for every real row while every test passes (L50).
  it('reads a numeric that arrived as a string, which is how Postgres sends it', () => {
    expect(ok(scalarsFor(execution({ cost_usd: '0.0031' }), 'org-1', null)).costUsd).toBe(0.0031)
    expect(ok(scalarsFor(execution({ cost_usd: 0.0031 }), 'org-1', null)).costUsd).toBe(0.0031)
  })

  // Passed in rather than derived here, so this suite has to prove the value it
  // is handed reaches the row. Without this the parameter is inert in every
  // test that supplies null, which is all of them (#927).
  it('carries the person resolver it was handed onto the row', () => {
    const digest = 'b'.repeat(64)
    const s = ok(scalarsFor(execution({}), 'org-1', digest))

    expect(s.ssnHash).toBe(digest)
  })

  it('leaves a genuinely absent value null rather than inventing a zero', () => {
    const s = ok(scalarsFor(execution({ cost_usd: null, completed_at: null, trace_id: null }), 'org-1', null))

    expect(s.costUsd).toBeNull()
    expect(s.completedAtUtc).toBeNull()
    expect(s.traceId).toBeNull()
  })

  it('reads an unparseable timestamp as absent rather than passing it through', () => {
    expect(ok(scalarsFor(execution({ completed_at: 'not a date' }), 'org-1', null)).completedAtUtc).toBeNull()
  })

  describe('refuses, rather than writing an empty string, when a required column has no value', () => {
    // These three are NOT NULL on the archive table. A refusal by id here is a
    // recorded outcome; the same row reaching the send would fail its whole
    // batch and stall the watermark on an hour that could never pass.
    it('has no organization', () => {
      const r = scalarsFor(execution(), undefined, null)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/organization id/)
    })

    it('has an empty organization, which is not the same as having one', () => {
      const r = scalarsFor(execution(), '', null)
      expect(r.ok).toBe(false)
    })

    it('has no workflow', () => {
      const r = scalarsFor(execution({ workflow_id: null }), 'org-1', null)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/workflow id/)
    })

    it('has no readable start', () => {
      const r = scalarsFor(execution({ started_at: 'nonsense' }), 'org-1', null)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/started_at/)
    })

    it('names the execution, so the refusal points at a row someone can look up', () => {
      const r = scalarsFor(execution({ id: 'e-42', workflow_id: null }), 'org-1', null)
      if (!r.ok) expect(r.reason).toContain('e-42')
    })
  })
})

describe('toNtz', () => {
  it('reads a missing value as absent rather than as the epoch', () => {
    expect(toNtz(null)).toBeNull()
    expect(toNtz(undefined)).toBeNull()
    expect(toNtz('')).toBeNull()
  })
})
