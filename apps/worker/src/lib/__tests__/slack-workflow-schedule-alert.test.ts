import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { slackPostJsonOf } from '../../__tests__/helpers/slack-fetch'
import { sendWorkflowScheduleAlert } from '../slack'
import type { ScheduleStatus, WatchedWorkflow } from '../workflow-schedule-watch'
import { alertRowsAnswer } from '../../__tests__/helpers/slack-alert-read'

/**
 * The Slack message for the scheduled-workflow dead-man's-switch (#805, #843).
 *
 * Two things are being tested. First, each status gets its own wording: a
 * workflow that stopped firing, one that fires and fails, one the check cannot
 * read, and a registry entry naming a workflow that is gone need four different
 * actions, and telling the reader the wrong one sends them to look in the wrong
 * place while the real fault continues (LESSONS L11).
 *
 * Second, one run produces one message. Before #843 every watched workflow got
 * its own post with its own timer, so a single shared cause (a credential that
 * cannot see the repository) arrived as one identical message per registry
 * entry, four times a day, and the registry length decided how loud one fact was
 * (L36).
 */
function makeSupabase(connection: Record<string, string> | null) {
  const chain: unknown = new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'limit')
          return alertRowsAnswer(() =>
            connection
              ? Promise.resolve({ data: { config: connection }, error: null })
              : Promise.resolve({ data: null, error: null }))
        return () => chain
      },
    },
  )
  return { from: () => chain } as never
}

const connection = { bot_token: 'xoxb-test', default_channel: '#alerts', workspace_name: 'Pennie' }

/** Every post made to Slack, as text. */
const posts = async () =>
  Promise.all(vi.mocked(fetch).mock.calls.map((call) => slackPostJsonOf(call)))

const workflow = (file: string, label: string): WatchedWorkflow => ({
  file,
  label,
  cron: '17 * * * *',
  staleMs: 4 * 3_600_000,
  driveAfterMs: 50 * 60_000,
  dependents: `nothing is watching ${label}`,
})

const drift = workflow('deploy-drift.yml', 'Deploy Drift')
const types = workflow('db-types-drift.yml', 'Database types drift')

const verdict = (status: ScheduleStatus, detail: string, ageMs: number | null = null) => ({
  status,
  ageMs,
  detail,
})

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendWorkflowScheduleAlert: one run, one message (#843)', () => {
  it('reports two dark workflows in a single post naming both', async () => {
    await sendWorkflowScheduleAlert(makeSupabase(connection), 'org-1', {
      config: null,
      workflows: [
        { workflow: drift, verdict: verdict('stale', 'last scheduled run was 2026-08-15T11:17:00Z', 40 * 3_600_000) },
        { workflow: types, verdict: verdict('stale', 'last scheduled run was 2026-08-14T08:00:00Z', 60 * 3_600_000) },
      ],
    })
    expect((await posts()).length, 'one message per workflow is the defect #843 exists to fix').toBe(1)
    expect((await posts())[0]).toContain('deploy-drift.yml')
    expect((await posts())[0]).toContain('db-types-drift.yml')
  })

  it('reports a credential problem as one fact about configuration, naming the secret to set', async () => {
    await sendWorkflowScheduleAlert(makeSupabase(connection), 'org-1', {
      config: {
        reason: 'the credential in GITHUB_TOKEN cannot see Try-Pennie/bidspoke (GitHub returned 404)',
        files: ['deploy-drift.yml', 'db-types-drift.yml'],
      },
      workflows: [],
    })
    const body = (await posts())[0]
    expect(body).toContain('GITHUB_ACTIONS_TOKEN')
    // It must still say WHAT is unwatched while it cannot see, or the reader
    // cannot judge how much this matters.
    expect(body).toContain('deploy-drift.yml')
    expect(body).toContain('db-types-drift.yml')
    // And it must not accuse a workflow of having stopped, which is the one thing
    // the check has not measured (L119).
    expect(body).not.toContain('has stopped running')
  })

  it('does not send anyone to the credential when the only blindness is a rate limit (#1365)', async () => {
    await sendWorkflowScheduleAlert(makeSupabase(connection), 'org-1', {
      config: null,
      workflows: [
        { workflow: drift, verdict: { ...verdict('unreadable', 'GitHub rate limit (403)'), rateLimited: true } },
        { workflow: types, verdict: { ...verdict('unreadable', 'GitHub rate limit (403)'), rateLimited: true } },
      ],
    })
    const body = (await posts())[0]
    expect(body).toContain('clears on its own')
    expect(body).not.toContain('set to a credential')
  })

  it('gives both repairs when one workflow is rate limited and another is refused (#1365)', async () => {
    await sendWorkflowScheduleAlert(makeSupabase(connection), 'org-1', {
      config: null,
      workflows: [
        { workflow: drift, verdict: { ...verdict('unreadable', 'GitHub rate limit (403)'), rateLimited: true } },
        { workflow: types, verdict: verdict('unreadable', 'GitHub returned 403') },
      ],
    })
    const body = (await posts())[0]
    expect(body).toContain('clears on its own')
    expect(body).toContain('set to a credential')
  })

  it('reports a rate limited repository check as a rate limit, not a credential to replace (#1365)', async () => {
    await sendWorkflowScheduleAlert(makeSupabase(connection), 'org-1', {
      config: { reason: 'GitHub rate limit (403)', files: ['deploy-drift.yml'], rateLimited: true },
      workflows: [],
    })
    const body = (await posts())[0]
    expect(body).toContain('clears on its own')
    expect(body).not.toContain('set to a credential')
  })

  it('says nothing at all when there is nothing to report', async () => {
    const delivered = await sendWorkflowScheduleAlert(makeSupabase(connection), 'org-1', {
      config: null,
      workflows: [],
    })
    expect(delivered).toBe(false)
    expect((await posts()).length).toBe(0)
  })

  it('does not post when the org has no Slack connection', async () => {
    const delivered = await sendWorkflowScheduleAlert(makeSupabase(null), 'org-1', {
      config: null,
      workflows: [{ workflow: drift, verdict: verdict('stale', 'old', 40 * 3_600_000) }],
    })
    expect(delivered).toBe(false)
    expect((await posts()).length).toBe(0)
  })
})

