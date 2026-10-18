import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { inflightCeiling } from './_deploy-inflight-ceiling'
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
 * while the in-flight run has RUN for less than one deploy's worth of time and
 * is younger than the backstop on its whole life (#2409, both ceilings in
 * deploy-inflight-ceiling.sh).
 *
 * Issue #802 added the fourth input. The check decided "behind" from git history
 * over the apps/worker PATH, while the deploy decides from the built BUNDLE, so a
 * commit touching only worker TEST files read as a strand that no deploy could
 * ever clear: Deploy Worker skips it correctly (the bytes are identical), and the
 * next hourly run sees the same gap again. Live 2026-08-14, #799 merged at 20:55
 * with Deploy Worker skipped, and the check then failed every hour from 21:40
 * onward while nothing whatsoever was unshipped. The alert's own advice was a
 * no-op, since re-running the deploy hits the same artifact gate.
 *
 * So an accusation is now confirmed against the artifact before it is made
 * (LESSONS L119), through the same predicate the deploy uses (L16). A comparison
 * that could not be completed is its OWN outcome, `alert-unconfirmed`, and never
 * a quiet pass (L98).
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/deploy-drift-decision.sh')

/**
 * live sha, whether the latest worker commit is already live, the in-flight
 * answer from deploy-inflight-age.sh, and how the confirming artifact
 * comparison came out ('identical' | 'differs' | 'unknown').
 *
 * The in-flight answer is `age=<s>,running=<s|unknown>` (#2409), '' for no
 * deploy in flight, or `unavailable` when the query failed. A bare number of
 * seconds is read as an age with the running time unknown, which is what every
 * case written before #2409 passes.
 *
 * The artifact argument defaults to 'differs', so every case written before #802
 * keeps meaning what it meant: the worker is genuinely behind on shipping code.
 */
function decide(
  live: string,
  matches: string,
  inflight: string,
  artifact: string = 'differs',
): string {
  return execFileSync('bash', [SCRIPT, live, matches, inflight, artifact], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

const SHA = 'a'.repeat(40)

/** Runs the script and returns only what it wrote to stderr, where the reason goes. */
function reason(live: string, matches: string, inflight: string, artifact = 'differs'): string {
  return execFileSync(
    'bash',
    ['-c', 'bash "$0" "$@" 2>&1 >/dev/null', SCRIPT, live, matches, inflight, artifact],
    { encoding: 'utf8' },
  )
}

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
    expect(out === 'alert-unconfirmed' || out === 'threw').toBe(true)
  })

  it('is ok when behind only by commits that cannot move the bundle, which is #802 exactly', () => {
    // #799 changed four worker test files. Deploy Worker skipped because the
    // built artifact was byte identical, which was correct, and the check then
    // paged hourly for something no deploy could ever clear.
    expect(decide(SHA, 'no', '', 'identical')).toBe('ok')
  })

  it('is ok on an identical artifact even mid-deploy, because there is nothing to ship either way', () => {
    expect(decide(SHA, 'no', '46', 'identical')).toBe('ok')
  })

  it('alerts when the artifact genuinely differs and no deploy is running', () => {
    expect(decide(SHA, 'no', '', 'differs')).toBe('alert')
  })

  it('reports the confirmation as unreached rather than passing when the comparison failed', () => {
    // A build that could not run is not evidence of a healthy worker. Finding
    // nothing must never read as finding everything in order (LESSONS L98).
    expect(decide(SHA, 'no', '', 'unknown')).toBe('alert-unconfirmed')
  })

  it('reports an unreached confirmation distinctly from a confirmed strand', () => {
    // Distinct causes get distinct messages (L11): one says the worker is behind,
    // the other says the check cannot currently tell.
    expect(decide(SHA, 'no', '', 'unknown')).not.toBe(decide(SHA, 'no', '', 'differs'))
  })

  it('treats an unrecognised artifact verdict as unconfirmed, not as a pass', () => {
    expect(decide(SHA, 'no', '', '')).toBe('alert-unconfirmed')
    expect(decide(SHA, 'no', '', 'yes')).toBe('alert-unconfirmed')
  })

  it('still stands down mid-deploy when the confirmation could not be completed', () => {
    // Building at both commits during a deploy is expected to be inconclusive,
    // and a young deploy is not a strand yet either way.
    expect(decide(SHA, 'no', '46', 'unknown')).toBe('deploy-in-flight')
  })

  it('alerts on a stuck deploy even when the artifact comparison failed', () => {
    expect(decide(SHA, 'no', '3600', 'unknown')).toBe('alert')
  })

  it('still reports ok even with a deploy in flight, when nothing is behind', () => {
    // Standing down and being up to date are different answers; a deploy running
    // must not mask a real comparison that already passed.
    expect(decide(SHA, 'yes', '46')).toBe('ok')
  })
})

