import { describe, expect, it, vi } from 'vitest'
import {
  WATCHED_WORKFLOWS,
  checkRepoAccess,
  evaluateSchedule,
  DRIVER_MARKER,
  lookupLastScheduledRun,
  formatScheduleSummary,
  resolveGithubAccess,
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
 * Three traps this is deliberately shaped around:
 *
 *  - An EMPTY answer from GitHub and a FAILED lookup are indistinguishable if you
 *    only look at the run count, and treating a failure as "it never ran" turns an
 *    API blip into a false accusation (L119). They are separate states here, and
 *    only the confirmed-empty one accuses.
 *  - The lookup counts SCHEDULED runs only. Counting a manual dispatch would let
 *    someone running the workflow by hand mask a cron that has been dead for
 *    weeks, which is the one situation the check exists for.
 *  - A run that FIRED and FAILED is the same silence wearing a different hat
 *    (#844). The first version read only the timestamp, so a workflow failing
 *    every single night reported as healthy.
 */

const HOUR = 3_600_000
const NOW = Date.parse('2026-08-17T12:00:00Z')

/** A readable answer with no failures behind it. */
const ok = (lastRunIso: string | null): ScheduleLookup => ({
  ok: true,
  lastRunIso,
  conclusions: lastRunIso === null ? [] : ['success'],
})

/** A readable answer whose most recent runs concluded as given, newest first. */
const ranWith = (lastRunIso: string, conclusions: (string | null)[]): ScheduleLookup => ({
  ok: true,
  lastRunIso,
  conclusions,
})

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

  it('separates a workflow GitHub has never heard of from one it cannot read', () => {
    // Only reachable once the repository itself has been read successfully, so a
    // 404 on the file means the registry names a workflow that is not there any
    // more. Calling that "cannot tell" would claim less than the check measured
    // (L11) and would leave a stale registry entry alerting for ever with no
    // reason anyone could act on.
    const v = evaluateSchedule(
      { ok: false, reason: 'GitHub has no workflow file named gone.yml', missing: true },
      NOW,
      4 * HOUR,
    )
    expect(v.status).toBe('missing')
  })
})

describe('evaluateSchedule: a workflow that fires and fails (#844)', () => {
  it('reports a run of failures as its own state rather than as healthy', () => {
    // The whole point of #844. The first version read `created_at` and nothing
    // else, so a nightly job failing every single night was indistinguishable
    // from one passing every night.
    const v = evaluateSchedule(ranWith('2026-08-17T11:17:00Z', ['failure', 'failure']), NOW, 4 * HOUR)
    expect(v.status).toBe('failing')
    expect(v.detail).toContain('2')
  })

  it('counts a timeout and a startup failure as failures', () => {
    const v = evaluateSchedule(
      ranWith('2026-08-17T11:17:00Z', ['timed_out', 'startup_failure']),
      NOW,
      4 * HOUR,
    )
    expect(v.status).toBe('failing')
  })

  it('stays quiet about a single failure, which is a blip rather than a pattern', () => {
    // Each watched workflow already alerts on its own failure. This is the slower
    // backstop for a failure that PERSISTS, and firing on one run would make it
    // duplicate every ordinary transient (L36).
    const v = evaluateSchedule(ranWith('2026-08-17T11:17:00Z', ['failure', 'success']), NOW, 4 * HOUR)
    expect(v.status).toBe('healthy')
  })

  it('does not read a cancelled or still-running run as a failure', () => {
    // `null` is a run in flight and `cancelled` is somebody stopping it by hand.
    // Neither is evidence the workflow is broken, and both still prove the
    // schedule fired.
    expect(evaluateSchedule(ranWith('2026-08-17T11:17:00Z', [null, null]), NOW, 4 * HOUR).status).toBe('healthy')
    expect(
      evaluateSchedule(ranWith('2026-08-17T11:17:00Z', ['cancelled', 'cancelled']), NOW, 4 * HOUR).status,
    ).toBe('healthy')
  })

  it('reports a workflow that stopped running ahead of one that was failing', () => {
    // If it both failed twice and then stopped firing, "it stopped" is the bigger
    // news and names the action to take.
    const v = evaluateSchedule(ranWith('2026-08-15T11:17:00Z', ['failure', 'failure']), NOW, 4 * HOUR)
    expect(v.status).toBe('stale')
  })
})

