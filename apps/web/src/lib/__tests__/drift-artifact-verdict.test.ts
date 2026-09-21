import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * Turns two worker build hashes into the verdict the Deploy Drift check acts on.
 *
 * Issue #802. The drift check used to accuse from git history alone, so a commit
 * touching only worker TEST files read as a stranded worker that no deploy could
 * ever clear. It now builds the bundle at the live commit and at HEAD and
 * confirms before paging, which makes this the step that decides what those two
 * builds mean.
 *
 * The three answers are deliberately three, not two. `identical` and `differs`
 * are both real measurements; `unknown` says the measurement did not happen, and
 * it must never collapse into either of the others. A build that failed produces
 * no hash, and two failed builds produce two empty hashes, which a naive equality
 * test would read as a match and report as a healthy worker (LESSONS L98: finding
 * nothing must not read as finding everything in order).
 *
 * `identical` is reached ONLY through worker-artifact-decision.sh, the same
 * predicate the deploy itself uses to decide whether to ship, so the two can
 * never drift into disagreeing about what "the worker changed" means (L16).
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/drift-artifact-verdict.sh')

/**
 * The config hashes default to a MATCHING pair so the cases below keep testing
 * the bundle dimension they were written for. The configuration dimension has
 * its own describe block, where both are passed explicitly.
 */
function verdict(
  liveSha: string,
  headHash: string,
  liveHash: string,
  headConfig: string = CFG_A,
  liveConfig: string = CFG_A,
): string {
  return execFileSync('bash', [SCRIPT, liveSha, headHash, liveHash, headConfig, liveConfig], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** Raw, for the argument-count cases, which must not be padded by the helper. */
function verdictRaw(...args: string[]): string {
  return execFileSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

const SHA = 'a'.repeat(40)
const HASH_A = '1'.repeat(64)
const HASH_B = '2'.repeat(64)
const CFG_A = '3'.repeat(64)
const CFG_B = '4'.repeat(64)

describe('drift artifact verdict (#802)', () => {
  it('reports identical when both builds produced the same bundle', () => {
    // The #802 case: behind by worker test files only, which cannot reach the
    // bundle, so the deploy correctly skipped and nothing is unshipped.
    expect(verdict(SHA, HASH_A, HASH_A)).toBe('identical')
  })

  it('reports differs when the two bundles are not the same bytes', () => {
    expect(verdict(SHA, HASH_A, HASH_B)).toBe('differs')
  })

  it('reports unknown when the HEAD build produced no hash', () => {
    expect(verdict(SHA, '', HASH_A)).toBe('unknown')
  })

  it('reports unknown when the build at the live commit produced no hash', () => {
    expect(verdict(SHA, HASH_A, '')).toBe('unknown')
  })

  it('reports unknown, never identical, when BOTH builds failed', () => {
    // Two empty hashes are equal to each other. This is the case that would
    // silently certify a stranded worker as healthy.
    expect(verdict(SHA, '', '')).toBe('unknown')
  })

  it('reports unknown when there is no live commit to have built against', () => {
    expect(verdict('', HASH_A, HASH_A)).toBe('unknown')
    expect(verdict('unknown', HASH_A, HASH_A)).toBe('unknown')
  })

  it('reports unknown when called with too few arguments', () => {
    let out = ''
    try {
      out = execFileSync('bash', [SCRIPT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    } catch {
      out = 'threw'
    }
    expect(out === 'unknown' || out === 'threw').toBe(true)
  })

  it('only ever answers one of the three known words', () => {
    // Guards against a future edit adding a fourth answer that the drift
    // decision script has no branch for and would silently treat as unknown.
    const answers = [
      verdict(SHA, HASH_A, HASH_A),
      verdict(SHA, HASH_A, HASH_B),
      verdict(SHA, '', ''),
      verdict('unknown', HASH_A, HASH_B),
    ]
    for (const a of answers) expect(['identical', 'differs', 'unknown']).toContain(a)
  })
})

/**
 * The configuration dimension (#1420).
 *
 * Deploy Drift exists to notice a committed change that did not ship. On
 * 2026-09-21 one did not ship, and drift reported success 47 minutes later:
 * #1404 changed a wrangler.toml var, which never reaches the bundle, so both
 * builds hashed the same and this said `identical`. The backstop was blind to
 * exactly what the gate it checks was blind to, which is what made the failure
 * silent on both sides.
 */
describe('drift artifact verdict: the deploy-time configuration counts too (#1420)', () => {
  it('reports differs when only the configuration moved', () => {
    expect(verdict(SHA, HASH_A, HASH_A, CFG_A, CFG_B)).toBe('differs')
  })

  it('reports identical only when the bundle AND the configuration match', () => {
    expect(verdict(SHA, HASH_A, HASH_A, CFG_A, CFG_A)).toBe('identical')
  })

  // For drift the fail-safe direction is `unknown`, not `differs`: a missing
  // measurement must not be read as an accusation that the worker is behind.
  it('reports unknown, never identical or differs, when a config hash is missing', () => {
    expect(verdict(SHA, HASH_A, HASH_A, '', '')).toBe('unknown')
    expect(verdict(SHA, HASH_A, HASH_A, CFG_A, '')).toBe('unknown')
    expect(verdict(SHA, HASH_A, HASH_A, '', CFG_A)).toBe('unknown')
  })

  it('reports unknown when called with the old three argument form', () => {
    expect(verdictRaw(SHA, HASH_A, HASH_A)).toBe('unknown')
  })
})
