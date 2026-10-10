import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WORKER_SRC, listFiles } from '../../__tests__/_scan-utils'

/**
 * The strand-drain cadence the dead-letter alert copy quotes stays tied to the
 * pg_cron schedule that actually runs it (#1953).
 *
 * `SIGHTING_STRAND_DRAIN_CADENCE_MINUTES` in apps/worker/src/lib/slack.ts is the
 * single source for the "recovers within N minutes" copy. The schedule itself
 * lives in a migration (cron.schedule('reduce-finalize-stranded', ...)). Nothing
 * in the language links the two, so without this guard a change to the cron would
 * leave the alert quoting a stale number (L316: record a premise so it can be
 * re-measured, not as a dated sentence). This reads both and fails if they
 * disagree.
 */

const SLACK = path.join(WORKER_SRC, 'lib/slack.ts')
const MIGRATIONS = path.join(REPO_ROOT, 'supabase/migrations')
const JOB = 'reduce-finalize-stranded'

// Smallest gap between runs in an hour, in minutes, for a cron minute field.
// Handles the two forms this job has used: `*/30` and a comma list like `27,57`.
function cadenceMinutes(minuteField: string): number | null {
  const step = /^\*\/(\d+)$/.exec(minuteField)
  if (step) return Number(step[1])
  if (/^\d+(,\d+)*$/.test(minuteField)) {
    const mins = minuteField.split(',').map(Number).sort((a, b) => a - b)
    if (mins.length < 2) return 60 // one run per hour
    const gaps = mins.slice(1).map((m, i) => m - mins[i])
    gaps.push(mins[0] + 60 - mins[mins.length - 1]) // wrap to the next hour
    return Math.min(...gaps)
  }
  return null
}

function constantFromSlack(): number {
  const m = /SIGHTING_STRAND_DRAIN_CADENCE_MINUTES\s*=\s*(\d+)/.exec(readFileSync(SLACK, 'utf8'))
  if (!m) throw new Error('SIGHTING_STRAND_DRAIN_CADENCE_MINUTES not found in slack.ts')
  return Number(m[1])
}

// The cadence in effect is the one from the LAST operation that sets it, which is
// either `cron.schedule('JOB', '<cron>', ...)` or a `cron.alter_job(...)` whose
// job_id resolves to this job and which passes `schedule := '<cron>'` (#1884 moved
// the job to :27,:57 with alter_job, not a reschedule). Both forms are collected
// in source order; the last one wins. If the job is touched again after that in a
// way this guard does not understand (e.g. a cron.unschedule removing it), the
// job name reappears after the last known op and the guard fails loudly, rather
// than silently trusting a superseded cadence.
function scheduledCronMinuteField(): string {
  // One ordered text, sorted by filename, so "the last op" spans migrations.
  const text = listFiles(MIGRATIONS, { exts: ['.sql'] })
    .sort()
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n/* --- next migration --- */\n')
  const ops: { end: number; cron: string }[] = []
  for (const m of text.matchAll(new RegExp(`cron\\.schedule\\(\\s*'${JOB}',\\s*'([^']+)'`, 'g'))) {
    ops.push({ end: (m.index ?? 0) + m[0].length, cron: m[1] })
  }
  // alter_job keyed on jobname = 'JOB', immediately followed by schedule := '<cron>'.
  for (const m of text.matchAll(new RegExp(`jobname\\s*=\\s*'${JOB}'\\s*\\)\\s*,\\s*schedule\\s*:=\\s*'([^']+)'`, 'g'))) {
    ops.push({ end: (m.index ?? 0) + m[0].length, cron: m[1] })
  }
  if (ops.length === 0) throw new Error(`no cron.schedule / alter_job cadence for '${JOB}' found in migrations`)
  ops.sort((a, b) => a.end - b.end)
  const last = ops[ops.length - 1]
  // From AFTER the matched op, so the op's own job-name reference is not counted.
  const after = text.slice(last.end)
  // The hyphenated job name only reappears when the job is re-touched; the
  // function (reduce_finalize_stranded, underscored) is a different token.
  if (after.includes(`'${JOB}'`)) {
    throw new Error(`'${JOB}' is referenced again after its last known cadence op (unschedule / another alter_job?); update this guard to read the new cadence`)
  }
  return last.cron.trim().split(/\s+/)[0]
}

describe('strand-drain alert cadence matches the cron (#1953)', () => {
  it('the quoted cadence equals the scheduled cron cadence', () => {
    const cron = scheduledCronMinuteField()
    const fromCron = cadenceMinutes(cron)
    expect(fromCron).not.toBeNull()
    expect(constantFromSlack()).toBe(fromCron)
  })
})