describe('resolveGithubAccess: which credential the check uses (#842)', () => {
  it('prefers the dedicated read-only token and says which one it used', () => {
    // The reason a message can name the right secret. The check shipped borrowing
    // the backup repo's token, which cannot see this repository at all, so the
    // variable in use has to be part of what the failure reports.
    const access = resolveGithubAccess({
      GITHUB_CODE_REPO: 'Try-Pennie/bidspoke',
      GITHUB_ACTIONS_TOKEN: 'dedicated',
      GITHUB_TOKEN: 'backup-repo-token',
    })
    expect(access.ok).toBe(true)
    expect(access.ok === true && access.token).toBe('dedicated')
    expect(access.ok === true && access.tokenVar).toBe('GITHUB_ACTIONS_TOKEN')
  })

  it('falls back to the backup token so the check does not go dark before the new secret is set', () => {
    const access = resolveGithubAccess({
      GITHUB_CODE_REPO: 'Try-Pennie/bidspoke',
      GITHUB_TOKEN: 'backup-repo-token',
    })
    expect(access.ok === true && access.tokenVar).toBe('GITHUB_TOKEN')
  })

  it('names both variables when there is no token at all, so the fix is actionable', () => {
    const access = resolveGithubAccess({ GITHUB_CODE_REPO: 'Try-Pennie/bidspoke' })
    expect(access.ok).toBe(false)
    expect(access.ok === false && access.reason).toContain('GITHUB_ACTIONS_TOKEN')
    expect(access.ok === false && access.reason).toContain('GITHUB_TOKEN')
  })

  it('treats an empty value as unset rather than as a credential', () => {
    // An unset worker var arrives as the empty string, so an absence check written
    // as a null fallback silently accepts it (L138).
    const access = resolveGithubAccess({ GITHUB_CODE_REPO: 'Try-Pennie/bidspoke', GITHUB_ACTIONS_TOKEN: '  ' })
    expect(access.ok).toBe(false)
    const withRepoUnset = resolveGithubAccess({ GITHUB_CODE_REPO: '', GITHUB_ACTIONS_TOKEN: 'tok' })
    expect(withRepoUnset.ok).toBe(false)
    expect(withRepoUnset.ok === false && withRepoUnset.reason).toContain('GITHUB_CODE_REPO')
  })
})

