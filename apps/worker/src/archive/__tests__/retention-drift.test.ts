/**
 * Comparing the execution purge jobs against the retention the repo declares
 * (#1017).
 *
 * How long execution data is kept is stated in three independent places: the two
 * pg_cron job commands that destroy it, and `RETENTION_DAYS` in the code, which
 * decides how urgently the deletion gate reports a day that is not yet verified.
 * Nothing compared them. They were 7, 7 and 7; on 2026-08-23 the two jobs were
 * changed by hand to stop unarchived days being destroyed, and by 2026-09-03 they
 * said 21 while the code still said 7.
 *
 * Neither direction of that disagreement produces an error. If the jobs are
 * shorter than the code believes, data is destroyed before the gate has finished
 * vouching for it. If the code is shorter (the state on 2026-09-03) the gate
 * reports a day as one night from deletion when it has fifteen, which is the
 * milder direction and still made a real alert say something false.
 *
 * It decides, it does not act.
 */
import { describe, it, expect } from 'vitest'
import { retentionDifferences, type ObservedPurgeJob } from '../retention-drift'

const TRUNCATE = 'purge-old-execution-partitions'
const REAP = 'reap-empty-execution-partitions'

function job(jobname: string, over: Partial<ObservedPurgeJob> = {}): ObservedPurgeJob {
  return {
    jobname,
    active: true,
    retentionDays: 21,
    command: `CALL some_procedure(21)`,
    ...over,
  }
}

describe('retentionDifferences', () => {
  it('is silent when both jobs agree with each other and with the declared window', () => {
    expect(retentionDifferences([job(TRUNCATE), job(REAP)], 21)).toEqual([])
  })

  it('reports every job whose window differs from the declared one, naming both numbers', () => {
    // This is the real state on 2026-09-03: both jobs at 21, the code at 7. Both
    // are reported, because collapsing them to one finding would leave the second
    // job unmentioned and it is the one that actually drops the partition.
    const differences = retentionDifferences([job(TRUNCATE, { retentionDays: 21 }), job(REAP, { retentionDays: 21 })], 7)

    expect(differences.map((d) => d.code)).toEqual(['retention-disagrees', 'retention-disagrees'])
    expect(differences[0]?.message).toContain('21')
    expect(differences[0]?.message).toContain('7')
    expect(differences[1]?.message).toContain(REAP)
  })

  it('reports the two jobs disagreeing with each other as its own finding', () => {
    // This is the pair that can destroy data, and one truncating earlier than the
    // other reaps is a different fault from either differing from the code.
    const differences = retentionDifferences(
      [job(TRUNCATE, { retentionDays: 9 }), job(REAP, { retentionDays: 21 })],
      21,
    )

    expect(differences.map((d) => d.code)).toContain('jobs-disagree')
  })

  it('reports a job that is missing entirely', () => {
    const differences = retentionDifferences([job(TRUNCATE)], 21)

    expect(differences.map((d) => d.code)).toEqual(['job-missing'])
    expect(differences[0]?.message).toContain(REAP)
  })

  it('reports a job that exists but is switched off, which is not the same as agreeing', () => {
    // An inactive purge job destroys nothing, so its retention number is
    // irrelevant and reading it as agreement would hide that retention is in fact
    // unbounded.
    const differences = retentionDifferences([job(TRUNCATE, { active: false }), job(REAP)], 21)

    expect(differences.map((d) => d.code)).toEqual(['job-inactive'])
    expect(differences[0]?.message).toContain(TRUNCATE)
  })

  it('reports an unreadable window as unreadable, not as a disagreement', () => {
    // A command whose argument could not be parsed has not been measured. Saying
    // it disagrees would be a claim the check cannot support (L11).
    const differences = retentionDifferences(
      [job(TRUNCATE, { retentionDays: null, command: 'CALL truncate_expired_execution_partitions(interval_from_settings())' }), job(REAP)],
      21,
    )

    expect(differences.map((d) => d.code)).toEqual(['retention-unreadable'])
    expect(differences[0]?.message).toContain('interval_from_settings')
  })

  it('does not report an unreadable window twice, once as unreadable and once as a mismatch', () => {
    const differences = retentionDifferences([job(TRUNCATE, { retentionDays: null }), job(REAP, { retentionDays: null })], 21)

    expect(differences.map((d) => d.code)).toEqual(['retention-unreadable', 'retention-unreadable'])
  })

  it('refuses to call an empty observation agreement', () => {
    // Reading no jobs at all is not evidence that retention is correct. It is the
    // shape where "everything agrees" and "nothing was looked at" are the same
    // answer (L98).
    const differences = retentionDifferences([], 21)

    expect(differences.map((d) => d.code)).toEqual(['job-missing', 'job-missing'])
  })
})
