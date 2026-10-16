/**
 * The display time zone is shown, never judged (#2143, PM-10).
 *
 * A buyer profile's display_time_zone only says which zone the partners page
 * shows the hours and reset times in. The hours are stored and judged in
 * Eastern and the click count resets at midnight Pacific whatever it says, so
 * nothing that decides about a lead may read it: the engine, the Durable
 * Objects that hold the buyer ledgers, the Worker's buyer libraries, and the
 * evaluators in @bidspoke/buyer-profile. A reader there would make a display
 * choice move when a buyer is open or when its count resets.
 *
 * Comments are blanked and strings are not, so a column read spelled as a
 * select string (`'display_time_zone'`) is caught as well as an identifier.
 *
 * Seen red by adding a `'display_time_zone'` string to engine/nodes/buyer-select.ts
 * and a function reading `p.displayTimeZone` to eligibility.ts.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFiles, REPO_ROOT, sanitizeSource, WORKER_SRC } from '@/lib/__tests__/_scan-utils'

const PACKAGE_SRC = path.join(REPO_ROOT, 'packages/buyer-profile/src')

/** The package modules that judge a lead or a sale. clock.ts defines the list; document, validate, diff and paths carry it for the page. */
const PACKAGE_JUDGES = ['eligibility.ts', 'outcome.ts', 'tiers.ts', 'click-send.ts', 'click-delivery.ts', 'deadline.ts', 'payload.ts', 'parse.ts', 'vocab.ts', 'hash.ts']

const FORBIDDEN = /\bDISPLAY_TIME_ZONES?\b|\bDISPLAY_TIME_ZONE_LABELS\b|\bDEFAULT_DISPLAY_TIME_ZONE\b|\bisDisplayTimeZone\b|\.displayTimeZone\b|display_time_zone/

function judges(): string[] {
  const worker = [
    ...listFiles(path.join(WORKER_SRC, 'engine'), { exts: ['.ts'] }),
    ...listFiles(path.join(WORKER_SRC, 'durable-objects'), { exts: ['.ts'] }),
    ...listFiles(path.join(WORKER_SRC, 'lib'), { exts: ['.ts'] }).filter((f) => path.basename(f).startsWith('buyer-')),
  ]
  return [...worker, ...PACKAGE_JUDGES.map((f) => path.join(PACKAGE_SRC, f))]
}

describe('the display time zone is read by nothing that judges a lead (#2143)', () => {
  it('scans the engine, the buyer Durable Objects and libraries, and the package evaluators', () => {
    const files = judges()
    expect(files.length).toBeGreaterThan(80)
    expect(files.some((f) => f.endsWith(path.join('engine', 'nodes', 'buyer-select.ts')))).toBe(true)
    expect(files.some((f) => f.endsWith(path.join('lib', 'buyer-profile-loader.ts')))).toBe(true)
  })

  it('finds no reader', () => {
    const readers: string[] = []
    for (const file of judges()) {
      const lines = sanitizeSource(readFileSync(file, 'utf8'), { blankStrings: false }).split('\n')
      lines.forEach((line, i) => {
        if (FORBIDDEN.test(line)) readers.push(`${path.relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(readers).toEqual([])
  })
})
