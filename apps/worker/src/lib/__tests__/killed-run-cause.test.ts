/**
 * The takeover says how far the run it is replacing had got (#1034).
 *
 * A killed run leaves a `job_runs` row with no ending, and that absence is the
 * only evidence it was killed. It says nothing about the CAUSE: out of memory,
 * out of wall time, out of subrequests and a platform blip all leave the
 * identical trace, and they are different fixes. An hour too large to finish in
 * one invocation can never be archived however often it retries (#953), while a
 * blip clears on the next run. Today the only way to tell them apart was to read
 * Cloudflare analytics by hand.
 */
import { describe, it, expect } from 'vitest'
import { describePredecessor } from '../execution-archive'

describe('describing the run that was killed', () => {
  it('names the hour it died after, and what it had spent getting there', () => {
    const said = describePredecessor({
      kind: 'found',
      run: {
      id: 'run-0',
      startedAt: '2026-08-25T14:00:40.000Z',
      summary: {
        detail: 'archived the hour beginning 2026-08-25T09:00:00.000Z',
        hoursArchived: 5,
        hoursEmpty: 1,
        elapsedMs: 880_000,
        subrequestsUsed: { total: 742 },
      },
      },
    })

    expect(said).toContain('2026-08-25T09:00:00.000Z')
    expect(said).toContain('5 hours archived')
    expect(said).toContain('880s elapsed')
    expect(said).toContain('742 subrequests used')
  })

  it('says a run that stamped nothing died inside its first hour', () => {
    // Its own sentence, because it points somewhere different: at one hour being
    // too large rather than at the run being too long (L11).
    const said = describePredecessor({ kind: 'found', run: { id: 'run-0', startedAt: '2026-08-25T14:00:40.000Z', summary: null } })

    expect(said).toContain('finished no hour at all')
    expect(said).toContain('first one')
  })

  it('refuses to claim the predecessor reached nothing when there is no record', () => {
    // No row and a row saying zero are different facts. Reporting the first as
    // the second would be a statement nobody measured, and it points at the same
    // fix as a genuine first hour failure while being about a missing record.
    const said = describePredecessor({ kind: 'none' })

    expect(said).toContain('No record of the run that was killed was found')
    expect(said).not.toContain('no hour at all')
  })

  it('separates a lookup that failed from one that found nothing', () => {
    // Two different facts. A failed read means something may well be recorded
    // and we could not see it, so reporting it as "no record was found" is a
    // claim the check never measured (L11), and it points at the wrong fix.
    const said = describePredecessor({ kind: 'unreadable', detail: 'supabase timed out' })

    expect(said).toContain('could not be read')
    expect(said).toContain('supabase timed out')
    expect(said).not.toContain('No record of the run that was killed was found')
  })

  it('prints nothing unreadable when a stamp carries a field of the wrong type', () => {
    // An older stamp, or a corrupt one. Coercing instead of typing is how a
    // field reaches an alert as "[object Object]" or as a NaN nobody can act on.
    const said = describePredecessor({
      kind: 'found',
      run: {
        id: 'run-0',
        startedAt: '2026-08-25T14:00:40.000Z',
        summary: { detail: { nested: true }, hoursArchived: 'five', elapsedMs: 'a while', subrequestsUsed: 'lots' },
      },
    })

    expect(said).not.toContain('[object Object]')
    expect(said).not.toContain('NaN')
    expect(said).toContain('an unrecorded point')
  })

  it('still describes a run whose stamp is missing the spend figures', () => {
    // The stamp shape can grow, and an older row written before a field existed
    // must not make the whole sentence unprintable (L425).
    const said = describePredecessor({
      kind: 'found',
      run: {
        id: 'run-0',
        startedAt: '2026-08-25T14:00:40.000Z',
        summary: { detail: 'archived the hour beginning 2026-08-25T09:00:00.000Z' },
      },
    })

    expect(said).toContain('2026-08-25T09:00:00.000Z')
    expect(said).not.toContain('undefined')
    expect(said).not.toContain('NaN')
  })
})
