/**
 * Whether the index the archive's read depends on is intact (#1044).
 *
 * The archive's per-hour count reads `execution_steps` by
 * (execution_started_at, started_at). Without that index the peak-hour count
 * takes 7.1 seconds warm and times out under load, which is the failure #1040
 * fixed. An index is a performance property, so its absence is invisible until
 * a run fails, and by then the archive has already stopped moving.
 *
 * It decides, it does not read: the reading is a single database function, and
 * this turns it into findings.
 */

export interface IndexHealthReading {
  indexName: string
  present: boolean
  valid: boolean
  partitions: number
  attached: number
}

export interface IndexFinding {
  code: 'index-missing' | 'index-invalid' | 'partitions-unindexed' | 'unreadable'
  message: string
}

/**
 * THREE FAULTS, THREE MESSAGES, because they ask for different work.
 *
 * A missing index is a migration or hand-run DDL that dropped it. An invalid
 * one is usually a partition ATTACHed rather than created, which does not
 * inherit the parent's indexes and leaves the parent INVALID. Unindexed
 * partitions are the same cause caught one step earlier, before the parent flag
 * flips, and naming the count is what says how far it has gone (L11).
 */
export function indexFindings(reading: IndexHealthReading | null, unreadableBecause?: string): IndexFinding[] {
  if (reading === null) {
    // Unreadable is its own finding, never silence. A check that could not look
    // has established nothing, and reporting nothing is what makes an unverified
    // guarantee look verified (L98). The reason travels in the finding, because
    // a reason only logged left the alert saying nothing about why (#835).
    return [
      {
        code: 'unreadable',
        message:
          'whether the index the archive reads by still exists could not be established' +
          (unreadableBecause === undefined ? '' : ` (${unreadableBecause})`) +
          ', so the archive may be one peak hour away from timing out with nothing having said so',
      },
    ]
  }

  const findings: IndexFinding[] = []

  if (!reading.present) {
    findings.push({
      code: 'index-missing',
      message:
        `${reading.indexName} is gone from execution_steps. The archive's per-hour count reads by it and ` +
        'takes 7.1 seconds warm without it, so runs will start timing out under load. A migration or a ' +
        'hand-run DDL dropped or replaced it',
    })
    // No point reporting an invalid or unattached index that does not exist:
    // one cause, one message.
    return findings
  }

  if (!reading.valid) {
    findings.push({
      code: 'index-invalid',
      message:
        `${reading.indexName} exists but Postgres has marked it invalid, so queries will not use it. ` +
        'That usually means a partition was ATTACHed rather than created, which does not inherit the ' +
        "parent's indexes",
    })
  }

  if (reading.attached < reading.partitions) {
    const short = reading.partitions - reading.attached
    findings.push({
      code: 'partitions-unindexed',
      message:
        `${short} of ${reading.partitions} execution_steps partitions do not carry ${reading.indexName}. ` +
        'The archive read is unindexed on those days, and each one is a day whose hours can time out',
    })
  }

  return findings
}
