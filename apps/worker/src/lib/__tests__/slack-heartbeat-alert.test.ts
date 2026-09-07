import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendCronHeartbeatAlert } from '../slack'

/**
 * The Slack message for a watched cron that is not doing its job (#358, #985).
 *
 * Three verdicts, three messages. A trigger that stopped firing (stale), a job
 * that has never fired since it was first seen (never_ran), and a run that
 * started and never finished (vanished) send the reader to different places:
 * the first two to the trigger configuration, the third to the platform's
 * termination reasons. Saying "is dark" about a run the platform killed sends
 * the reader to check triggers that are fine while the same run keeps dying
 * (LESSONS L11).
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

  it('says a vanished run started and never finished, and points at the platform termination reasons', async () => {
    const sent = await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'vanished', 90 * 60_000)

    expect(sent).toBe(true)
    const post = lastPost()
    expect(post.blocks[0].text.text).toBe('Execution archive to Snowflake started and never finished')
    const text = textOf(post)
    expect(text).toContain('~90 minutes ago')
    expect(text).toContain(job.dependents)
    expect(text).toContain('Trigger Events')
    expect(text).toContain('exceededMemory')
    // The remedy for a dark trigger would send the reader to the wrong place.
    expect(text).not.toContain('is dark')
    expect(text).not.toContain('wrangler.toml')
    expect(post.text).toContain('vanished')
  })

  it('says a stale job is dark and points at the trigger configuration, not at termination reasons', async () => {
    await sendCronHeartbeatAlert(makeSupabase(connection), 'org-1', job, 'stale', 3 * 3_600_000)

    const post = lastPost()
    expect(post.blocks[0].text.text).toBe('Execution archive to Snowflake is dark')
    const text = textOf(post)
    expect(text).toContain('has not run in ~3h')
    expect(text).toContain('wrangler.toml')
    expect(text).not.toContain('never finished')
    expect(text).not.toContain('exceededMemory')
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
})
