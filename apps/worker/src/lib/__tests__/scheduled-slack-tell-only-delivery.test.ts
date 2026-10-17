/**
 * A 'tell-only' check records delivery only from the send's real outcome
 * (#1303 phase 1, #2242 review). workflow-schedule-watch and workflow-dispatch
 * judge from GitHub, so they take the saved copy's org list in an outage; their
 * per org sends look the Slack connection up, which is a database read. These
 * drive each through an outage tick in which nobody is actually told (Slack
 * refuses the copy's post, or the org's connection cannot be found anywhere)
 * and require that no cooldown, alerted flag or incident marker is recorded:
 * an undelivered send must never read as delivered. Each is first proven to
 * record delivery when the post lands, in the same fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerScheduledSlack } from '../scheduled-slack'
import { runWorkflowScheduleWatch } from '../workflow-schedule-watch'
import { runAndReportDispatch } from '../workflow-dispatch-run'
import { fakeTimers, kvWith, kvWithCopy, tableClient, TEST_KEY, type Answer } from './_scheduled-slack-doubles'

const ORG = 'org-1'
const CONN = { bot_token: 'xoxb-test', default_channel: '#ops', config_alerts_enabled: true }

/** KV for the check's own state, recording every write. */
function stateKv() {
  const store = new Map<string, string>()
  const puts: string[] = []
  return {
    puts,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { puts.push(k); store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
}

type Tick = 'delivered' | 'slack_refuses' | 'org_not_found'

/**
 * The tick's database and Slack. delivered: the list and the org's connection
 * answer live and Slack accepts. slack_refuses: the database does not answer,
 * the copy holds the org, and Slack refuses the post. org_not_found: the list
 * answers live, the org's own lookup fails, and the copy does not hold it.
 */
async function tick(kind: Tick) {
  // The org list: down for slack_refuses, live otherwise.
  const answers: Record<string, Answer> =
    kind === 'slack_refuses' ? { service_connections: 'throw' } : { service_connections: { data: [{ organization_id: ORG }] } }
  const { client } = tableClient(answers)
  // The org's own lookup reads the same table, its alert row only, ending in
  // .limit(2) and answered as a one row list (#2332); give it the row
  // (delivered) or a failure (org_not_found) by answering per call.
  let calls = 0
  const from = (client as unknown as { from: (t: string) => unknown }).from
  ;(client as unknown as { from: (t: string) => unknown }).from = (table: string) => {
    if (table !== 'service_connections') return from(table)
    calls++
    if (calls === 1) return from(table)
    const lookup: Answer = kind === 'delivered' ? { data: [{ config: CONN }] } : { error: { message: 'connection terminated' } }
    return tableClient({ service_connections: lookup }).client.from(table)
  }
  const copy = kind === 'slack_refuses' ? await kvWithCopy({ [ORG]: CONN }) : kind === 'org_not_found' ? await kvWithCopy({ 'org-2': CONN }) : kvWith()
  registerScheduledSlack(client, { kv: copy, secretKeys: TEST_KEY, sleep: fakeTimers('never').sleep })
  const slackOk = kind === 'delivered'
  const posts: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    posts.push(String(input))
    return new Response(JSON.stringify(slackOk ? { ok: true, ts: '1.1' } : { ok: false, error: 'channel_not_found' }), { status: 200 })
  })
  return { client, posts }
}

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('workflow-schedule-watch records delivery only from the post', () => {
  // No GitHub repository configured, so every watched workflow is unreadable and the run alerts.
  const run = async (kind: Tick) => {
    const { client, posts } = await tick(kind)
    const kv = stateKv()
    const results = await runWorkflowScheduleWatch(client, kv as unknown as KVNamespace, {}, Date.parse('2026-10-15T12:00:00Z'))
    return { results, kv, posts }
  }

  it('arms its cooldown and marks the results alerted when the post lands (the positive control)', async () => {
    const { results, kv, posts } = await run('delivered')
    expect(posts.length).toBeGreaterThan(0)
    expect(results.some((r) => r.alerted)).toBe(true)
    expect(kv.puts.some((k) => k.startsWith('workflow-schedule:alert:'))).toBe(true)
  })

  it.each<Tick>(['slack_refuses', 'org_not_found'])('records nothing as delivered on an outage tick where %s', async (kind) => {
    const { results, kv } = await run(kind)
    expect(results.some((r) => r.alerted)).toBe(false)
    expect(kv.puts.filter((k) => k.startsWith('workflow-schedule:alert:'))).toEqual([])
  })
})

describe('workflow-dispatch records delivery only from the post', () => {
  // No token, so the driver cannot dispatch and reports it.
  const run = async (kind: Tick) => {
    const { client, posts } = await tick(kind)
    const kv = stateKv()
    await runAndReportDispatch(client, { GITHUB_CODE_REPO: 'Try-Pennie/bidspoke' }, kv as unknown as KVNamespace, Date.parse('2026-10-15T12:00:00Z'), async () => new Response('{}', { status: 401 }))
    return { kv, posts }
  }

  it('arms its cooldown when the post lands (the positive control)', async () => {
    const { kv, posts } = await run('delivered')
    expect(posts.length).toBeGreaterThan(0)
    expect(kv.puts.some((k) => k.startsWith('workflow-dispatch:alert:'))).toBe(true)
  })

  it.each<Tick>(['slack_refuses', 'org_not_found'])('records nothing as delivered on an outage tick where %s', async (kind) => {
    const { kv } = await run(kind)
    expect(kv.puts.filter((k) => k.startsWith('workflow-dispatch:alert:'))).toEqual([])
  })
})
