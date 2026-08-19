import { describe, expect, it } from 'vitest'
import { listFiles, REPO_ROOT } from '../../__tests__/_scan-utils'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Nothing writes the workflows capture-sightings column, and nothing reads it
 * to decide whether to record (#882).
 *
 * It was a per-workflow opt-out, false on Main Flow, the live flow carrying the
 * Equifax credit report. Roughly 3,600 leads a day produced no sighting, nothing
 * in Snowflake, and an execution that truncates at 7 days: no durable record
 * anywhere. There is no audit trail of it ever being switched, despite the
 * handler writing that field into audit_log since the feature shipped, so it was
 * set outside the application.
 *
 * The COLUMN survives until the contract migration (ADR 0007), which is exactly
 * why this guard exists: a column nothing reads is harmless, but a re-added read
 * would silently resurrect the opt-out with a stale `false` already sitting in
 * production rows.
 */
// Assembled rather than written literally, so this file does not itself contain
// the string it searches for (L103, L135).
const FIELD = ['capture', 'sightings'].join('_')

const WORKER_SRC = path.join(REPO_ROOT, 'apps/worker/src')

function workerSources(): string[] {
  return listFiles(WORKER_SRC)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !f.includes('__tests__'))
    // The generated database types must keep the column while it exists.
    .filter((f) => !f.endsWith('types/database.ts'))
}

describe('capture sightings opt-out is gone', () => {
  it('scans a real body of worker source, so a miss cannot read as a pass', () => {
    // A file list that resolves to nothing reports zero offenders and looks
    // clean (L98). Assert the scan has something to scan first.
    const files = workerSources()
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((f) => f.endsWith('engine/index.ts'))).toBe(true)
  })

  it('has no worker code referencing the field outside the generated types', () => {
    const offenders = workerSources().filter((f) => readFileSync(f, 'utf8').includes(FIELD))

    expect(
      offenders.map((f) => path.relative(REPO_ROOT, f)),
      'nothing may read or write the opt-out; the column is inert until the contract migration',
    ).toEqual([])
  })
})