describe('checkRepoAccess: proving the credential can see this repository (#842)', () => {
  const access = { ok: true as const, repo: 'Try-Pennie/bidspoke', token: 'tok', tokenVar: 'GITHUB_TOKEN' as const }

  it('reads the repository itself, so a per-workflow 404 means something', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    expect(await checkRepoAccess(access, fetchMock)).toEqual({ ok: true })
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toBe('https://api.github.com/repos/Try-Pennie/bidspoke')
  })

  it('reports a 404 as the credential not being able to see the repository', async () => {
    // The live failure. This repository is private, and GitHub answers 404 rather
    // than 403 for a private repository a token cannot see, so the message has to
    // say "cannot see it" and not "it is not there".
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }))
    const verdict = await checkRepoAccess(access, fetchMock)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('GITHUB_TOKEN')
    expect(verdict.ok === false && verdict.reason).toContain('Try-Pennie/bidspoke')
  })

  it('distinguishes a rejected credential from one with no visibility', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad creds', { status: 401 }))
    const verdict = await checkRepoAccess(access, fetchMock)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('401')
  })

  it('reports a thrown network error rather than reading it as no access', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT'))
    const verdict = await checkRepoAccess(access, fetchMock)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('ETIMEDOUT')
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
  const access = { ok: true as const, repo: 'Try-Pennie/bidspoke', token: 'tok', tokenVar: 'GITHUB_TOKEN' as const }

  const runs = (body: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))

  it('counts a scheduled run', async () => {
    const fetchMock = runs({
      workflow_runs: [{ created_at: '2026-08-17T11:17:00Z', conclusion: 'success', event: 'schedule' }],
    })
    const result = await lookupLastScheduledRun(access, 'deploy-drift.yml', fetchMock)
    expect(result).toEqual({ ok: true, lastRunIso: '2026-08-17T11:17:00Z', conclusions: ['success'] })
    expect(String(fetchMock.mock.calls[0][0])).toContain('deploy-drift.yml')
  })

  it('counts a run the worker driver dispatched, because that IS the check running', async () => {
    // GitHub stopped delivering this repo's cron events on 2026-08-26 while
    // on-demand triggers kept working, so the worker now dispatches these
    // workflows itself (#1058). A driven run has to count, or the watch would
    // alert for ever about a check that is in fact running every hour.
    const fetchMock = runs({
      workflow_runs: [
        {
          created_at: '2026-08-17T11:17:00Z',
          conclusion: 'success',
          event: 'workflow_dispatch',
          display_title: `Deploy Drift (${DRIVER_MARKER})`,
        },
      ],
    })
    const result = await lookupLastScheduledRun(access, 'deploy-drift.yml', fetchMock)
    expect(result).toEqual({ ok: true, lastRunIso: '2026-08-17T11:17:00Z', conclusions: ['success'] })
  })

  it('still ignores a dispatch a PERSON started, so a manual press cannot mask a dead schedule', async () => {
    // The property the old `event=schedule` filter existed to protect, kept
    // intact now that the filter is gone: somebody pressing Run workflow once
    // must not read as the schedule being alive.
    const fetchMock = runs({
      workflow_runs: [
        { created_at: '2026-08-17T11:17:00Z', conclusion: 'success', event: 'workflow_dispatch', display_title: 'Deploy Drift (manual)' },
        { created_at: '2026-08-10T09:17:00Z', conclusion: 'success', event: 'schedule', display_title: 'Deploy Drift' },
      ],
    })
    const result = await lookupLastScheduledRun(access, 'deploy-drift.yml', fetchMock)
    expect(
      result.ok === true && result.lastRunIso,
      'the manual press was counted, so a dead schedule now reads as healthy',
    ).toBe('2026-08-10T09:17:00Z')
  })

  it('reports only unqualifying runs as a real absence rather than reading the newest anyway', async () => {
    const fetchMock = runs({
      workflow_runs: [{ created_at: '2026-08-17T11:17:00Z', conclusion: 'success', event: 'workflow_dispatch', display_title: 'Deploy Drift (manual)' }],
    })
    const result = await lookupLastScheduledRun(access, 'deploy-drift.yml', fetchMock)
    expect(result).toEqual({ ok: true, lastRunIso: null, conclusions: [] })
  })

  it('builds the failure streak only from qualifying runs', async () => {
    // A manual press that happened to succeed must not break a streak of real
    // scheduled failures, and one that failed must not manufacture a streak.
    const fetchMock = runs({
      workflow_runs: [
        { created_at: '2026-08-17T11:17:00Z', conclusion: 'failure', event: 'schedule' },
        { created_at: '2026-08-17T10:30:00Z', conclusion: 'success', event: 'workflow_dispatch', display_title: 'Deploy Drift (manual)' },
        { created_at: '2026-08-17T10:17:00Z', conclusion: 'failure', event: 'schedule' },
      ],
    })
    const result = await lookupLastScheduledRun(access, 'deploy-drift.yml', fetchMock)
    expect(result.ok === true && result.conclusions).toEqual(['failure', 'failure'])
  })

  it('asks for more than one run, so a run of failures can be seen at all', async () => {
    // A page size of one cannot distinguish a blip from a workflow failing every
    // night, which is the whole subject of #844.
    const fetchMock = runs({ workflow_runs: [] })
    await lookupLastScheduledRun(access, 'deploy-drift.yml', fetchMock)
    const perPage = Number(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('per_page'))
    expect(perPage).toBeGreaterThan(1)
  })

  it('carries the conclusions back in order, newest first', async () => {
    const fetchMock = runs({
      workflow_runs: [
        { created_at: '2026-08-17T11:17:00Z', conclusion: 'failure', event: 'schedule' },
        { created_at: '2026-08-17T10:17:00Z', conclusion: 'success', event: 'schedule' },
      ],
    })
    const result = await lookupLastScheduledRun(access, 'deploy-drift.yml', fetchMock)
    expect(result.ok === true && result.conclusions).toEqual(['failure', 'success'])
    expect(result.ok === true && result.lastRunIso).toBe('2026-08-17T11:17:00Z')
  })

  it('reports a confirmed empty list as a real absence', async () => {
    const result = await lookupLastScheduledRun(access, 'deploy-drift.yml', runs({ workflow_runs: [] }))
    expect(result).toEqual({ ok: true, lastRunIso: null, conclusions: [] })
  })

  it('reports runs that carry no trigger at all as unreadable, not as an absence', async () => {
    // If GitHub ever stops returning `event`, every run becomes unqualifying and
    // the filter would report a busy workflow as never having run: an accusation
    // built on an answer we could not read (L119, L11). A page of runs where NONE
    // names its trigger is an API shape we do not understand, and must say so.
    const fetchMock = runs({
      workflow_runs: [
        { created_at: '2026-08-17T11:17:00Z', conclusion: 'success' },
        { created_at: '2026-08-17T10:17:00Z', conclusion: 'success' },
      ],
    })
    const result = await lookupLastScheduledRun(access, 'deploy-drift.yml', fetchMock)
    expect(result.ok, 'an unreadable page was reported as a workflow that never ran').toBe(false)
    expect(result.ok === false && result.missing).not.toBe(true)
  })

  it('reports a page of readable but unqualifying runs as a genuine absence', async () => {
    // The other side of the line above: these runs DID name their trigger, and
    // none of them counts. That is a real reading, not a broken one.
    const fetchMock = runs({
      workflow_runs: [
        { created_at: '2026-08-17T11:17:00Z', conclusion: 'success', event: 'workflow_dispatch', display_title: 'by hand' },
        { created_at: '2026-08-17T10:17:00Z', conclusion: 'success', event: 'push' },
      ],
    })
    const result = await lookupLastScheduledRun(access, 'deploy-drift.yml', fetchMock)
    expect(result).toEqual({ ok: true, lastRunIso: null, conclusions: [] })
  })

  it('reports a non-200 as a failed lookup, naming the status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }))
    const result = await lookupLastScheduledRun(access, 'deploy-drift.yml', fetchMock)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('403')
  })

  it('marks a 404 as a workflow that is not there, not merely unreadable', async () => {
    // Reached only after the repository itself read cleanly, so this says the
    // registry names a file GitHub does not have.
    const fetchMock = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }))
    const result = await lookupLastScheduledRun(access, 'gone.yml', fetchMock)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.missing).toBe(true)
  })

  it('reports a thrown network error as a failed lookup, not as an absence', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT'))
    const result = await lookupLastScheduledRun(access, 'deploy-drift.yml', fetchMock)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('ETIMEDOUT')
  })

  it('reports a malformed body as a failed lookup rather than reading it as empty', async () => {
    // A body that is not the shape expected must not collapse to "no runs", which
    // is an accusation.
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html>nope</html>', { status: 200 }))
    const result = await lookupLastScheduledRun(access, 'deploy-drift.yml', fetchMock)
    expect(result.ok).toBe(false)
  })
})

