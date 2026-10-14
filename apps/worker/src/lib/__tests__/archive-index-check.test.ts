/**
 * The daily read-back of the index the archive depends on (#1044).
 *
 * The function it calls returns ONE ROW ALWAYS, so a missing index arrives as a
 * row saying so rather than as no rows. Verified against production on
 * 2026-09-10 both ways: the real index reports present, valid, 56 partitions,
 * 56 attached, and a deliberately wrong index name reports present false with
 * attached zero.
 *
 * What is tested here is what the check does with those readings, including the
 * case the database function cannot deliver at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../export-alerts', () => ({ notifyExportFailure: vi.fn(async () => undefined) }))

import { notifyExportFailure } from '../export-alerts'
import { checkArchiveIndex, ARCHIVE_INDEX_JOB } from '../archive-index-check'

const HEALTHY = [{
  index_name: 'idx_exec_steps_execution_started',
  index_present: true,
  index_valid: true,
  partitions: 56,
  attached: 56,
}]

function supabaseDouble(rpc: { data?: unknown; error?: unknown }) {
  const jobRuns: Record<string, unknown> = {
    insert() { return jobRuns },
    update() { return jobRuns },
    eq() { return jobRuns },
    select() { return jobRuns },
    single() { return Promise.resolve({ data: { id: 'run-1' }, error: null }) },
    then(res: (v: unknown) => unknown) { return Promise.resolve({ data: [{ id: 'run-1' }], error: null }).then(res) },
  }
  return {
    from: () => jobRuns,
    rpc: async () => ({ data: rpc.data ?? null, error: rpc.error ?? null }),
  } as unknown as SupabaseClient
}

const kv = {
  get: async () => null,
  put: async () => {},
  delete: async () => {},
}

function raised(): string[] {
  return vi
    .mocked(notifyExportFailure)
    .mock.calls.filter((c) => c[1] === ARCHIVE_INDEX_JOB)
    .flatMap((c) => c[2] as string[])
}

beforeEach(() => vi.mocked(notifyExportFailure).mockClear())

describe('checkArchiveIndex', () => {
  it('raises nothing when the index is intact', async () => {
    const result = await checkArchiveIndex(supabaseDouble({ data: HEALTHY }), kv)

    expect(result.findings).toEqual([])
    expect(result.alerted).toBe(false)
    // Called with an empty list, which is how the alerter CLEARS a standing
    // alert. Not calling at all would leave a resolved fault reported for ever.
    expect(raised()).toEqual([])
    expect(vi.mocked(notifyExportFailure)).toHaveBeenCalled()
  })

  it('alerts, naming what it costs, when the index is gone', async () => {
    const result = await checkArchiveIndex(
      supabaseDouble({ data: [{ ...HEALTHY[0], index_present: false, index_valid: false, attached: 0 }] }),
      kv,
    )

    expect(result.alerted).toBe(true)
    expect(raised()[0]).toMatch(/is gone from execution_steps/)
  })

  it('alerts when partitions are short of the index, and says how many', async () => {
    await checkArchiveIndex(supabaseDouble({ data: [{ ...HEALTHY[0], attached: 50 }] }), kv)

    expect(raised()[0]).toContain('6 of 56')
  })

  it('reports a failed read as a finding rather than as health', async () => {
    // The whole point: a check that could not look has established nothing, and
    // silence there is what makes an unverified guarantee look verified (L98).
    const result = await checkArchiveIndex(supabaseDouble({ error: { message: 'permission denied' } }), kv)

    expect(result.reading).toBeNull()
    expect(result.findings.map((f) => f.code)).toEqual(['unreadable'])
    expect(result.alerted).toBe(true)
  })

  it('treats no row from a function that always returns one as a fault', async () => {
    // An empty result here is not an intact index, it is the reading failing in
    // a way that looks like success.
    const result = await checkArchiveIndex(supabaseDouble({ data: [] }), kv)

    expect(result.findings.map((f) => f.code)).toEqual(['unreadable'])
  })

  it('reports a count it cannot read as unreadable, not as an intact index', async () => {
    // Number() on an unexpected value gives NaN, and `attached < NaN` is false,
    // so a misshapen reading would produce no findings and read as healthy.
    // That is the permissive side, which is the one direction this must never
    // fail towards (L50).
    const result = await checkArchiveIndex(
      supabaseDouble({ data: [{ ...HEALTHY[0], attached: 'not a number' }] }),
      kv,
    )

    expect(result.reading).toBeNull()
    expect(result.findings.map((f) => f.code)).toEqual(['unreadable'])
  })

  it('accepts a count that arrives as a numeric string, which is how the driver sends bigints', async () => {
    const result = await checkArchiveIndex(
      supabaseDouble({ data: [{ ...HEALTHY[0], partitions: '56', attached: '56' }] }),
      kv,
    )

    expect(result.findings).toEqual([])
    expect(result.reading?.partitions).toBe(56)
  })

  it('does not print [object Object] when the row shape is not what was expected', async () => {
    const result = await checkArchiveIndex(
      supabaseDouble({ data: [{ ...HEALTHY[0], index_name: { nested: true }, attached: 0 }] }),
      kv,
    )

    expect(JSON.stringify(result.findings)).not.toContain('object Object')
  })
})

/**
 * #835: an unreadable reading used to arrive under "that index is no longer
 * intact on every partition" with the error only logged, and the fix told the
 * reader to reattach "the partitions listed" when no partition is ever listed.
 */
describe('the index alert says what it measured', () => {
  const remedySent = () =>
    vi.mocked(notifyExportFailure).mock.calls.find((c) => c[1] === ARCHIVE_INDEX_JOB && (c[2] as string[]).length > 0)?.[4] as {
      consequence: string
      fixHint: string
      headlineVerb?: string
    }

  it('puts the read error in the finding, and does not call the index broken', async () => {
    await checkArchiveIndex(supabaseDouble({ error: { message: 'permission denied for function' } }), kv)
    expect(raised()[0]).toMatch(/permission denied for function/)
    expect(remedySent().consequence).not.toMatch(/no longer intact/)
    expect(remedySent().headlineVerb ?? '').not.toMatch(/not intact/)
  })

  it('names the unindexed partitions by count, not as a list it never gives', async () => {
    await checkArchiveIndex(supabaseDouble({ data: [{ ...HEALTHY[0], attached: 50 }] }), kv)
    expect(remedySent().fixHint).not.toMatch(/partitions listed/)
    expect(remedySent().consequence).toMatch(/no longer intact/)
  })
})
