import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendCronHeartbeatAlert, sendCronHeartbeatGroupAlert, sendCronHeartbeatGroupRecoveryAlert } from '../slack'
import { slackPostOf } from '../../__tests__/helpers/slack-fetch'
import { alertRowsAnswer } from '../../__tests__/helpers/slack-alert-read'

/**
 * The Slack message for a watched cron that is not doing its job (#358, #985).
 *
 * Three verdicts, three messages. A trigger that stopped firing (stale), a job
 * that has never fired since it was first seen (never_ran), and a run that
 * started and never finished (vanished) send the reader to different places:
 * the first two to the trigger configuration, the third to whether the next run
 * finishes, since a run Cloudflare cancels can leave no outcome record at all
 * (#2578). Saying "is dark" about a run the platform killed
 * sends the reader to check triggers that are fine while the same run keeps
 * dying (LESSONS L11).
 *
 * The vanished message states what the check measured and nothing more (#1308).
 * It measures one thing, a started stamp with no completion inside the
 * allowance, so it cannot name a cause, and naming one sent a reader hunting
 * for two statuses the platform had not recorded.
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

const job = {
  label: 'Execution archive to Snowflake',
  triggerCron: '23 * * * *',
  dependents: 'workflow_executions are no longer being copied to Snowflake',
}

/** The body posted to Slack by the last call. */
const lastPost = async () => (await slackPostOf(vi.mocked(fetch).mock.calls.at(-1) ?? []))
const textOf = (post: { blocks: { text: { text: string } }[] }) => post.blocks.map((b) => b.text.text).join('\n')

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true, ts: "1.0" }), { status: 200 })),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendCronHeartbeatAlert', () => {
  it('posts nothing and reports false when the org has no Slack connection', async () => {
    const sent = await sendCronHeartbeatAlert(makeSupabase(null), 'org-1', job, 'vanished', 90 * 60_000)

    expect(sent).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('says a vanished run started and never finished, and sends the reader to whether the next run finishes', async () => {
    const sent = await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'vanished', 90 * 60_000)

    expect(sent).toBe(true)
    const post = (await lastPost())
    expect(post.blocks[0].text.text).toBe('Execution archive to Snowflake started and never finished')
    const text = textOf(post)
    expect(text).toContain('~90 minutes ago')
    expect(text).toContain(job.dependents)
    // Whether the next run finishes is the fact that decides the remedy (#2578).
    expect(text).toContain('whether the next run of this job finishes')
    expect(text).toContain('next scheduled run tries again on its own')
    // The remedy for a dark trigger would send the reader to the wrong place.
    expect(text).not.toContain('is dark')
    expect(text).not.toContain('wrangler.toml')
    expect(post.text).toContain('vanished')
  })

  // #1308. The check measures one thing: a started stamp with no completion
  // inside the allowance. It cannot see WHY, so every word about the cause is a
  // guess. On the first real firing (2026-09-11, the sightings export) it guessed
  // memory or CPU and the platform had recorded `canceled` after 16.8s with 69ms
  // of CPU, so a reader following the remedy went looking for two statuses that
  // were not there (L11, L440).
  // #2057 then added that an ok outcome meant the run finished late, and #2578
  // removed it again: an ok under the run's scheduled time can be a retry's.
  // A minute job is judged on a drought of finished runs (#2057), so its age is
  // how long nothing has finished, not how long ago one run started.
  it('says how long nothing has finished for a minute job, not when a run started', async () => {
    const minuteJob = { ...job, triggerCron: '* * * * *', completionDroughtMs: 10 * 60_000 }
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', minuteJob, 'vanished', 11 * 60_000)
    const text = textOf((await lastPost()))
    expect(text).toContain('No run has finished in ~11 minutes')
    expect(text).not.toContain('A run started')
    expect(text).toContain('no run has stamped a completion for that long')
    expect(text).not.toContain('inside its allowance')
  })

  // #2578. On 2026-10-21 the 04:00 UTC `*/15` run was killed and left NO
  // outcome record, while Cloudflare's retry half an hour later, carrying the
  // same scheduled time, ended `ok`. The old fix line said Cloudflare records an
  // outcome for each invocation and that an ok outcome means the run finished
  // late, so a reader following it found the retry's `ok` and concluded the
  // original had finished. Neither half was ever measured (L11, L460).
  it('does not claim Cloudflare records an outcome for every run, and says a killed run can leave none', async () => {
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'vanished', 90 * 60_000)
    const text = textOf((await lastPost()))
    expect(text).not.toMatch(/records? (an outcome )?for (each|every) invocation/i)
    expect(text).not.toContain("this run's own outcome, which Cloudflare records")
    expect(text).toContain('can leave no outcome record at all')
  })

  it('does not let an ok outcome under the run\'s scheduled time stand in for the run itself, since a retry carries it too', async () => {
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'vanished', 90 * 60_000)
    const text = textOf((await lastPost()))
    expect(text).not.toMatch(/outcome is ok the run finished after this check looked/i)
    expect(text).not.toContain('nothing needs changing at all')
    expect(text).toContain('under the same scheduled time')
    expect(text).toMatch(/`ok` outcome at that scheduled time can be the retry's rather than this run's/)
  })

  it('names what to read instead: whether the next run finishes, and the takeover line with its previous_age_ms', async () => {
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'vanished', 90 * 60_000)
    const fix = (await lastPost()).blocks.map((b: { text: { text: string } }) => b.text.text).find((t: string) => t.startsWith('*How to fix:*'))
    expect(fix).toContain('whether the next run of this job finishes')
    expect(fix).toContain('an all-clear is posted here when one does')
    expect(fix).toContain('`[cron-once] took over`')
    expect(fix).toContain('`previous_age_ms`')
  })

  it('names no likely cause, and no resource outcome, for a vanished run', async () => {
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'vanished', 90 * 60_000)

    const text = textOf((await lastPost()))
    for (const guess of ['exceededMemory', 'exceededCpu', 'out of memory', 'most likely']) {
      expect(text).not.toContain(guess)
    }
  })

  // A remedy that prescribes a click path is only as good as the console it was
  // written against, and nothing re-checks it when that console changes. Name
  // the fact to find and let the reader find it (Dan, 2026-09-11).
  it('names the fact to look for, not a route through the Cloudflare console', async () => {
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'vanished', 90 * 60_000)

    const text = textOf((await lastPost()))
    for (const route of ['Workers Logs', 'Settings >', 'Metrics', 'eventType', '$workers']) {
      expect(text).not.toContain(route)
    }
  })

  // The same run can have done real work before it died: the export that
  // triggered #1308 had copied 800 rows. Telling the reader nothing happened
  // is a claim about progress the check never measured either.
  it('does not claim a vanished run accomplished nothing', async () => {
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'vanished', 90 * 60_000)

    const text = textOf((await lastPost()))
    expect(text).not.toContain('nothing it was meant to do')
    expect(text).toContain('may have completed part of its work')
  })

  // #1300 (Dan, 2026-09-10: "They're not easy to read"). What happened and what
  // to do come first; the schedule string and how the check saw it come last.
  for (const status of ['vanished', 'stale', 'never_ran', 'unstamped'] as const) {
    it(`a ${status} alert leads with what happened and keeps the schedule string to its last line`, async () => {
      await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, status, 90 * 60_000)
      const sections = (await lastPost()).blocks.slice(1).map((b: { text: { text: string } }) => b.text.text)
      expect(sections.slice(0, -1).join('\n')).not.toContain(job.triggerCron)
      expect(sections.at(-1)).toContain(job.triggerCron)
      expect(sections[0]).not.toMatch(/^The .* cron/)
    })
  }

  it('keeps the schedule line last on a reminder too', async () => {
    const now = Date.parse('2026-10-05T13:00:00Z')
    const standing = { since: new Date(now - 26 * 3_600_000).toISOString(), alerts: 2 }
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'vanished', 90 * 60_000, standing, now)
    const sections = (await lastPost()).blocks.slice(1).map((b: { text: { text: string } }) => b.text.text)
    expect(sections.at(-1)).toContain(job.triggerCron)
    expect(sections.slice(0, -1).join('\n')).not.toContain(job.triggerCron)
  })

  it('says when the next run retries in words, not as a schedule string', async () => {
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'vanished', 15 * 60_000)
    // The fix line itself, not the schedule line every alert ends with.
    const fix = (await lastPost()).blocks.map((b: { text: { text: string } }) => b.text.text).find((t: string) => t.startsWith('*How to fix:*'))
    expect(fix).toContain('tries again on its own (every hour at :23)')
  })

  it('says a stale job is dark and points at the trigger configuration, not at termination reasons', async () => {
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'stale', 3 * 3_600_000)

    const post = (await lastPost())
    expect(post.blocks[0].text.text).toBe('Execution archive to Snowflake is dark')
    const text = textOf(post)
    expect(text).toContain('has not run in ~3h')
    expect(text).toContain('wrangler.toml')
    expect(text).not.toContain('never finished')
    expect(text).not.toContain('took over')
  })

  it('points a cron of another Worker at that Worker, not at this one\'s wrangler.toml (#1949)', async () => {
    const { cronJob } = await import('../cron-heartbeat')
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', cronJob('ops-tick'), 'never_ran', 30 * 60_000)
    const text = textOf((await lastPost()))
    expect(text).toContain('wrangler.ops.toml')
    expect(text).toContain('OPS_GATEWAY')
    expect(text).not.toContain('wrangler.toml `[triggers]` must list')
  })

  it('warns that a gap in the ops tick logs is not a missed tick, since Workers Logs always lose a few percent of lines (#2347)', async () => {
    // Measured 2026-10-20: the tick ran in all 1,440 minutes of a day while
    // Workers Logs held a finished line for 1,324 of them. A reader sent to
    // "check the logs show ops_tick lines" must not read each gap as a miss.
    const { cronJob } = await import('../cron-heartbeat')
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', cronJob('ops-tick'), 'stale', 30 * 60_000)
    const text = textOf((await lastPost()))
    expect(text).toContain('ops_tick')
    expect(text).toContain('a few percent of its log lines are always missing')
    expect(text).toContain('a gap in the logs is not a missed tick')
  })

  it('says a never-ran job has not run since it was first observed', async () => {
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'never_ran', 27 * 3_600_000)

    const text = textOf((await lastPost()))
    expect(text).toContain('has not run since it was first observed ~27h ago')
    expect(text).not.toContain('never finished')
  })

  it('gives every alerting verdict its own header, so no two can be mistaken for each other', async () => {
    const headers = new Set<string>()
    for (const status of ['stale', 'never_ran', 'vanished'] as const) {
      await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, status, 2 * 3_600_000)
      headers.add((await lastPost()).blocks[0].text.text)
    }
    // stale and never_ran share the "is dark" header by design: both mean the
    // trigger is not firing and share one remedy. vanished must not join them.
    expect(headers.size).toBe(2)
    expect([...headers].some((h) => h.includes('never finished'))).toBe(true)
  })

  it('says a reminder has not changed only when the caller measured it, never by default (#1768)', async () => {
    const now = Date.parse('2026-10-05T13:00:00Z')
    const standing = { since: new Date(now - 26 * 3_600_000).toISOString(), alerts: 2 }

    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'stale', 3 * 3_600_000, standing, now, true)
    expect(textOf((await lastPost()))).toContain('nothing about it has changed: this is reminder 3')

    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'stale', 3 * 3_600_000, standing, now)
    expect(textOf((await lastPost()))).not.toContain('nothing about it has changed')
    expect(textOf((await lastPost()))).toContain('same problem as before')
  })
})