describe('formatScheduleSummary: making a working check visible (#842)', () => {
  it('names every workflow and its age even when everything is healthy', () => {
    // Without this, the only visible result of fixing the credential is that the
    // alerts stop, and silence is exactly what this check exists to distrust. A
    // fresh reading with a real age in it is the positive confirmation that the
    // lookup is working at all (L98, L106).
    const line = formatScheduleSummary([
      { file: 'deploy-drift.yml', status: 'healthy', alerted: false, ageMs: 2 * HOUR, detail: '' },
      { file: 'db-types-drift.yml', status: 'healthy', alerted: false, ageMs: 5 * HOUR, detail: '' },
    ])
    expect(line).toContain('deploy-drift.yml')
    expect(line).toContain('db-types-drift.yml')
    expect(line).toContain('healthy')
    expect(line, 'an age is what proves a real reading was taken').toMatch(/2h/)
  })

  it('says so plainly when there is no age to report', () => {
    const line = formatScheduleSummary([
      { file: 'deploy-drift.yml', status: 'unreadable', alerted: true, ageMs: null, detail: 'GitHub returned 404' },
    ])
    expect(line).toContain('unreadable')
    expect(line).not.toContain('NaN')
  })
})

describe('evaluateSchedule: an unreadable timestamp must not pass (L50)', () => {
  it('refuses a timestamp it cannot parse instead of landing on healthy', () => {
    // A failed parse yields NaN, and NaN compares false against every threshold,
    // so `ageMs > staleMs` would silently fall through to healthy: the one answer
    // this check must never give without having measured it. The lookup validates
    // the timestamp today, but this function is exported and its type accepts any
    // lookup, so the fail-safe belongs at the comparison as well.
    const v = evaluateSchedule(
      { ok: true, lastRunIso: 'yesterday afternoon', conclusions: ['success'] },
      NOW,
      4 * HOUR,
    )
    expect(v.status).toBe('unreadable')
    expect(v.ageMs).toBeNull()
    expect(v.detail).toContain('yesterday afternoon')
  })
})
