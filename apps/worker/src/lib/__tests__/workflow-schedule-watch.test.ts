import { describe, expect, it, vi } from 'vitest'
import {
  WATCHED_WORKFLOWS,
  evaluateSchedule,
  lookupLastScheduledRun,
  type ScheduleLookup,
} from '../workflow-schedule-watch'

/**
 * A scheduled GitHub workflow that stops firing is silent in exactly the same way
 * as one that keeps passing (#805).
 *
 * Deploy Drift runs hourly and speaks only when it finds a problem, so a disabled
 * workflow, a broken cron, an expired token, or GitHub suspending schedules on a
 * quiet repo would all silence it permanently with nothing to notice. That is the
 * guard on whether the live bidding engine is running the code on main, so its
 * silence is the most expensive silence in the repo (LESSONS L98).
 *
 * The worker already runs a dead-man's-switch for its OWN crons. This is the same
 * idea pointed at GitHub's schedules, and it reads GitHub's own record of runs
 * rather than asking the workflows to report in, so a workflow that is disabled or
 * deleted is caught by the same predicate as one that merely stopped firing.
 *
 * Two traps this is deliberately shaped around:
 *
 *  - An EMPTY answer from GitHub and a FAILED lookup are indistinguishable if you
 *    only look at the run count, and treating a failure as "it never ran" turns an
 *    API blip into a false accusation (L119). They are separate states here, and
 *    only the confirmed-empty one accuses.
 *  - The lookup counts SCHEDULED runs only. Counting a manual dispatch would let
 *    someone running the workflow by hand mask a cron that has been dead for
 *    weeks, which is the one situation the check exists for.
 */

const HOUR = 3_600_000
const NOW = Date.parse('2026-08-17T12:00:00Z')

const ok = (lastRunIso: string | null): ScheduleLookup => ({ ok: true, lastRunIso })

describe('evaluateSchedule: the settled states', () => {
  it('is healthy when the most recent scheduled run is inside the window', () => {
    const v = evaluateSchedule(ok('2026-08-17T11:17:00Z'), NOW, 4 * HOUR)
    expect(v.status).toBe('healthy')
  })

  it('is stale once the most recent scheduled run is older than the window', () => {
    const v = evaluateSchedule(ok('2026-08-17T02:17:00Z'), NOW, 4 * HOUR)
    expect(v.status).toBe('stale')
    expect(v.ageMs).toBe(NOW - Date.parse('2026-08-17T02:17:00Z'))
  })

  it('does not trip on ordinary GitHub schedule drift', () => {
    // GitHub's scheduled runs drift badly. This repo has recorded an hourly job
    // firing at :55, :12, :05, :10 and :05 on one day. A window barely above the
    // cadence would page on that alone, and an alert that cries wolf gets ignored
    // (L36), so the hourly workflow's window is hours rather than minutes.
    const drift = WATCHED_WORKFLOWS.find((w) => w.file === 'deploy-drift.yml')
    expect(drift, 'deploy-drift.yml is no longer watched').toBeDefined()
    expect(drift!.staleMs).toBeGreaterThan(2 * HOUR)
  })
})

describe('evaluateSchedule: telling a failed lookup from a real absence', () => {
  it('accuses only when GitHub confirmed there are no scheduled runs', () => {
    expect(evaluateSchedule(ok(null), NOW, 4 * HOUR).status).toBe('never_ran')
  })

  it('reports a failed lookup as its own state rather than as never having run', () => {
    // The L119 trap. A missing answer and a real violation look identical if you
    // read only the count, and a false accusation is what teaches everyone to
    // ignore the alert.
    const v = evaluateSchedule({ ok: false, reason: 'GitHub returned 403' }, NOW, 4 * HOUR)
    expect(v.status).toBe('unreadable')
    expect(v.detail).toContain('403')
  })

  it('reports missing configuration as unreadable, not as healthy', () => {
    // An unset value arrives as the empty string rather than as absent, so this
    // must be an explicit state and never a silent pass (L138, L98).
    const v = evaluateSchedule({ ok: false, reason: 'GITHUB_CODE_REPO is not set' }, NOW, 4 * HOUR)
    expect(v.status).toBe('unreadable')
  })

  it('carries an age of null when there is nothing to measure', () => {
    expect(evaluateSchedule(ok(null), NOW, 4 * HOUR).ageMs).toBeNull()
    expect(evaluateSchedule({ ok: false, reason: 'x' }, NOW, 4 * HOUR).ageMs).toBeNull()
  })
})

