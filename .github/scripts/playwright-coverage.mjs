#!/usr/bin/env node
/**
 * Prove a Playwright gate actually covered its subject (#797).
 *
 * #779 is the precedent. The `Security scans` job reported success on every run
 * for eighteen days while auditing nothing at all, because an unparseable
 * lockfile made the scanner skip its only target and exit 0. Every scanner there
 * now has to prove it covered its subject; the two browser gates did not.
 *
 * Their per-test assertions are strong. What neither could show is that the
 * tests RAN. `playwright test` exits 0 when its filter matches no files, and a
 * scan over zero pages reports zero violations, which is indistinguishable from
 * a clean pass (LESSONS L98). Finding no subjects has to be its own non-success
 * outcome, because the empty result arrives exactly when the gate has broken,
 * which is the moment a green verdict is most likely to be believed.
 *
 * Usage:
 *   playwright-coverage.mjs <report.json> <minimum-tests>
 *
 * Exits 0 only when the report is readable, at least `minimum-tests` specs are
 * present, every one of them ran, and none failed. Anything else exits 1 with a
 * reason.
 *
 * The floor is a MINIMUM rather than an equality on purpose: adding a page must
 * not fail the gate until someone remembers to bump a number, because a number
 * that has to be bumped reflexively stops being read. A separate unit test keeps
 * the floor in step with the page lists the specs actually declare.
 */
import { readFileSync } from 'node:fs'

const fail = (message) => {
  console.error(`playwright-coverage: ${message}`)
  process.exit(1)
}

const [reportPath, minRaw] = process.argv.slice(2)

if (!reportPath) fail('called with no report path, so nothing was checked')

// Parsed through one check and mapped to the loud side. A value that fails to
// parse yields NaN, which compares false against every threshold and would land
// on the permissive side with no error raised (L50).
if (minRaw === undefined) fail('called with no minimum test count, so any number of tests would pass')
const min = Number(minRaw)
if (!Number.isInteger(min) || min < 1) {
  fail(`minimum test count '${minRaw}' is not a positive whole number, so it cannot be compared against`)
}

let raw
try {
  raw = readFileSync(reportPath, 'utf8')
} catch (e) {
  // The most likely real failure: the reporter did not write where the job
  // looked. Reading that as "nothing to check" would restore the exact silence
  // this exists to remove.
  fail(`could not read the report at ${reportPath} (${e.message}), so coverage is unknown`)
}

let report
try {
  report = JSON.parse(raw)
} catch (e) {
  fail(`the report at ${reportPath} is not valid JSON (${e.message}), so coverage is unknown`)
}

/** Every spec in the report, at any suite depth. */
const collectSpecs = (node) => {
  const out = []
  for (const suite of node.suites ?? []) out.push(...collectSpecs(suite))
  for (const spec of node.specs ?? []) out.push(spec)
  return out
}

const specs = collectSpecs(report)

/** The outcome recorded for a spec, across its tests and retries. */
const statusesOf = (spec) =>
  (spec.tests ?? []).flatMap((t) => (t.results ?? []).map((r) => r.status))

const skipped = specs.filter((s) => {
  const statuses = statusesOf(s)
  return statuses.length > 0 && statuses.every((st) => st === 'skipped')
})
const failed = specs.filter((s) => statusesOf(s).some((st) => st === 'failed' || st === 'timedOut'))
const ran = specs.filter((s) => !skipped.includes(s))

if (specs.length === 0) {
  fail(`the report contains 0 tests, so this gate ran over nothing and its pass means nothing (expected at least ${min})`)
}

// Reported before the count check, so "you are covering less than you think" is
// never disguised as "you are covering enough". A skipped test is not a covered
// subject, and counting it is how a gate keeps its number up while quietly
// checking less.
if (skipped.length > 0) {
  fail(
    `${skipped.length} of ${specs.length} tests were skipped, so they covered nothing: ${skipped
      .map((s) => s.title)
      .join(', ')}`,
  )
}

if (failed.length > 0) {
  fail(`${failed.length} tests failed: ${failed.map((s) => s.title).join(', ')}`)
}

if (ran.length < min) {
  fail(`only ${ran.length} tests ran, below the expected floor of ${min}, so this gate covered less than it should`)
}

console.log(`playwright-coverage: ${ran.length} tests ran and passed (floor ${min}).`)
