import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'
import { checkGitleaks, checkSemgrep, checkTrivy } from '../../../../../.github/scripts/scan-coverage.mjs'

/**
 * Issue #779. The `Security scans` job reported success on every run from
 * 2026-07-27 to 2026-08-14 while auditing NOTHING. `pnpm-lock.yaml` carried a
 * duplicated entry, Trivy could not parse it, so it skipped the file, found zero
 * targets and exited 0. Its summary read `- | - | -`, where `-` is Trivy's marker
 * for *not scanned*, not for clean. The moment the lockfile was repaired (#778)
 * the same job found a real HIGH that had been sitting there invisibly.
 *
 * LESSONS L98: a check that reports success having found NOTHING to check is
 * indistinguishable from one that saw everything pass, and the empty result
 * arrives exactly when a green verdict is most likely to be believed.
 *
 * Each scanner therefore has to PROVE it covered its subject before the job may
 * pass, and each proof is measured against what that scanner really emits
 * (verified 2026-08-14 against trivy 0.72.0, gitleaks 8.21.2, semgrep 1.172.0,
 * including reproducing the corrupt-lockfile case, which really does yield
 * `Results: null` and exit 0):
 *
 *   trivy    the JSON report must carry a result for pnpm-lock.yaml with a
 *            recognised ecosystem type. A clean scan still emits that entry with
 *            zero vulnerabilities, so present-and-clean is distinguishable from
 *            never-scanned.
 *   semgrep  `paths.scanned` must cover every source tree the job claims to
 *            audit. It is `[]` when semgrep ran over nothing, and semgrep still
 *            exits 0.
 *   gitleaks emits no coverage signal at all, so the run plants a canary secret
 *            and the scan has to FIND it. That proves the files were read AND
 *            that the rules still fire, which a file count cannot: a broad
 *            allowlist would suppress every finding while coverage looked fine.
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/scan-coverage.mjs')

const CANARY = 'gitleaks-canary.tmp.txt'

/** A trivy report that scanned the lockfile and found nothing wrong. */
const trivyClean = {
  Results: [{ Target: 'pnpm-lock.yaml', Type: 'pnpm', Class: 'lang-pkgs' }],
}

describe('trivy coverage (#779)', () => {
  it('passes when the lockfile was scanned and is clean', () => {
    const r = checkTrivy(trivyClean, 'pnpm-lock.yaml')
    expect(r.ok).toBe(true)
  })

  it('fails when Results is null, which is what a lockfile trivy cannot parse produces', () => {
    // The exact 2026-07-27 shape. Trivy exits 0 here, so nothing else notices.
    const r = checkTrivy({ Results: null }, 'pnpm-lock.yaml')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/pnpm-lock\.yaml/)
  })

  it('fails when Results is missing entirely', () => {
    expect(checkTrivy({}, 'pnpm-lock.yaml').ok).toBe(false)
  })

  it('fails when some other target was scanned but the lockfile was not', () => {
    const r = checkTrivy({ Results: [{ Target: 'Dockerfile', Type: 'dockerfile' }] }, 'pnpm-lock.yaml')
    expect(r.ok).toBe(false)
  })

  it('fails when the lockfile appears with no ecosystem type, so nothing was really resolved', () => {
    const r = checkTrivy({ Results: [{ Target: 'pnpm-lock.yaml', Type: '' }] }, 'pnpm-lock.yaml')
    expect(r.ok).toBe(false)
  })

  it('fails, and names the advisory, when the scan found a vulnerability', () => {
    const r = checkTrivy(
      {
        Results: [
          {
            Target: 'pnpm-lock.yaml',
            Type: 'pnpm',
            Vulnerabilities: [
              { VulnerabilityID: 'CVE-2026-67213', PkgName: 'nanoid', InstalledVersion: '3.3.16', FixedVersion: '3.3.18', Severity: 'HIGH' },
            ],
          },
        ],
      },
      'pnpm-lock.yaml',
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/nanoid/)
    expect(r.reason).toMatch(/CVE-2026-67213/)
  })
})