describe('the registry covers every scheduled workflow in the repo', () => {
  it('watches more than the one workflow that prompted this', () => {
    // L30: fix the class, not the instance. Every workflow on a schedule has the
    // same silence, so a registry with one entry would leave the next one blind.
    expect(WATCHED_WORKFLOWS.length).toBeGreaterThan(1)
  })

  it('gives every watched workflow a window comfortably above its own cadence', () => {
    for (const w of WATCHED_WORKFLOWS) {
      expect(w.staleMs, `${w.file} has no staleness window`).toBeGreaterThan(0)
      expect(w.dependents, `${w.file} does not say what breaks while it is dark`).not.toBe('')
      expect(w.label, `${w.file} has no label`).not.toBe('')
    }
  })
})

describe('lookupLastScheduledRun: what it actually asks GitHub', () => {
  const env = { GITHUB_TOKEN: 'tok', GITHUB_CODE_REPO: 'Try-Pennie/bidspoke' }

  it('asks only for scheduled runs, so a manual dispatch cannot mask a dead cron', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ workflow_runs: [{ created_at: '2026-08-17T11:17:00Z' }] }), { status: 200 }),
    )
    const result = await lookupLastScheduledRun(env, 'deploy-drift.yml', fetchMock)
    expect(result).toEqual({ ok: true, lastRunIso: '2026-08-17T11:17:00Z' })

    const url = String(fetchMock.mock.calls[0][0])
    expect(url, 'the lookup counts runs of every kind, so running it by hand hides a dead schedule').toContain(
      'event=schedule',
    )
    expect(url).toContain('deploy-drift.yml')
  })

  it('reports a confirmed empty list as a real absence', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 }),
    )
    expect(await lookupLastScheduledRun(env, 'deploy-drift.yml', fetchMock)).toEqual({
      ok: true,
      lastRunIso: null,
    })
  })

  it('reports a non-200 as a failed lookup, naming the status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }))
    const result = await lookupLastScheduledRun(env, 'deploy-drift.yml', fetchMock)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('403')
  })

  it('reports a thrown network error as a failed lookup, not as an absence', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT'))
    const result = await lookupLastScheduledRun(env, 'deploy-drift.yml', fetchMock)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('ETIMEDOUT')
  })

  it('reports a malformed body as a failed lookup rather than reading it as empty', async () => {
    // A body that is not the shape expected must not collapse to "no runs", which
    // is an accusation.
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html>nope</html>', { status: 200 }))
    const result = await lookupLastScheduledRun(env, 'deploy-drift.yml', fetchMock)
    expect(result.ok).toBe(false)
  })

  it('refuses without a token instead of calling GitHub unauthenticated', async () => {
    const fetchMock = vi.fn()
    const result = await lookupLastScheduledRun({ GITHUB_CODE_REPO: 'a/b' }, 'x.yml', fetchMock)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('GITHUB_TOKEN')
    expect(fetchMock, 'it called GitHub anyway').not.toHaveBeenCalled()
  })

  it('treats an empty repo name as unset rather than building a broken URL', async () => {
    const fetchMock = vi.fn()
    const result = await lookupLastScheduledRun({ GITHUB_TOKEN: 't', GITHUB_CODE_REPO: '' }, 'x.yml', fetchMock)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('GITHUB_CODE_REPO')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
