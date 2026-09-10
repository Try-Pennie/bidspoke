/**
 * The archive's read index, and the three ways it goes missing (#1044).
 *
 * Without it the peak-hour count takes 7.1 seconds warm and times out under
 * load. It is a performance property, so nothing reports its absence until a
 * run fails, and by then the archive has already stopped.
 */
import { describe, it, expect } from 'vitest'
import { indexFindings, type IndexHealthReading } from '../index-health'

const healthy: IndexHealthReading = {
  indexName: 'idx_exec_steps_execution_started',
  present: true,
  valid: true,
  partitions: 56,
  attached: 56,
}

describe('indexFindings', () => {
  it('says nothing when the index is present, valid and on every partition', () => {
    // The reading measured on production 2026-09-10: 56 partitions, 56 attached.
    expect(indexFindings(healthy)).toEqual([])
  })

  it('reports a dropped index, naming what it costs', () => {
    const findings = indexFindings({ ...healthy, present: false, valid: false, attached: 0 })

    expect(findings.map((f) => f.code)).toEqual(['index-missing'])
    // One cause, one message: reporting it as also invalid and also unattached
    // would be three alarms about one event (L11).
    expect(findings[0].message).toMatch(/7\.1 seconds/)
  })

  it('reports an invalid index separately, because the cause is different', () => {
    const findings = indexFindings({ ...healthy, valid: false })

    expect(findings.map((f) => f.code)).toContain('index-invalid')
    expect(findings.find((f) => f.code === 'index-invalid')?.message).toMatch(/ATTACHed/)
  })

  it('reports partitions missing the index, and says how many', () => {
    // Caught one step before the parent flag flips, and the count is what says
    // how far it has gone.
    const findings = indexFindings({ ...healthy, attached: 51 })

    const short = findings.find((f) => f.code === 'partitions-unindexed')
    expect(short?.message).toContain('5 of 56')
  })

  it('reports both when an attach has left the index invalid AND partitions short', () => {
    const findings = indexFindings({ ...healthy, valid: false, attached: 50 })

    expect(findings.map((f) => f.code)).toEqual(['index-invalid', 'partitions-unindexed'])
  })

  it('treats an unreadable check as a finding, not as health', () => {
    // A check that could not look has established nothing, and silence there is
    // what makes an unverified guarantee look verified (L98).
    const findings = indexFindings(null)

    expect(findings.map((f) => f.code)).toEqual(['unreadable'])
    expect(findings[0].message).toMatch(/could not be established/)
  })

  it('does not report unattached partitions when there are more attached than partitions', () => {
    // Not a real state, but the comparison must not fire on it: a spurious
    // alarm on an impossible reading is how a panel gets ignored.
    expect(indexFindings({ ...healthy, attached: 57 })).toEqual([])
  })
})