/**
 * A deploy target with NO artifact gate (#739).
 *
 * The engine worker's deploy decides from the built bundle, which is why history
 * is only a pre-filter for it and an accusation has to be confirmed against the
 * artifact before it is made (#802). The tail worker has no such gate: its deploy
 * job fires on its paths filter alone. So for that target the paths filter IS the
 * deploy's own predicate, the history check asks the identical question, and the
 * two cannot disagree.
 *
 * `not-gated` says exactly that, and it must behave like `differs` rather than
 * like `unknown`: being behind in history is the CONFIRMED condition here, not a
 * suspicion awaiting evidence that will never arrive. Sending it down the
 * unknown path would make the tail check permanently report that it could not
 * confirm, which is a guard that can never say the thing it exists to say.
 */
describe('a target with no artifact gate (#739)', () => {
  it('pages when it is behind and no deploy is running', () => {
    expect(decide('abc1234', 'no', '', 'not-gated')).toBe('alert')
  })

  it('is quiet when it is already up to date', () => {
    expect(decide('abc1234', 'yes', '', 'not-gated')).toBe('ok')
  })

  it('stands down while a young deploy is in flight', () => {
    expect(decide('abc1234', 'no', '120', 'not-gated')).toBe('deploy-in-flight')
  })

  it('still pages when the in-flight deploy is stuck', () => {
    expect(decide('abc1234', 'no', '99999', 'not-gated')).toBe('alert')
  })

  it('still pages when the target reports no commit at all', () => {
    expect(decide('unknown', 'no', '', 'not-gated')).toBe('alert')
  })

  it('does not let an unrecognised verdict reach the same place', () => {
    // The guard on the guard. If a typo in the caller produced something this
    // script does not know, it must land on alert-unconfirmed rather than
    // quietly behaving like a confirmed comparison.
    expect(decide('abc1234', 'no', '', 'not-gate')).toBe('alert-unconfirmed')
  })
})

/**
 * Stuck is judged by RUNNING time, not by age since creation (#2409).
 *
 * The 15:01:03 UTC drift run on 2026-10-18 paged "a deploy has been in flight
 * 1483s, past the 900s ceiling" while Deploy for 50841f3 was healthy: created
 * 14:37:47, finished green 15:06:21, and its jobs held a runner for 753s
 * of that. The rest was jobs waiting for a runner that Deploy for 49c3f3c and
 * pull request CI were using. So the age script now answers with both numbers,
 * and the ceilings live in one sourced file, set from 115 measured runs.
 */