describe('semgrep coverage (#779)', () => {
  const scanned = (files: string[]) => ({ paths: { scanned: files }, results: [] })

  it('passes when every required tree was scanned and nothing was found', () => {
    const r = checkSemgrep(scanned(['apps/worker/src/index.ts', 'apps/web/src/app/page.tsx']), [
      'apps/worker/src/',
      'apps/web/src/',
    ])
    expect(r.ok).toBe(true)
  })

  it('fails when semgrep scanned nothing at all', () => {
    const r = checkSemgrep(scanned([]), ['apps/worker/src/'])
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/apps\/worker\/src\//)
  })

  it('fails when one required tree is missing, even though the other was scanned', () => {
    // The silent-exclusion case: an --exclude that grows until half the repo is
    // unaudited still leaves a healthy-looking non-zero file count.
    const r = checkSemgrep(scanned(['apps/web/src/app/page.tsx']), ['apps/worker/src/', 'apps/web/src/'])
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/apps\/worker\/src\//)
    expect(r.reason).not.toMatch(/apps\/web\/src\/ /)
  })

  it('fails when the scan produced a finding', () => {
    const report = {
      paths: { scanned: ['apps/worker/src/index.ts'] },
      results: [{ check_id: 'javascript.lang.security.audit.code-string-concat', path: 'apps/worker/src/index.ts', start: { line: 12 } }],
    }
    const r = checkSemgrep(report, ['apps/worker/src/'])
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/code-string-concat/)
  })

  it('fails when paths.scanned is absent rather than empty', () => {
    expect(checkSemgrep({ results: [] }, ['apps/worker/src/']).ok).toBe(false)
  })

  it('matches a required tree by prefix, not by exact path', () => {
    const r = checkSemgrep(scanned(['apps/worker/src/engine/nodes/partner-bid.ts']), ['apps/worker/src/'])
    expect(r.ok).toBe(true)
  })
})

describe('gitleaks coverage (#779)', () => {
  const canaryFinding = { RuleID: 'github-pat', File: CANARY, StartLine: 1 }

  it('passes when the canary was found and nothing else was', () => {
    const r = checkGitleaks([canaryFinding], CANARY)
    expect(r.ok).toBe(true)
  })

  it('fails when the canary was NOT found, because the scan proved nothing', () => {
    // An empty report is exactly what a scan over nothing produces, and it is
    // also exactly what a clean scan produces. The canary is what tells them
    // apart.
    const r = checkGitleaks([], CANARY)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/canary/i)
  })

  it('fails when a real leak was found alongside the canary', () => {
    const real = { RuleID: 'aws-access-token', File: 'apps/worker/src/lib/secrets.ts', StartLine: 4 }
    const r = checkGitleaks([canaryFinding, real], CANARY)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/secrets\.ts/)
  })

  it('fails when a real leak was found and the canary was suppressed', () => {
    // The worst case: an allowlist broad enough to swallow the canary is broad
    // enough to swallow the real one, so both halves must be reported.
    const real = { RuleID: 'aws-access-token', File: 'apps/worker/src/lib/secrets.ts', StartLine: 4 }
    const r = checkGitleaks([real], CANARY)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/canary/i)
    expect(r.reason).toMatch(/secrets\.ts/)
  })

  it('does not accept a canary finding reported against a different file', () => {
    const elsewhere = { RuleID: 'github-pat', File: 'docs/example.md', StartLine: 1 }
    expect(checkGitleaks([elsewhere], CANARY).ok).toBe(false)
  })
})

describe('scan-coverage CLI (#779)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scan-coverage-'))

  const run = (scanner: string, report: unknown, ...rest: string[]) => {
    const file = path.join(dir, `${scanner}-${Math.abs(JSON.stringify(report).length)}.json`)
    writeFileSync(file, JSON.stringify(report))
    try {
      const stdout = execFileSync('node', [SCRIPT, scanner, file, ...rest], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, out: stdout }
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string }
      return { code: err.status, out: `${err.stdout}${err.stderr}` }
    }
  }

  it('exits 0 on a covered, clean trivy report', () => {
    expect(run('trivy', trivyClean, 'pnpm-lock.yaml').code).toBe(0)
  })

  it('exits non-zero on the uncovered trivy report', () => {
    const r = run('trivy', { Results: null }, 'pnpm-lock.yaml')
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/pnpm-lock\.yaml/)
  })

  it('exits non-zero when the report file does not exist', () => {
    // An unreadable report must never read as a pass: it is the same absence of
    // evidence the whole gate exists to reject.
    let code = 0
    try {
      execFileSync('node', [SCRIPT, 'trivy', path.join(dir, 'nope.json'), 'pnpm-lock.yaml'], { stdio: 'pipe' })
    } catch (e) {
      code = (e as { status: number }).status
    }
    expect(code).not.toBe(0)
  })

  it('exits non-zero when the report is not valid JSON', () => {
    const file = path.join(dir, 'garbage.json')
    writeFileSync(file, 'not json at all')
    let code = 0
    try {
      execFileSync('node', [SCRIPT, 'trivy', file, 'pnpm-lock.yaml'], { stdio: 'pipe' })
    } catch (e) {
      code = (e as { status: number }).status
    }
    expect(code).not.toBe(0)
  })

  it('exits non-zero on an unknown scanner name rather than passing silently', () => {
    const r = run('nosuchscanner', {})
    expect(r.code).not.toBe(0)
  })
})