// #2117 A. One page for a schedule whose jobs are all dark together, and one for
// the unfinished jobs of one run, each listing the jobs it is about.
describe('sendCronHeartbeatGroupAlert (#2117)', () => {
  const five = [
    { label: 'Partner reachability probe', dependents: 'a partner firewall block is no longer noticed', ageMs: 18 * 60_000 },
    { label: 'Incident record drain', dependents: 'alert incidents stop reaching the incident record', ageMs: 18 * 60_000 },
    { label: 'Database memory check', dependents: 'the database running short of memory goes unreported', ageMs: 18 * 60_000 },
  ]
  // 21:30 UTC on 2026-10-14 is 5:30 PM EDT.
  const missed = { status: 'stale' as const, triggerCron: '*/5 * * * *', runAt: '2026-10-14T21:30:00.400Z', jobs: five }
  const NOW = Date.parse('2026-10-14T21:48:35Z')

  it('posts nothing and reports false when the org has no Slack connection', async () => {
    expect(await sendCronHeartbeatGroupAlert(makeSupabase(null), 'org-1', missed, null, NOW)).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('says the schedule is dark, when its jobs last started, and lists every job with what stops', async () => {
    expect(await sendCronHeartbeatGroupAlert(makeSupabase(connection), 'org-1', missed, null, NOW)).toBe(true)
    const post = await lastPost()
    expect(post.blocks[0].text.text).toBe('Every job that runs every 5 minutes is dark')
    const text = textOf(post)
    expect(text).toContain('None of the 3 jobs that run every 5 minutes has started a run since Oct 14, 5:30 PM EDT (~19 minutes ago)')
    for (const j of five) {
      expect(text).toContain(`*${j.label}*`)
      expect(text).toContain(j.dependents)
    }
    // The fallback names every job, so a reader of the notification knows what is paused.
    for (const j of five) expect(post.text).toContain(j.label)
  })

  it('sends the reader to what the jobs share: the schedule and Cloudflare, not one job', async () => {
    await sendCronHeartbeatGroupAlert(makeSupabase(connection), 'org-1', missed, null, NOW)
    const fix = (await lastPost()).blocks.map((b: { text: { text: string } }) => b.text.text).find((t: string) => t.startsWith('*How to fix:*'))
    expect(fix).toContain('cloudflarestatus.com')
    expect(fix).toContain('wrangler.toml `[triggers]`')
    expect(fix).not.toContain('took over')
  })

  it('keeps the schedule string to its last line', async () => {
    await sendCronHeartbeatGroupAlert(makeSupabase(connection), 'org-1', missed, null, NOW)
    const sections = (await lastPost()).blocks.slice(1).map((b: { text: { text: string } }) => b.text.text)
    expect(sections.slice(0, -1).join('\n')).not.toContain('*/5 * * * *')
    expect(sections.at(-1)).toContain('*/5 * * * *')
  })

  it('says still, and that it is a reminder, on a reminder', async () => {
    const standing = { since: new Date(NOW - 6 * 3_600_000).toISOString(), alerts: 1 }
    await sendCronHeartbeatGroupAlert(makeSupabase(connection), 'org-1', missed, standing, NOW)
    const post = await lastPost()
    expect(post.blocks[0].text.text).toBe('Every job that runs every 5 minutes is still dark')
    expect(textOf(post)).toContain('reminder 2')
  })

  it('names another Worker\'s trigger file for its own schedule (#1949)', async () => {
    await sendCronHeartbeatGroupAlert(makeSupabase(connection), 'org-1', { ...missed, triggerCron: '* * * * *', worker: 'bidspoke-worker-ops' }, null, NOW)
    const text = textOf(await lastPost())
    expect(text).toContain('wrangler.ops.toml')
    expect(text).not.toContain('wrangler.toml `[triggers]`')
  })

  // The 2026-10-21 04:00 UTC `*/15` run, 12:00 AM EDT.
  const run = {
    status: 'vanished' as const,
    triggerCron: '*/15 * * * *',
    runAt: '2026-10-21T04:00:00.000Z',
    jobs: [
      { label: 'Buyer sales checks', dependents: 'nothing is comparing the buyer ledgers', ageMs: 11 * 60_000 },
      { label: 'Click buyer path checks', dependents: 'nothing notices a click buyer check that cannot answer', ageMs: 11 * 60_000 },
    ],
  }
  const RUN_NOW = Date.parse('2026-10-21T04:12:05Z')

  it('says the jobs of one run started and never finished, naming the run and every job', async () => {
    await sendCronHeartbeatGroupAlert(makeSupabase(connection), 'org-1', run, null, RUN_NOW)
    const post = await lastPost()
    expect(post.blocks[0].text.text).toBe('2 jobs of one scheduled run started and never finished')
    const text = textOf(post)
    expect(text).toContain('The run scheduled for Oct 21, 12:00 AM EDT started these jobs ~11 minutes ago and none of them has finished')
    for (const j of run.jobs) {
      expect(text).toContain(`*${j.label}*`)
      expect(text).toContain(j.dependents)
      expect(post.text).toContain(j.label)
    }
    expect(text).not.toContain('is dark')
  })

  it('gives the run the same advice as one job, about these jobs, and no claim that every invocation has an outcome (#2578)', async () => {
    await sendCronHeartbeatGroupAlert(makeSupabase(connection), 'org-1', run, null, RUN_NOW)
    const fix = (await lastPost()).blocks.map((b: { text: { text: string } }) => b.text.text).find((t: string) => t.startsWith('*How to fix:*'))
    expect(fix).toContain('whether the next run of these jobs finishes')
    expect(fix).toContain('can leave no outcome record at all')
    expect(fix).toContain('`[cron-once] took over`')
    expect(fix).not.toMatch(/for (each|every) invocation/)
  })
})

describe('sendCronHeartbeatGroupRecoveryAlert (#2117)', () => {
  const recovery = {
    alertedAt: '2026-10-21T04:12:05.000Z',
    endedAt: '2026-10-21T04:15:58.000Z',
    jobs: [
      { label: 'Buyer sales checks', sameRun: false },
      { label: 'Click buyer path checks', sameRun: true },
    ],
  }

  it('posts nothing and reports false when the org has no Slack connection', async () => {
    expect(await sendCronHeartbeatGroupRecoveryAlert(makeSupabase(null), 'org-1', recovery, Date.parse('2026-10-21T04:16:05Z'))).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('is one Recovered message naming each job with what its completion shows, and the timing once', async () => {
    expect(await sendCronHeartbeatGroupRecoveryAlert(makeSupabase(connection), 'org-1', recovery, Date.parse('2026-10-21T04:16:05Z'))).toBe(true)
    const post = await lastPost()
    expect(post.blocks[0].text.text).toBe('Recovered')
    const text = textOf(post)
    expect(text).toContain('*Buyer sales checks* has finished a run since, so it is running again.')
    expect(text).toContain('*Click buyer path checks* finished the run reported as never finished, late.')
    expect(text.match(/alert fired at/g)).toHaveLength(1)
    expect(post.text).toBe('Recovered: Buyer sales checks, Click buyer path checks')
  })
})
