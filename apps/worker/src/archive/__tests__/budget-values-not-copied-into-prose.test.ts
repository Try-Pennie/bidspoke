import { describe, it, expect } from 'vitest'

/**
 * No comment may carry its own copy of a run-budget value (#953).
 *
 * WHAT HAPPENED. `standstill.ts` derived its threshold in prose from "at most
 * MAX_HOURS_PER_RUN (2) hours". #953 raised that cap to 3 and the sentence went
 * on asserting 2. Nothing behaved differently, because the threshold never
 * depended on the cap, and that is exactly why it survived: a wrong number in a
 * comment breaks no test and is read as authoritative by the next person to
 * open the file.
 *
 * It is the ordinary failure of a value maintained by hand beside its source
 * (L41), and it had already happened twice in this area on the same day: the
 * budget comment in `deadline.ts` also stated a per-hour cost that production
 * had grown past. A number in prose is trusted MORE as it ages, not less
 * (L61, L210, L244).
 *
 * SO THE RULE IS NARROW AND MECHANICAL: name the constant, do not restate its
 * value. `MAX_HOURS_PER_RUN hours` is fine and stays correct for ever;
 * `MAX_HOURS_PER_RUN (2) hours` is what this refuses. Prose that explains a
 * measurement is untouched, because that is evidence rather than a copy, and
 * the measurements have their own re-take path in
 * supabase/tests/measure-archive-hour-cost.sql.
 *
 * Read through Vite's raw import rather than node:fs, because the worker
 * tsconfig targets the Workers runtime and carries no Node types.
 */
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import DEADLINE_SRC from '../deadline.ts?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import STANDSTILL_SRC from '../standstill.ts?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import RUN_LOOP_SRC from '../run-loop.ts?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import HEALTH_SRC from '../health.ts?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import ARCHIVE_SRC from '../../lib/execution-archive.ts?raw'

const SOURCES: ReadonlyArray<readonly [string, string]> = [
  ['archive/deadline.ts', DEADLINE_SRC as string],
  ['archive/standstill.ts', STANDSTILL_SRC as string],
  ['archive/run-loop.ts', RUN_LOOP_SRC as string],
  ['archive/health.ts', HEALTH_SRC as string],
  ['lib/execution-archive.ts', ARCHIVE_SRC as string],
]

/**
 * The names whose VALUE must never be restated in prose. Deliberately the
 * run-budget ones only: this is not a general ban on numbers in comments, which
 * would refuse every recorded measurement in the archive and be turned off
 * within a week.
 */
const BUDGET_NAMES = ['MAX_HOURS_PER_RUN', 'CRON_RUN_BUDGET', 'REQUEST_RUN_BUDGET', 'WALL_TIME_BUDGET_MS']

/**
 * The offending shape: the constant's name, then a parenthesised number, with
 * only spaces between. That is how somebody writes a value down beside its
 * name, and it is specific enough not to catch `MAX_HOURS_PER_RUN * cost` or a
 * sentence that merely mentions the constant near a figure.
 */
const RESTATES_VALUE = new RegExp(`\\b(?:${BUDGET_NAMES.join('|')})\\b\\s*\\(\\s*\\d`, 'g')

/** Comment text only. The code itself has to be able to say `maxHours: 3`. */
function commentsOf(src: string): string {
  const blocks = src.match(/\/\*[\s\S]*?\*\//g) ?? []
  const lines = src.match(/(^|[^:])\/\/[^\n]*/g) ?? []
  return [...blocks, ...lines].join('\n')
}

describe('a run-budget value is named, never copied into prose (#953)', () => {
  it('actually reads the sources, so a miss cannot read as a pass', () => {
    // A `?raw` import that resolved to nothing would make every check below
    // pass while scanning an empty string (L98, L215).
    for (const [name, src] of SOURCES) {
      expect(typeof src, `${name} did not import as text`).toBe('string')
      expect(src.length, `${name} imported empty`).toBeGreaterThan(500)
    }
  })

  it('finds comments in each source, so the extractor is doing something', () => {
    // The regex above could silently match nothing and every file would look
    // clean. These files are heavily commented, so an empty extraction is a
    // broken extractor rather than a tidy codebase.
    for (const [name, src] of SOURCES) {
      expect(commentsOf(src).length, `no comments extracted from ${name}`).toBeGreaterThan(200)
    }
  })

  it('sees the shape it is looking for when that shape is present', () => {
    // A guard nobody has watched fire is not a guard. This pins the matcher
    // against the exact sentence that was wrong, so the check cannot rot into
    // one that matches nothing (L1).
    expect(RESTATES_VALUE.test('a run archives at most MAX_HOURS_PER_RUN (2) hours')).toBe(true)
    RESTATES_VALUE.lastIndex = 0
    expect(RESTATES_VALUE.test('a run archives at most MAX_HOURS_PER_RUN hours')).toBe(false)
    RESTATES_VALUE.lastIndex = 0
    // Must not fire on ordinary code-shaped prose about the constant.
    expect(RESTATES_VALUE.test('MAX_HOURS_PER_RUN * measuredCpuMsPerHour is the cost')).toBe(false)
    RESTATES_VALUE.lastIndex = 0
  })

  it('has no source restating a budget value in a comment', () => {
    const offenders: string[] = []
    for (const [name, src] of SOURCES) {
      for (const m of commentsOf(src).matchAll(RESTATES_VALUE)) {
        offenders.push(`${name}: ${m[0].trim()}`)
      }
    }

    expect(
      offenders,
      'name the constant instead of restating its value: the copy goes stale the first time the constant moves, breaks no test, and is believed by whoever reads it next',
    ).toEqual([])
  })
})
