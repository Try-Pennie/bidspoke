#!/usr/bin/env node
//
// Assert a security scanner actually covered its subject before the job may pass
// (#779).
//
// The `Security scans` job reported success on every run from 2026-07-27 to
// 2026-08-14 while auditing nothing at all. `pnpm-lock.yaml` carried a duplicated
// entry, Trivy could not parse it, so it skipped the file, found zero targets and
// exited 0. Its report summary read `- | - | -`, where `-` is Trivy's marker for
// NOT SCANNED, not for clean. Repairing the lockfile (#778) immediately surfaced a
// real HIGH that had been invisible for eighteen days.
//
// LESSONS L98: a check reporting success when it found NOTHING to check is
// indistinguishable from one that saw everything pass, and the empty result
// arrives exactly when a green verdict is most likely to be believed.
//
// So every scanner in that job now runs with its own exit code disarmed, writes a
// machine-readable report, and this script owns BOTH decisions: did you cover your
// subject, and did you find anything. Coverage is checked first, because a scan
// that covered nothing has not earned the right to report clean.
//
// Usage:
//   scan-coverage.mjs trivy    <report.json> <required-target>
//   scan-coverage.mjs semgrep  <report.json> <required-path-prefix>...
//   scan-coverage.mjs gitleaks <report.json> <canary-file>
//
// Exits 0 only when the scanner is proven to have covered its subject AND found
// nothing. Every other outcome, including an unreadable report, exits 1.
import { readFileSync } from 'node:fs'

/** @typedef {{ ok: boolean, reason: string }} Verdict */

const pass = (reason) => ({ ok: true, reason })
const fail = (reason) => ({ ok: false, reason })

/**
 * Trivy covered `target` and found nothing.
 *
 * A CLEAN scan still emits a Results entry for the target with zero
 * vulnerabilities (verified against trivy 0.72.0), which is what makes
 * present-and-clean distinguishable from never-scanned. The unparseable-lockfile
 * case really does produce `Results: null` with exit code 0.
 *
 * @returns {Verdict}
 */
export function checkTrivy(report, target) {
  const results = Array.isArray(report?.Results) ? report.Results : []
  if (results.length === 0) {
    return fail(
      `trivy scanned nothing: its report has no results at all, so ${target} was never audited. ` +
        'That is what an unparseable lockfile looks like, and trivy still exits 0.',
    )
  }

  const hit = results.find((r) => r?.Target === target)
  if (!hit) {
    const seen = results.map((r) => r?.Target ?? '(unnamed)').join(', ')
    return fail(`trivy did not scan ${target}. It reported on: ${seen}.`)
  }
  if (!hit.Type) {
    return fail(`trivy listed ${target} but resolved no ecosystem for it, so no dependency was actually read.`)
  }

  const vulns = results.flatMap((r) => r?.Vulnerabilities ?? [])
  if (vulns.length > 0) {
    const listed = vulns
      .map((v) => `${v?.PkgName} ${v?.InstalledVersion} ${v?.VulnerabilityID} (${v?.Severity}, fixed in ${v?.FixedVersion || 'nothing yet'})`)
      .join('\n  ')
    return fail(`trivy found ${vulns.length} advisory(s) in ${target}:\n  ${listed}`)
  }

  return pass(`trivy scanned ${target} as ${hit.Type} and found nothing.`)
}

/**
 * Semgrep covered every required tree and found nothing.
 *
 * `paths.scanned` is `[]` when semgrep ran over nothing, and it still exits 0.
 * Requiring named trees rather than a file count is deliberate: an `--exclude`
 * that grows until half the repo is unaudited leaves a healthy-looking non-zero
 * count behind (LESSONS L63, assert the quantity you mean, not a proxy for it).
 *
 * @returns {Verdict}
 */
export function checkSemgrep(report, requiredPrefixes) {
  const scanned = Array.isArray(report?.paths?.scanned) ? report.paths.scanned : null
  if (scanned === null) {
    return fail('semgrep reported no paths.scanned at all, so there is no evidence it read anything.')
  }

  const missing = requiredPrefixes.filter((prefix) => !scanned.some((p) => String(p).includes(prefix)))
  if (missing.length > 0) {
    return fail(
      `semgrep scanned ${scanned.length} file(s) but covered none under: ${missing.join(', ')}. ` +
        'Those trees are unaudited.',
    )
  }

  const results = Array.isArray(report?.results) ? report.results : []
  if (results.length > 0) {
    const listed = results.map((r) => `${r?.path}:${r?.start?.line} ${r?.check_id}`).join('\n  ')
    return fail(`semgrep found ${results.length} finding(s):\n  ${listed}`)
  }

  const counts = requiredPrefixes
    .map((prefix) => `${prefix} ${scanned.filter((p) => String(p).includes(prefix)).length}`)
    .join(', ')
  return pass(`semgrep scanned ${scanned.length} file(s) (${counts}) and found nothing.`)
}

/**
 * Gitleaks found the planted canary and nothing else.
 *
 * Gitleaks emits no coverage signal of any kind: an empty report is what a clean
 * scan produces AND what a scan over nothing produces. So the run plants a secret
 * the ruleset must catch and requires it back. That proves more than a file count
 * could, because a broad allowlist would suppress every finding while the file
 * count still looked healthy.
 *
 * Both halves are always reported: an allowlist wide enough to swallow the canary
 * is wide enough to swallow a real leak, so the missing canary must not hide the
 * real finding sitting next to it.
 *
 * @returns {Verdict}
 */
export function checkGitleaks(findings, canaryFile) {
  const all = Array.isArray(findings) ? findings : []
  const foundCanary = all.some((f) => String(f?.File ?? '').endsWith(canaryFile))
  const real = all.filter((f) => !String(f?.File ?? '').endsWith(canaryFile))

  const problems = []
  if (!foundCanary) {
    problems.push(
      `gitleaks did not report the canary secret planted at ${canaryFile}, so this scan proves nothing. ` +
        'Either it read no files, or an allowlist is now broad enough to suppress a real leak.',
    )
  }
  if (real.length > 0) {
    const listed = real.map((f) => `${f?.File}:${f?.StartLine} ${f?.RuleID}`).join('\n  ')
    problems.push(`gitleaks found ${real.length} leak(s):\n  ${listed}`)
  }

  if (problems.length > 0) return fail(problems.join('\n'))
  return pass(`gitleaks found the canary at ${canaryFile} and no real leaks.`)
}

const CHECKS = {
  trivy: (report, args) => checkTrivy(report, args[0]),
  semgrep: (report, args) => checkSemgrep(report, args),
  gitleaks: (report, args) => checkGitleaks(report, args[0]),
}

function main(argv) {
  const [scanner, reportPath, ...rest] = argv
  const check = CHECKS[scanner]
  if (!check) {
    console.error(`scan-coverage: unknown scanner '${scanner ?? ''}'. Expected one of: ${Object.keys(CHECKS).join(', ')}.`)
    return 1
  }
  if (!reportPath) {
    console.error(`scan-coverage: ${scanner} needs a report file to read.`)
    return 1
  }

  let report
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch (err) {
    // An unreadable report is the same absence of evidence this gate exists to
    // reject, so it fails rather than falling through to a pass.
    console.error(`scan-coverage: could not read ${scanner} report at ${reportPath}: ${err.message}`)
    return 1
  }

  const verdict = check(report, rest)
  if (verdict.ok) {
    console.log(`scan-coverage: ${verdict.reason}`)
    return 0
  }
  console.error(`scan-coverage: ${verdict.reason}`)
  return 1
}

// Only run the CLI when invoked directly, so the tests can import the checks.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)))
}
