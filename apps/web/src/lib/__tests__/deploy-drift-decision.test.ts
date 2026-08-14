import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * The Deploy Drift check must not page while a deploy is still running.
 *
 * Issue #790. The check compares the live worker's stamped commit to the latest
 * commit touching apps/worker. It had no idea whether a deploy was in flight, so
 * a merge landing shortly before it fired produced a false page. Observed
 * 2026-08-14 to the second:
 *
 *   19:54:54  deploy of 5687bc6 starts (takes about 6 minutes)
 *   19:55:40  drift check runs, reads the worker mid-deploy, sees the old commit, pages
 *   20:00:56  deploy completes successfully
 *
 * Nothing was stranded, and the alert's own advice (re-run the deploy) was a
 * no-op. It is not a rare collision either: GitHub's scheduled runs drift badly,
 * and that day's hourly job actually fired at :55, :12, :05, :10 and :05.
 *
 * LESSONS L36: an alert that cries wolf gets ignored. This one exists to catch a
 * genuinely stranded worker, which has happened for real (#327), so every false
 * page makes the true one likelier to be waved away.
 *
 * THE FAIL-SAFE DIRECTION IS `alert`, and standing down is the narrow exception.
 * In particular a deploy STUCK in progress must still page (L98: finding a reason
 * to stay quiet must not become the only path), so the stand-down applies only
 * while the in-flight run is younger than one deploy's worth of time.
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/deploy-drift-decision.sh')

/** live sha, latest worker commit, whether they match, in-flight deploy age in seconds ('' = none). */
function decide(live: string, matches: string, inflightAgeSeconds: string): string {
  return execFileSync('bash', [SCRIPT, live, matches, inflightAgeSeconds], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

const SHA = 'a'.repeat(40)

describe('deploy-drift decision (#790)', () => {
  it('is ok when the live worker already carries the latest worker commit', () => {
    expect(decide(SHA, 'yes', '')).toBe('ok')
  })

  it('stands down when a deploy is in flight and only just started', () => {
    // The exact 2026-08-14 case: 46 seconds into a 6 minute deploy.
    expect(decide(SHA, 'no', '46')).toBe('deploy-in-flight')
  })

  it('stands down partway through a normal deploy', () => {
    expect(decide(SHA, 'no', '300')).toBe('deploy-in-flight')
  })

  it('alerts when a deploy has been in flight far too long, because a stuck deploy is its own problem', () => {
    expect(decide(SHA, 'no', '3600')).toBe('alert')
  })

  it('alerts when the worker is behind and no deploy is running at all', () => {
    expect(decide(SHA, 'no', '')).toBe('alert')
  })

  it('alerts when the live worker reports no commit, because stamping is then broken', () => {
    expect(decide('unknown', 'no', '')).toBe('alert')
    expect(decide('', 'no', '')).toBe('alert')
  })

  it('alerts on an unreadable in-flight age rather than treating it as a deploy', () => {
    // A parse failure must not buy silence (LESSONS L50: never let an unparsed
    // value land on the permissive side of a comparison).
    expect(decide(SHA, 'no', 'not-a-number')).toBe('alert')
    expect(decide(SHA, 'no', '-5')).toBe('alert')
  })

  it('alerts when called with too few arguments, so a miswired workflow is loud', () => {
    let out = ''
    try {
      out = execFileSync('bash', [SCRIPT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    } catch {
      out = 'threw'
    }
    expect(out === 'alert' || out === 'threw').toBe(true)
  })

  it('still reports ok even with a deploy in flight, when nothing is behind', () => {
    // Standing down and being up to date are different answers; a deploy running
    // must not mask a real comparison that already passed.
    expect(decide(SHA, 'yes', '46')).toBe('ok')
  })
})
