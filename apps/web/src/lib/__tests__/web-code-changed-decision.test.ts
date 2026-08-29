import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * One shared decision for "did anything that can move the web artifact change?"
 * (#968, and the a11y scoping #887 already shipped).
 *
 * Two jobs build the next-on-pages artifact on every pull request: the
 * accessibility scan and the auth gate probe. The auth gate takes 121 to 144s,
 * of which 84s is that build and 2s is the actual probe, and it ran in full on
 * pure backend pull requests where nothing that could move the artifact had
 * changed.
 *
 * THE DIRECTION THAT MATTERS IS `true`. Both jobs are gates, so they withhold
 * nothing and only ever cost time; the expensive mistake is skipping a scan that
 * would have caught something. A gate that quietly switches itself off is the
 * exact rot the a11y job's own comments name. So the skip is legitimate only
 * when the job can PROVE nothing relevant changed, and every other outcome runs
 * (L42, L72). Seven wasted minutes is cheap; a regression waved through by a
 * detection bug is not.
 *
 * One script rather than a copy per job, because two hand-rolled fail-closed
 * detections in one file will drift, and the half that drifts is the half nobody
 * looks at.
 */
const script = path.join(REPO_ROOT, '.github/scripts/web-code-changed.sh')

/** `decide(prNumber, lookupOk, files)`. Returns 'true' or 'false'. */
function decide(...args: string[]): string {
  return execFileSync('bash', [script, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

describe('web-code-changed: skips only on proof (#968)', () => {
  it('skips when a pull request touches nothing that can reach the artifact', () => {
    expect(decide('42', 'true', 'apps/worker/src/engine/index.ts\ndocs/foo.md')).toBe('false')
  })

  it('runs when web source changed', () => {
    expect(decide('42', 'true', 'apps/worker/src/x.ts\napps/web/src/app/page.tsx')).toBe('true')
  })

  it('runs when a shared package changed, because both apps compile it in', () => {
    expect(decide('42', 'true', 'packages/uuidv7/src/index.ts')).toBe('true')
  })

  it('runs when the lockfile changed, because a dependency bump can move the artifact', () => {
    // This is also what keeps Dependabot pull requests covered: they touch the
    // lockfile, so they still build and still probe.
    expect(decide('42', 'true', 'pnpm-lock.yaml')).toBe('true')
  })

  it('runs when a package manifest changed', () => {
    expect(decide('42', 'true', 'package.json')).toBe('true')
    expect(decide('42', 'true', 'apps/web/package.json')).toBe('true')
  })
})

describe('web-code-changed: fails closed on anything it cannot tell (#968)', () => {
  it('runs when this is not a pull request at all', () => {
    // A push to main has no pull request to ask about. It must never be read as
    // "nothing changed".
    expect(decide('', 'true', 'apps/worker/src/x.ts')).toBe('true')
  })

  it('runs when the changed-files lookup failed', () => {
    // The distinction L119 is about: an empty answer from a failed query is not
    // evidence of absence.
    expect(decide('42', 'false', '')).toBe('true')
    expect(decide('42', 'false', 'apps/worker/src/x.ts')).toBe('true')
  })

  it('runs when the lookup succeeded but returned nothing', () => {
    // A pull request always changes at least one file, so an empty list means
    // the query did not do what it claimed, whatever it reported.
    expect(decide('42', 'true', '')).toBe('true')
  })

  it('runs when the lookup status is anything other than a clear success', () => {
    for (const status of ['', 'ERR', 'unknown', 'maybe', 'TRUE']) {
      expect(decide('42', status, 'apps/worker/src/x.ts'), `status '${status}'`).toBe('true')
    }
  })

  it('runs when called with too few arguments', () => {
    expect(decide()).toBe('true')
    expect(decide('42')).toBe('true')
    expect(decide('42', 'true')).toBe('true')
  })
})

describe('web-code-changed: matches whole path segments, not substrings', () => {
  it('does not treat a lookalike path as web code', () => {
    // `docs/apps/web-guide.md` and `apps/website-notes/x.md` both contain the
    // characters "apps/web". Matching on a substring would run the expensive
    // jobs on documentation forever, and the same looseness in the other
    // direction is how a filter starts matching things nobody meant (L104).
    expect(decide('42', 'true', 'docs/apps/web-guide.md')).toBe('false')
    expect(decide('42', 'true', 'apps/worker-tail/src/index.ts')).toBe('false')
  })

  it('does not treat a nested lockfile as the root one', () => {
    expect(decide('42', 'true', 'vendor/thing/pnpm-lock.yaml')).toBe('false')
  })
})

describe('web-code-changed: is a decision, never a build outcome', () => {
  it('prints exactly one of true or false and nothing else on stdout', () => {
    for (const args of [['42', 'true', 'apps/web/x.ts'], ['42', 'true', 'docs/x.md'], []]) {
      const out = execFileSync('bash', [script, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(out.trim().split('\n')).toHaveLength(1)
      expect(['true', 'false']).toContain(out.trim())
    }
  })

  it('exits 0 on every input, so the script itself never decides the build', () => {
    for (const args of [['42', 'true', 'apps/web/x.ts'], [], ['x', 'y', 'z']]) {
      expect(() => execFileSync('bash', [script, ...args], { stdio: 'pipe' })).not.toThrow()
    }
  })
})
