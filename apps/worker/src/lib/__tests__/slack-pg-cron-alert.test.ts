import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendPgCronAlert } from '../slack'
import { ALERTING_STATUSES } from '../pg-cron-watch'
import { slackPostOf } from '../../__tests__/helpers/slack-fetch'

/**
 * The Slack message for a failing or stalled database job (#770).
 *
 * Each status gets its own wording, and that is the point being tested. A job
 * erroring every run, a job that has quietly stopped being scheduled, and a job
 * whose schedule the check cannot read need three different actions. Telling the
 * reader the wrong one sends them to look in the wrong place while the real
 * fault continues (LESSONS L11), and they are being paged precisely because they
 * do not already know which it is.
 */
function makeSupabase(connection: Record<string, string> | null) {
  const chain: unknown = new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'maybeSingle')
          return () =>
            connection
              ? Promise.resolve({ data: { config: connection }, error: null })
              : Promise.resolve({ data: null, error: null })
        return () => chain
      },
    },
  )
  return { from: () => chain } as never
}

const connection = { bot_token: 'xoxb-test', default_channel: '#alerts', workspace_name: 'Pennie' }

/** The body posted to Slack by the last call. */
const lastPost = async () => (await slackPostOf(vi.mocked(fetch).mock.calls.at(-1) ?? []))

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const send = (status: string, detail = 'something happened') =>
  sendPgCronAlert(makeSupabase(connection), 'org-1', { jobname: 'refresh-stats', status, detail }, '45 3 * * *')

describe('sendPgCronAlert: each status says a different thing', () => {
  it('says the job is failing, and carries the database error', async () => {
    await send('failing', 'ERROR: duplicate key value violates unique constraint')
    const body = JSON.stringify((await lastPost()))
    expect(body).toContain('is failing')
    expect(body).toContain('duplicate key')
  })

  it('says the job has stopped running, and points at its run history', async () => {
    // A job removed from cron.job is not in the health read, and a disabled one
    // is reported as inactive, so neither explains a stall (#835). What is left
    // is a stuck run or a scheduler not starting it, both read in job_run_details.
    await send('stalled', 'last succeeded 50h ago')
    const body = JSON.stringify((await lastPost()))
    expect(body).toContain('has stopped running')
    expect(body).toContain('cron.job_run_details')
  })

  it('says the check cannot tell, rather than accusing the job', async () => {
    // An unreadable schedule is our problem, not the job's. Saying the job has
    // stopped would be a claim the check cannot support (L11, L119).
    await send('unknown_schedule', "the schedule '0 9-17 * * *' is not one this check can read")
    const body = JSON.stringify((await lastPost()))
    expect(body).toContain('Cannot tell whether')
    expect(body).not.toContain('has stopped running')
  })

  it('gives an unrecognised status a message rather than an empty one', async () => {
    // A status added later must not produce a blank header that reads as a bug in
    // the alerting rather than a condition in the database.
    await send('something-new')
    const body = JSON.stringify((await lastPost()))
    expect(body).toContain('needs attention')
    expect(body).toContain('How to fix')
  })

  it('names the job and its schedule in every message', async () => {
    for (const status of ALERTING_STATUSES) {
      await send(status)
      const body = JSON.stringify((await lastPost()))
      expect(body, `${status} does not name the job`).toContain('refresh-stats')
      expect(body, `${status} does not name the schedule`).toContain('45 3 * * *')
    }
  })

  it('always includes a how-to-fix line', async () => {
    for (const status of ALERTING_STATUSES) {
      await send(status)
      expect(JSON.stringify((await lastPost())), `${status} has no fix hint`).toContain('How to fix')
    }
  })

  it('gives every status that can reach Slack its own headline and its own remedy', async () => {
    // The alert builder looks its wording up by status and falls back to generic
    // text for anything absent, so a status added later pages with a headline
    // that says nothing and a remedy that points at the wrong place (L113).
    //
    // The vocabulary is read from the watcher rather than listed again here: a
    // list maintained by hand beside the thing it mirrors checks only what it
    // happens to contain, which is how unknown_identity shipped with no wording
    // at all while every test here stayed green (L41, L96).
    expect(ALERTING_STATUSES.length, 'no statuses to check, so this would pass vacuously').toBeGreaterThan(4)
    for (const status of ALERTING_STATUSES) {
      await send(status)
      const body = JSON.stringify((await lastPost()))
      expect(body, `${status} falls back to the generic headline`).not.toContain('needs attention')
      expect(body, `${status} falls back to the generic remedy`).not.toContain('read this job in')
    }
  })
})

describe('sendPgCronAlert: no Slack connection', () => {
  it('reports that nothing was delivered rather than claiming success', async () => {
    // The caller arms a six hour cooldown on a true return, so claiming delivery
    // here would buy silence about a condition nobody was told.
    const delivered = await sendPgCronAlert(
      makeSupabase(null),
      'org-1',
      { jobname: 'a', status: 'failing', detail: 'x' },
      '0 3 * * *',
    )
    expect(delivered).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
})