describe('sendWorkflowScheduleAlert: each status says a different thing (L11)', () => {
  const send = (status: ScheduleStatus, detail: string, ageMs: number | null = null) =>
    sendWorkflowScheduleAlert(makeSupabase(connection), 'org-1', {
      config: null,
      workflows: [{ workflow: drift, verdict: verdict(status, detail, ageMs) }],
    })

  it('says a stale workflow has stopped running, and what breaks while it is dark', async () => {
    await send('stale', 'last scheduled run was 2026-08-15T11:17:00Z', 40 * 3_600_000)
    const body = (await posts())[0]
    expect(body).toContain('stopped running')
    expect(body).toContain('nothing is watching Deploy Drift')
  })

  it('says a failing workflow RAN and failed, which is a different action from having stopped', async () => {
    // #844. Telling somebody a workflow stopped when it is running and failing
    // sends them to the Actions tab to re-enable a schedule that is already on.
    await send('failing', 'the last 2 scheduled runs failed', 3_600_000)
    const body = (await posts())[0]
    expect(body).toContain('failing')
    expect(body).not.toContain('stopped running')
  })

  it('claims only the streak it measured, not that every run has failed', async () => {
    // What the check measured is a run of consecutive failures at the head of the
    // history. "every run" is a claim about the whole history, which it never
    // read, and a message may claim only what its check actually measured (L11).
    // It also matters practically: the reader would go looking for a workflow
    // that has never once succeeded.
    await send('failing', 'the last 2 scheduled runs failed', 3_600_000)
    const body = (await posts())[0]
    expect(body).not.toContain('every run')
    // And it must still convey that this is a pattern rather than one bad run.
    expect(body).toContain('the last 2 scheduled runs failed')
  })

  it('says a missing workflow is not in the repository, and points at the watch list', async () => {
    await send('missing', 'GitHub has no workflow file named deploy-drift.yml')
    const body = (await posts())[0]
    expect(body).toContain('WATCHED_WORKFLOWS')
  })

  it('says an unreadable workflow cannot be told about, never that it stopped', async () => {
    await send('unreadable', 'GitHub returned 502')
    const body = (await posts())[0]
    expect(body).toContain('502')
    expect(body).not.toContain('has stopped running')
  })

  it('says a never-ran workflow has no scheduled runs on record', async () => {
    await send('never_ran', 'GitHub has no scheduled runs on record for this workflow')
    expect((await posts())[0]).toContain('no scheduled runs')
  })
})
