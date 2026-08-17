import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * A browser gate that ran zero tests must not report a clean pass (#797).
 *
 * #779 is the precedent. The `Security scans` job reported success on every run
 * for eighteen days while auditing nothing at all, because an unparseable
 * lockfile made the scanner skip its only target and exit 0. Every scanner there
 * now has to prove it covered its subject.
 *
 * The same reasoning had not reached the two browser gates. Their per-test
 * assertions are strong: the auth probe refuses a `gate-unavailable` verdict and
 * requires the positive header, and the a11y spec fails on serious violations. But
 * `playwright test` exits 0 when its filter matches no files, and a run over zero
 * pages reports zero violations, which is indistinguishable from a clean pass
 * (LESSONS L98).
 *
 * So this covers the shared checker both jobs run afterwards. It is one
 * implementation rather than two, because "did this run actually cover its
 * subject" is one question and two copies of it would drift (L16).
 *
 * Every outcome the script's contract enumerates is PRODUCED below, not merely
 * covered in passing (L151).
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/playwright-coverage.mjs')

const tmp = mkdtempSync(path.join(tmpdir(), 'pwcov-'))

/** Writes a Playwright-shaped JSON report and returns its path. */
function report(specs: { title: string; status: string }[]): string {
  const file = path.join(tmp, `report-${Math.abs(hash(JSON.stringify(specs)))}.json`)
  writeFileSync(
    file,
    JSON.stringify({
      suites: [
        {
          title: 'a11y.spec.ts',
          specs: specs.map((s) => ({
            title: s.title,
            ok: s.status === 'passed',
            tests: [{ results: [{ status: s.status }] }],
          })),
        },
      ],
    }),
  )
  return file
}

/** Deterministic name for a fixture file, so tests do not depend on a clock. */
function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

/** Runs the checker; returns its exit code and combined output. */
function check(reportPath: string, min: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [SCRIPT, reportPath, min], { encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

const passing = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ title: `page ${i} has no serious a11y violations`, status: 'passed' }))

describe('playwright-coverage: the healthy run', () => {
  it('passes when every expected test ran and passed', () => {
    expect(check(report(passing(10)), '10').code).toBe(0)
  })

  it('passes when MORE tests ran than the floor', () => {
    // The floor is a minimum, not an equality. Adding a page must not fail the
    // gate until someone remembers to bump a number, or the number gets bumped
    // reflexively and stops meaning anything.
    expect(check(report(passing(12)), '10').code).toBe(0)
  })
})

describe('playwright-coverage: a run that covered nothing', () => {
  it('fails on an empty report', () => {
    // The whole point. `playwright test` exits 0 when its filter matches no
    // files, so this is the shape a silently-disabled gate takes.
    const result = check(report([]), '10')
    expect(result.code).not.toBe(0)
    expect(result.out).toMatch(/0/)
  })

  it('fails when fewer tests ran than the floor', () => {
    const result = check(report(passing(3)), '10')
    expect(result.code).not.toBe(0)
    expect(result.out, 'the message does not say how many it found or expected').toMatch(/3/)
  })
})

describe('playwright-coverage: a run whose tests did not really run', () => {
  it('fails when a test was skipped, rather than counting it as covered', () => {
    // A skipped test is not a covered subject. Counting it is how a gate keeps
    // its number up while quietly checking less.
    const specs = [...passing(9), { title: 'settings page', status: 'skipped' }]
    const result = check(report(specs), '10')
    expect(result.code).not.toBe(0)
    expect(result.out).toMatch(/skip/i)
  })

  it('fails when a test failed, even if the count is met', () => {
    // Defence in depth: playwright would already have exited non-zero, but a
    // checker that reported success over a failing report would make the two
    // disagree, and the one that is easier to read would win.
    const specs = [...passing(9), { title: 'dashboard', status: 'failed' }]
    expect(check(report(specs), '10').code).not.toBe(0)
  })
})

describe('playwright-coverage: the checker itself cannot read', () => {
  it('fails when the report file does not exist', () => {
    // The most likely real failure: the reporter did not write where the job
    // looked. Reading that as "nothing to check" would restore the exact silence
    // this exists to remove.
    const result = check(path.join(tmp, 'nope.json'), '10')
    expect(result.code).not.toBe(0)
    expect(result.out).toMatch(/not|missing|read/i)
  })

  it('fails when the report is not valid JSON', () => {
    const file = path.join(tmp, 'garbage.json')
    writeFileSync(file, '<html>not a report</html>')
    expect(check(file, '10').code).not.toBe(0)
  })

  it('fails when the floor is not a number, rather than comparing against NaN', () => {
    // A value that fails to parse compares false against every threshold and
    // lands on the permissive side with no error raised (L50).
    expect(check(report(passing(10)), 'ten').code).not.toBe(0)
  })

  it('fails when no floor is given at all', () => {
    try {
      execFileSync('node', [SCRIPT, report(passing(10))], { encoding: 'utf8', stdio: 'pipe' })
      throw new Error('the checker accepted a missing floor')
    } catch (e) {
      expect((e as { status: number }).status).not.toBe(0)
    }
  })
})
