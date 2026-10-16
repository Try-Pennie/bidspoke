/**
 * Schedule code never reads the machine clock or a local date getter (#1952).
 *
 * A schedule fires on the DATABASE clock (D8 in #1698): the ops tick passes the
 * database's now() into planFires, and the fire calculator turns wall times
 * into instants through the shared clock alone. A `Date.now()` or argument-less
 * `new Date()` anywhere in it would read the Worker's clock, which the plan
 * rules out (pg-boss warns at 60 s of skew, L736), and it would make the tests,
 * which pass every instant in, stop meaning anything (R13). A local getter
 * (`getHours`, `getDay`, ...) reads the machine's zone, which is UTC on a
 * Worker and something else on a laptop, so it is wrong in exactly one of the
 * two places it runs. The shared clock module is scanned too, because the
 * schedule's wall time arithmetic lives there.
 *
 * Seen red by adding `Date.now() + new Date(0).getDay()` to plan.ts.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFiles, REPO_ROOT, sanitizeSource } from '@/lib/__tests__/_scan-utils'

const SCHEDULE_SRC = path.join(REPO_ROOT, 'packages/workflow-definition/src/schedule')
const CLOCK = path.join(REPO_ROOT, 'packages/buyer-profile/src/clock.ts')

const FORBIDDEN = /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\bperformance\.now\s*\(|\.(getHours|getMinutes|getSeconds|getDay|getDate|getMonth|getFullYear|getYear|getTimezoneOffset|toLocaleString|toLocaleDateString|toLocaleTimeString)\s*\(/

function files(): string[] {
  return [...listFiles(SCHEDULE_SRC, { exts: ['.ts'] }), CLOCK]
}

describe('schedule code reads no machine clock (#1952)', () => {
  it('scans the schedule modules and the shared clock', () => {
    const names = files().map((f) => path.basename(f))
    for (const expected of ['plan.ts', 'fires.ts', 'cron.ts', 'schedule.ts', 'pipedream-timer.ts', 'clock.ts']) expect(names).toContain(expected)
  })

  it('finds no Date.now, argument-less new Date, performance.now or local date getter', () => {
    const readers: string[] = []
    for (const file of files()) {
      sanitizeSource(readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
        if (FORBIDDEN.test(line)) readers.push(`${path.relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(readers).toEqual([])
  })
})
