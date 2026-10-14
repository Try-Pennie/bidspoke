import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendCronHeartbeatAlert } from '../slack'

/**
 * The Slack message for a watched cron that is not doing its job (#358, #985).
 *
 * Three verdicts, three messages. A trigger that stopped firing (stale), a job
 * that has never fired since it was first seen (never_ran), and a run that
 * started and never finished (vanished) send the reader to different places:
 * the first two to the trigger configuration, the third to the per invocation
 * record of how that run ended. Saying "is dark" about a run the platform killed
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

const job = {
  label: 'Execution archive to Snowflake',
  triggerCron: '23 * * * *',
  dependents: 'workflow_executions are no longer being copied to Snowflake',
}

/** The body posted to Slack by the last call. */
const lastPost = () => JSON.parse((vi.mocked(fetch).mock.calls.at(-1)?.[1] as { body: string }).body)
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

  it('says a vanished run started and never finished, and sends the reader to where the outcome is recorded', async () => {
    const sent = await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'vanished', 90 * 60_000)

    expect(sent).toBe(true)
    const post = lastPost()
    expect(post.blocks[0].text.text).toBe('Execution archive to Snowflake started and never finished')
    const text = textOf(post)
    expect(text).toContain('~90 minutes ago')
    expect(text).toContain(job.dependents)
    // The outcome, recorded per invocation, is the fact that decides the remedy.
    expect(text).toContain("this run's own outcome")
    expect(text).toContain('Cloudflare records for each invocation')
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
  it('names no likely cause, and no resource outcome, for a vanished run', async () => {
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'vanished', 90 * 60_000)

    const text = textOf(lastPost())
    for (const guess of ['exceededMemory', 'exceededCpu', 'out of memory', 'most likely']) {
      expect(text).not.toContain(guess)
    }
  })

  // A remedy that prescribes a click path is only as good as the console it was
  // written against, and nothing re-checks it when that console changes. Name
  // the fact to find and let the reader find it (Dan, 2026-09-11).
  it('names the fact to look for, not a route through the Cloudflare console', async () => {
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'vanished', 90 * 60_000)

    const text = textOf(lastPost())
    for (const route of ['Workers Logs', 'Settings >', 'Metrics', 'eventType', '$workers']) {
      expect(text).not.toContain(route)
    }
  })

  // The same run can have done real work before it died: the export that
  // triggered #1308 had copied 800 rows. Telling the reader nothing happened
  // is a claim about progress the check never measured either.
  it('does not claim a vanished run accomplished nothing', async () => {
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'vanished', 90 * 60_000)

    const text = textOf(lastPost())
    expect(text).not.toContain('nothing it was meant to do')
    expect(text).toContain('may have completed part of its work')
  })

  // #1300 (Dan, 2026-09-10: "They're not easy to read"). What happened and what
  // to do come first; the schedule string and how the check saw it come last.
  for (const status of ['vanished', 'stale', 'never_ran', 'unstamped'] as const) {
    it(`a ${status} alert leads with what happened and keeps the schedule string to its last line`, async () => {
      await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, status, 90 * 60_000)
      const sections = lastPost().blocks.slice(1).map((b: { text: { text: string } }) => b.text.text)
      expect(sections.slice(0, -1).join('\n')).not.toContain(job.triggerCron)
      expect(sections.at(-1)).toContain(job.triggerCron)
      expect(sections[0]).not.toMatch(/^The .* cron/)
    })
  }

  it('keeps the schedule line last on a reminder too', async () => {
    const now = Date.parse('2026-10-05T13:00:00Z')
    const standing = { since: new Date(now - 26 * 3_600_000).toISOString(), alerts: 2 }
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'vanished', 90 * 60_000, standing, now)
    const sections = lastPost().blocks.slice(1).map((b: { text: { text: string } }) => b.text.text)
    expect(sections.at(-1)).toContain(job.triggerCron)
    expect(sections.slice(0, -1).join('\n')).not.toContain(job.triggerCron)
  })

  it('says when the next run retries in words, not as a schedule string', async () => {
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'vanished', 15 * 60_000)
    expect(textOf(lastPost())).toContain('every hour at :23')
  })

  it('says a stale job is dark and points at the trigger configuration, not at termination reasons', async () => {
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'stale', 3 * 3_600_000)

    const post = lastPost()
    expect(post.blocks[0].text.text).toBe('Execution archive to Snowflake is dark')
    const text = textOf(post)
    expect(text).toContain('has not run in ~3h')
    expect(text).toContain('wrangler.toml')
    expect(text).not.toContain('never finished')
    expect(text).not.toContain("this run's own outcome")
  })

  it('says a never-ran job has not run since it was first observed', async () => {
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'never_ran', 27 * 3_600_000)

    const text = textOf(lastPost())
    expect(text).toContain('has not run since it was first observed ~27h ago')
    expect(text).not.toContain('never finished')
  })

  it('gives every alerting verdict its own header, so no two can be mistaken for each other', async () => {
    const headers = new Set<string>()
    for (const status of ['stale', 'never_ran', 'vanished'] as const) {
      await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, status, 2 * 3_600_000)
      headers.add(lastPost().blocks[0].text.text)
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
    expect(textOf(lastPost())).toContain('nothing about it has changed: this is reminder 3')

    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'stale', 3 * 3_600_000, standing, now)
    expect(textOf(lastPost())).not.toContain('nothing about it has changed')
    expect(textOf(lastPost())).toContain('same problem as before')
  })
})