describe('a deploy waiting for runners is not stuck (#2409)', () => {
  const RUNNING = inflightCeiling('MAX_INFLIGHT_RUNNING_SECONDS')
  const AGE = inflightCeiling('MAX_INFLIGHT_AGE_SECONDS')

  it('stands down on the 2026-10-18 reading: 1483s old, 753s of it running', () => {
    expect(decide(SHA, 'no', 'age=1483,running=753')).toBe('deploy-in-flight')
    expect(decide(SHA, 'no', 'age=1483,running=753', 'not-gated')).toBe('deploy-in-flight')
  })

  it('says in the reason how much of the age was running', () => {
    expect(reason(SHA, 'no', 'age=1483,running=753')).toMatch(/1483s[\s\S]*753s/)
  })

  it('pages a deploy that has actually been RUNNING past the ceiling', () => {
    expect(decide(SHA, 'no', `age=${RUNNING + 200},running=${RUNNING + 1}`)).toBe('alert')
    expect(reason(SHA, 'no', `age=${RUNNING + 200},running=${RUNNING + 1}`)).toMatch(/stuck/)
  })

  it('still stands down at exactly the running ceiling', () => {
    expect(decide(SHA, 'no', `age=${RUNNING + 200},running=${RUNNING}`)).toBe('deploy-in-flight')
  })

  it('pages a deploy past the age backstop however little of it ran, so runners that never come still page', () => {
    // L98: without this a run whose jobs never get a runner holds its running
    // time still for ever and "a deploy is running" excuses everything.
    expect(decide(SHA, 'no', `age=${AGE + 1},running=60`)).toBe('alert')
    expect(decide(SHA, 'no', `age=${AGE + 1},running=60`, 'not-gated')).toBe('alert')
    expect(reason(SHA, 'no', `age=${AGE + 1},running=60`)).toMatch(/runner/)
  })

  it('judges the age against the running ceiling when the running time could not be read', () => {
    // The age is an upper bound on the running time, so this can only err
    // toward paging, which is the pre-#2409 behaviour and the loud side.
    expect(decide(SHA, 'no', `age=${RUNNING - 1},running=unknown`)).toBe('deploy-in-flight')
    expect(decide(SHA, 'no', `age=${RUNNING + 1},running=unknown`)).toBe('alert')
    expect(reason(SHA, 'no', `age=${RUNNING + 1},running=unknown`)).toMatch(/could not be read/)
  })

  it('alerts on an answer it cannot read, rather than standing down', () => {
    expect(decide(SHA, 'no', 'age=1483,running=lots')).toBe('alert')
    expect(decide(SHA, 'no', 'running=10,age=10')).toBe('alert')
    expect(decide(SHA, 'no', 'age=,running=10')).toBe('alert')
  })

  it('keeps its ceilings in the one shared file, not a copy of its own (L370)', () => {
    const text = readFileSync(SCRIPT, 'utf8')
    expect(text).toMatch(/deploy-inflight-ceiling\.sh/)
    expect(text).not.toMatch(/MAX_INFLIGHT_\w*=/)
  })
})

describe('the in-flight answer could not be obtained (#899)', () => {
  /**
   * The state behind the 2026-08-19 false page. `gh run list` was refused for
   * want of `actions: read`, its error went to /dev/null, and the empty answer
   * reached this gate as "no deploy is running". So a healthy mid-deploy reading
   * was reported as a stranded deploy.
   *
   * It is its own word rather than plain `alert` because the two need different
   * actions from whoever reads the Slack message: `alert` says re-run the deploy,
   * and this says the check cannot currently tell (L11).
   */
  it('is its own outcome when the target is behind and the query failed', () => {
    expect(decide(SHA, 'no', 'unavailable', 'differs')).toBe('alert-inflight-unknown')
  })

  it('is the same outcome for a target with no artifact gate', () => {
    expect(decide(SHA, 'no', 'unavailable', 'not-gated')).toBe('alert-inflight-unknown')
  })

  it('is ok when the artifact is identical, because nothing is unshipped either way', () => {
    // Checked before the in-flight question on purpose: an identical bundle means
    // there is nothing to ship whatever the pipeline is doing, so a broken query
    // must not turn the #802 no-op case back into a page.
    expect(decide(SHA, 'no', 'unavailable', 'identical')).toBe('ok')
  })

  it('is ok when the latest commit is already live', () => {
    expect(decide(SHA, 'yes', 'unavailable', 'unknown')).toBe('ok')
  })

  it('still reports a broken stamp ahead of it', () => {
    // An unstamped worker is the condition that makes stranding undetectable at
    // all, so it must not be overwritten by a lesser fault in the gate itself.
    expect(decide('unknown', 'no', 'unavailable', 'differs')).toBe('alert')
  })

  it('names the permission in the reason', () => {
    expect(reason(SHA, 'no', 'unavailable', 'differs')).toMatch(/actions: read/)
  })

  it('is not confused with a genuinely unreadable age', () => {
    // A number that will not parse means the query answered nonsense; this means
    // it could not answer. Both are loud, and they point at different things.
    expect(decide(SHA, 'no', 'not-a-number', 'differs')).toBe('alert')
  })
})
