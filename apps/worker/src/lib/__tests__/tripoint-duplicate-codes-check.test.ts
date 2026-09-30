/**
 * The daily comparison of the live Tripoint duplicate rule against the code list (#1647).
 *
 * Since #1549 the Duplicate result codes live in code (TRIPOINT_DUPLICATE_SIGNALS)
 * and, separately, on the Tripoint partner record, which the buyer_select node
 * reads and anyone can edit on the partner page. This drives the real check
 * against a recording Supabase double, so it sees the alert lines actually sent
 * and the job_runs ending actually written. The live value in the agreeing case
 * is the one read from production on 2026-09-30 (L48).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../export-alerts', () => ({
  notifyExportFailure: vi.fn().mockResolvedValue(undefined),
  notifyExportRecovery: vi.fn().mockResolvedValue(undefined),
}))

import {
  checkTripointDuplicateCodes,
  duplicateCodeDisagreements,
  TRIPOINT_DUPLICATE_CODES_JOB,
  TRIPOINT_DUPLICATE_CODES_REMEDY,
} from '../tripoint-duplicate-codes-check'
import { notifyExportFailure } from '../export-alerts'
import { TRIPOINT_DUPLICATE_RESULT_CODES, TRIPOINT_DUPLICATE_SIGNALS } from '../../engine/bid-resolver'
import type { Env } from '../../index'
import type { SupabaseClient } from '@supabase/supabase-js'

const env = { IDEMPOTENCY: undefined } as unknown as Env

/** partner_configs.duplicate_signals on the live Tripoint record, read 2026-09-30. */
const LIVE_2026_09_30 = [{ in: [1002, 1003, 1004, 1005, 1020], field: 'data.createLead.resultCode' }]

interface Answer {
  data?: unknown
  error?: unknown
}

/** Answers the partner_configs read, and records job_runs opens and closes. */
function supabaseDouble(answer: Answer | (() => never)) {
  const reads: string[] = []
  const endings: Array<Record<string, unknown>> = []
  const client = {
    from: (table: string) => {
      if (table === 'job_runs') {
        return {
          insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'run-1' }, error: null }) }) }),
          update: (row: Record<string, unknown>) => ({
            eq: () => ({
              select: () => {
                endings.push(row)
                return Promise.resolve({ data: [{ id: 'run-1' }], error: null })
              },
            }),
          }),
        }
      }
      if (typeof answer === 'function') answer()
      return {
        select: (cols: string) => ({
          eq: (col: string, value: string) => {
            reads.push(`${table}.${cols}:${col}=${value}`)
            return { maybeSingle: () => Promise.resolve({ data: (answer as Answer).data ?? null, error: (answer as Answer).error ?? null }) }
          },
        }),
      }
    },
  } as unknown as SupabaseClient
  return { client, reads, endings }
}

function alerted(): string[] {
  return vi
    .mocked(notifyExportFailure)
    .mock.calls.filter((c) => c[1] === TRIPOINT_DUPLICATE_CODES_JOB)
    .flatMap((c) => c[2] as string[])
}

beforeEach(() => {
  vi.mocked(notifyExportFailure).mockClear()
})

describe('duplicateCodeDisagreements', () => {
  it('finds nothing when the two rules are the same', () => {
    expect(duplicateCodeDisagreements(TRIPOINT_DUPLICATE_SIGNALS, TRIPOINT_DUPLICATE_SIGNALS)).toEqual([])
  })

  it('names each code the two rules class differently, and what each says', () => {
    const edited = [{ field: 'data.createLead.resultCode', in: [1003, 1004, 1020, 1009] }]
    expect(duplicateCodeDisagreements(edited, TRIPOINT_DUPLICATE_SIGNALS)).toEqual([
      { code: 1002, live: 'Fail', reference: 'Duplicate' },
      { code: 1005, live: 'Fail', reference: 'Duplicate' },
      { code: 1009, live: 'Duplicate', reference: 'Fail' },
    ])
  })

  it('covers a code the live rule names outside the scanned range, rather than only 990 to 1100', () => {
    const edited = [{ field: 'data.createLead.resultCode', in: [...TRIPOINT_DUPLICATE_SIGNALS[0].in, 5000] }]
    expect(duplicateCodeDisagreements(edited, TRIPOINT_DUPLICATE_SIGNALS).map((d) => d.code)).toEqual([5000])
  })

  it('catches a rule pointed at a field Tripoint does not send, which classes every duplicate as Fail', () => {
    const typo = [{ field: 'data.createLead.result_code', in: [1002, 1003, 1004, 1005, 1020] }]
    expect(duplicateCodeDisagreements(typo, TRIPOINT_DUPLICATE_SIGNALS).map((d) => d.code)).toEqual([1002, 1003, 1004, 1005, 1020])
  })
})

