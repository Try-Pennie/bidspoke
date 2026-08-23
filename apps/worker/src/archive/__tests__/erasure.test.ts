/**
 * What an erasure erased, and whether it may be called one (#875, Phase A7).
 *
 * The rule this encodes, from ADR 0009 in as many words: erasing the archive
 * without erasing LEAD_SIGHTINGS is not erasure. A delete from
 * `execution_archive` alone would report success while the SSN survives in the
 * very table used to FIND it, which is worse than no erasure because it closes
 * the matter.
 *
 * Every rule below has a test that PRODUCES the outcome (L151).
 */
import { describe, it, expect } from 'vitest'
import {
  erasureVerdict,
  erasureSummary,
  ERASURE_TARGETS,
  UNVERIFIED_TARGETS,
  type TargetOutcome,
} from '../erasure'

/** Every target succeeding with rows, which each test then spoils in one way. */
function allDeleted(rows = 1): TargetOutcome[] {
  return ERASURE_TARGETS.map((target) => ({ target, rowsDeleted: rows, error: null }))
}

const NOTHING_UNVERIFIED: readonly string[] = []

describe('an erasure where everything succeeded', () => {
  it('is an erasure, once nothing is unverified', () => {
    const v = erasureVerdict(allDeleted(3), NOTHING_UNVERIFIED)

    expect(v.status).toBe('erased')
    if (v.status !== 'erased') throw new Error('unreachable')
    expect(v.totalRows).toBe(12)
  })

  it('says what it MEASURED, naming the window the rows are still recoverable in', () => {
    // A Snowflake DELETE does not remove the rows: Time Travel keeps the prior
    // version and Fail-safe holds a further seven days nobody can query. A
    // response claiming completion would claim something it never measured
    // (L82, L11).
    const summary = erasureSummary(erasureVerdict(allDeleted(3), NOTHING_UNVERIFIED), allDeleted(3), 30)

    expect(summary).toMatch(/removed from the live tables/)
    expect(summary).toMatch(/Time Travel for 30 days/)
    expect(summary).toMatch(/Fail-safe for 7 days/)
  })
})

describe('an erasure that matched nothing', () => {
  it('says so, and is never reported as success', () => {
    // Telling a subject their data is gone when nothing was found is the exact
    // failure this phase exists to avoid.
    const v = erasureVerdict(allDeleted(0), NOTHING_UNVERIFIED)

    expect(v.status).toBe('no-rows-matched')
    expect(erasureSummary(v, allDeleted(0), 30)).toMatch(/Nothing was erased, and nothing was found to erase/)
  })
})

describe('an erasure where one target failed', () => {
  it('is PARTIAL, and names which survived', () => {
    // The archive cleared and LEAD_SIGHTINGS not is the specific case the ADR
    // calls out: the SSN survives in the very table used to find it.
    const outcomes = allDeleted()
    outcomes[1] = { target: 'lead_sightings', rowsDeleted: null, error: 'warehouse suspended' }

    const v = erasureVerdict(outcomes, NOTHING_UNVERIFIED)
    expect(v.status).toBe('partial')
    if (v.status !== 'partial') throw new Error('unreachable')
    expect(v.failed).toEqual(['lead_sightings'])
    expect(v.succeeded).toContain('execution_archive')
  })

  it('leads with the failure, never with the rows it did delete', () => {
    // Any wording that led with the count would read as progress on a run where
    // the subject's identity survives.
    const outcomes = allDeleted()
    outcomes[1] = { target: 'lead_sightings', rowsDeleted: null, error: 'warehouse suspended' }
    const summary = erasureSummary(erasureVerdict(outcomes, NOTHING_UNVERIFIED), outcomes, 30)

    expect(summary.startsWith('PARTIAL')).toBe(true)
    expect(summary).toMatch(/is NOT an erasure/)
  })

  it('reports every target\'s own count, never one aggregate', () => {
    const outcomes = allDeleted(2)
    outcomes[3] = { target: 'audit_log', rowsDeleted: null, error: 'gone' }
    const summary = erasureSummary(erasureVerdict(outcomes, NOTHING_UNVERIFIED), outcomes, 30)

    for (const target of ERASURE_TARGETS) expect(summary).toContain(target)
    expect(summary).toMatch(/audit_log: FAILED/)
  })
})

describe('a target that never ran', () => {
  it('is a failure, not a target that matched nothing', () => {
    // An absent outcome and a zero outcome are different facts, and reading the
    // first as the second would report a store nobody touched as clean (L215).
    const v = erasureVerdict(allDeleted().slice(0, 2), NOTHING_UNVERIFIED)

    expect(v.status).toBe('partial')
    if (v.status !== 'partial') throw new Error('unreachable')
    expect(v.failed).toEqual(['lead_sighting_bids', 'audit_log'])
  })
})

describe('a target nobody has been able to check', () => {
  it('stops the run being called an erasure, even though everything asked for succeeded', () => {
    const v = erasureVerdict(allDeleted(3), ['cloudflare_logpush'])

    expect(v.status).toBe('incomplete-coverage')
    if (v.status !== 'incomplete-coverage') throw new Error('unreachable')
    expect(v.unverified).toEqual(['cloudflare_logpush'])
  })

  it('names it in the response, so the matter is not closed on the subject\'s behalf', () => {
    const summary = erasureSummary(erasureVerdict(allDeleted(3), ['cloudflare_logpush']), allDeleted(3), 30)

    expect(summary).toMatch(/NOT COMPLETE/)
    expect(summary).toMatch(/cloudflare_logpush/)
    expect(summary).toMatch(/whether a further copy exists is unknown/)
  })

  it('still reports the rows it did remove, because those are real', () => {
    const summary = erasureSummary(erasureVerdict(allDeleted(3), ['cloudflare_logpush']), allDeleted(3), 30)

    expect(summary).toMatch(/12 rows removed from the live tables/)
  })

  it('ships with Logpush unverified, which is the state of the world today', () => {
    // ADR 0009 records it: the Cloudflare API answers 10000 Authentication
    // error for every credential this codebase can reach, and no wrangler
    // session here carries the Logpush read scope. Listed in code rather than
    // left out until somebody finds out, because the alternative is an erasure
    // reporting completeness it has not got.
    expect(UNVERIFIED_TARGETS).toContain('cloudflare_logpush')
  })
})

describe('the enumerated set', () => {
  it('covers the archive, both sightings tables and the audit rows', () => {
    // Named here so removing one from the eraser fails a test rather than
    // quietly narrowing what erasure means.
    expect([...ERASURE_TARGETS]).toEqual([
      'execution_archive',
      'lead_sightings',
      'lead_sighting_bids',
      'audit_log',
    ])
  })
})