describe('checkTripointDuplicateCodes', () => {
  it('agrees on the live value as read on 2026-09-30, and still reports a clean run so a standing alert clears', async () => {
    const db = supabaseDouble({ data: { duplicate_signals: LIVE_2026_09_30 } })

    const r = await checkTripointDuplicateCodes(env, db.client)

    expect(db.reads).toEqual(['partner_configs.duplicate_signals:slug=tripoint'])
    expect(r.outcome).toBe('agree')
    expect(r.disagreements).toEqual([])
    expect(r.alerted).toBe(false)
    expect(vi.mocked(notifyExportFailure)).toHaveBeenCalledTimes(1)
    expect(alerted()).toEqual([])
    expect(db.endings.map((e) => e.outcome)).toEqual(['agree'])
  })

  it('alerts naming every code the live record classes differently from the code list', async () => {
    const db = supabaseDouble({ data: { duplicate_signals: [{ field: 'data.createLead.resultCode', in: [1003, 1004, 1020] }] } })

    const r = await checkTripointDuplicateCodes(env, db.client)

    expect(r.outcome).toBe('disagree')
    expect(r.disagreements.map((d) => d.code)).toEqual([1002, 1005])
    expect(r.alerted).toBe(true)
    const sent = alerted().join(' ')
    expect(sent).toMatch(/1002: the partner record says Fail, the code list says Duplicate/)
    expect(sent).toMatch(/1005: the partner record says Fail, the code list says Duplicate/)
    expect(db.endings.map((e) => e.outcome)).toEqual(['disagree'])
  })

  it('says so when the stored value is not a list, which the node reads as no duplicate rules at all', async () => {
    const db = supabaseDouble({ data: { duplicate_signals: { field: 'data.createLead.resultCode', in: [1002] } } })

    const r = await checkTripointDuplicateCodes(env, db.client)

    expect(r.outcome).toBe('disagree')
    expect(r.disagreements.map((d) => d.code)).toEqual([1002, 1003, 1004, 1005, 1020])
    expect(alerted().join(' ')).toMatch(/not a list/)
  })

  it('treats a record it could not read as its own finding, never as agreement (L98)', async () => {
    const db = supabaseDouble({ error: { message: 'connection reset' } })

    const r = await checkTripointDuplicateCodes(env, db.client)

    expect(r.outcome).toBe('unreadable')
    expect(r.alerted).toBe(true)
    expect(alerted().join(' ')).toMatch(/could not be read.*connection reset/)
    expect(alerted().join(' ')).not.toMatch(/says Fail|says Duplicate/)
    expect(db.endings.map((e) => e.outcome)).toEqual(['unreadable'])
  })

  it('reports a missing Tripoint partner as its own finding, distinct from an unreadable one', async () => {
    const db = supabaseDouble({ data: null })

    const r = await checkTripointDuplicateCodes(env, db.client)

    expect(r.outcome).toBe('missing')
    expect(r.alerted).toBe(true)
    expect(alerted().join(' ')).toMatch(/no partner_configs row has slug tripoint/)
    expect(alerted().join(' ')).not.toMatch(/could not be read/)
  })

  it('never throws: an unexpected failure is alerted as the check failing, and the run is still closed', async () => {
    const db = supabaseDouble(() => {
      throw new TypeError('select is not a function')
    })

    const r = await checkTripointDuplicateCodes(env, db.client)

    expect(r.outcome).toBe('failed')
    expect(r.alerted).toBe(true)
    expect(alerted().join(' ')).toContain('select is not a function')
    expect(db.endings.map((e) => e.outcome)).toEqual(['failed'])
  })

  it('sends its own wording, about a partner setting rather than exports, pointing at the partner page', async () => {
    const db = supabaseDouble({ data: { duplicate_signals: [] } })
    await checkTripointDuplicateCodes(env, db.client)
    const remedy = vi.mocked(notifyExportFailure).mock.calls[0][4]
    expect(remedy).toBe(TRIPOINT_DUPLICATE_CODES_REMEDY)
    expect(TRIPOINT_DUPLICATE_CODES_REMEDY.fixHint).toMatch(/Partners, Tripoint/)
    expect(TRIPOINT_DUPLICATE_CODES_REMEDY.consequence).not.toMatch(/exported/i)
  })

  it('names exactly the code list in its fix, derived rather than a second copy that can go stale (L679)', () => {
    const named = [...TRIPOINT_DUPLICATE_CODES_REMEDY.fixHint.matchAll(/\b\d{3,5}\b/g)].map((m) => Number(m[0]))
    expect(named.sort((a, b) => a - b)).toEqual([...TRIPOINT_DUPLICATE_RESULT_CODES].sort((a, b) => a - b))
  })
})
