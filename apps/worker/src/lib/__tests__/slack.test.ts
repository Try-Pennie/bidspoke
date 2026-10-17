/**
 * Slack alert lib — PRD Section 1.7
 * Verifies: blocks structure, unfurl_links: false, ET timezone (DST-aware),
 * markdown link (not interactive button), channel override, no-op when unconfigured.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendFailureSaturationAlert, sendFailureAlert, sendDurationAlert, sendRecoveryAlert, sendGroupedRecoveryAlert, sendSlowSpikeAlert, sendSecretDriftAlert, sendSecretDecryptAlert, sendBackupFailureAlert, sendFailureSpikeAlert, sendUpstreamOutageAlert, sendOutcomeDeadLetterAlert, sendRequiredSecretsAlert, sendRequiredEnvVarsAlert, sendMatrixSyncFailureAlert, sendExportFailureAlert, sendQueryTimeoutAlert, getSlackConnection, sendPgCronRecoveryAlert, sendWorkflowScheduleRecoveryAlert } from '../slack'
import type { QueryTimeoutOffender } from '../slack'
import { slackPostOf } from '../../__tests__/helpers/slack-fetch'
import type { FailureAlertPayload, SlowSpikeAlertPayload, SlackConnection } from '../slack'
import { alertRowsAnswer } from '../../__tests__/helpers/slack-alert-read'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSupabase(connection: Record<string, string> | null) {
  const chain: unknown = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'limit') return alertRowsAnswer(() =>
        connection
          ? Promise.resolve({ data: { config: connection }, error: null })
          : Promise.resolve({ data: null, error: null }))
      return () => chain
    },
  })
  return { from: () => chain }
}

const slackConnection = {
  bot_token: 'xoxb-test-token',
  default_channel: '#alerts',
  workspace_name: 'Pennie',
}

const payload: FailureAlertPayload = {
  workflow_id: 'wf-1',
  workflow_name: 'Lead Routing',
  execution_id: 'exec-abc',
  step_namespace: 'filter_1',
  error_message: 'Connection refused',
  error_type: 'transient',
  // 2024-01-15T18:00:00Z → Jan 15, 2024 1:00 PM EST (UTC-5, non-DST)
  timestamp: '2024-01-15T18:00:00.000Z',
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('sendFailureAlert', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('strips the query string from any address in the error before it reaches Slack (L741, #1740)', async () => {
    const leaky = { ...payload, error_message: 'TypeError: Fetch API cannot load: https://p.example/x?email=jo%40example.com&phone=%28201%29' }
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, leaky, 'https://app.example.com')
    const body = JSON.stringify(await slackPostOf(fetchMock.mock.calls[0]))
    expect(body).not.toMatch(/%40|%28201%29|email=/)
    expect(body).toContain('https://p.example/x')
  })

  it('does nothing when Slack is not configured', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(null) as any, 'org-1', null, payload, 'https://app.example.com')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the channel override when provided', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', '#custom-channel', payload, 'https://app.example.com')
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    expect(body.channel).toBe('#custom-channel')
  })

  it('falls back to default_channel when no override', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    expect(body.channel).toBe('#alerts')
  })

  it('sends unfurl_links: false', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    expect(body.unfurl_links).toBe(false)
  })

  it('includes a header block', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const { blocks } = (await slackPostOf(fetchMock.mock.calls[0]))
    const header = blocks.find((b: { type: string }) => b.type === 'header')
    expect(header).toBeDefined()
    expect(header.text.text).toContain('Failed')
  })

  it('includes workflow name and step namespace in a section block', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const { blocks } = (await slackPostOf(fetchMock.mock.calls[0]))
    const allText = blocks.flatMap((b: { fields?: { text: string }[]; text?: { text: string } }) => [
      ...(b.fields ?? []).map((f) => f.text),
      b.text?.text ?? '',
    ]).join('\n')
    expect(allText).toContain('Lead Routing')
    expect(allText).toContain('filter_1')
  })

  it('includes the error message in a code block', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const { blocks } = (await slackPostOf(fetchMock.mock.calls[0]))
    const allText = blocks.flatMap((b: { text?: { text: string } }) => [b.text?.text ?? '']).join('\n')
    expect(allText).toContain('Connection refused')
    expect(allText).toContain('```')
  })

  it('sends a long error message whole when it fits under the Slack block limit', async () => {
    const longBody = 'Code returned error response: HTTP 500 — ' + 'x'.repeat(2000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, { ...payload, error_message: longBody }, 'https://app.example.com')
    const { blocks } = (await slackPostOf(fetchMock.mock.calls[0]))
    const errBlock = blocks.map((b: { text?: { text: string } }) => b.text?.text ?? '').find((t: string) => t.includes('Code returned error response'))
    expect(errBlock).toContain('x'.repeat(2000))
    expect(errBlock).not.toContain('truncated')
  })

  it('caps an error message that would exceed the Slack 3000-char block limit, pointing to the execution detail', async () => {
    const hugeBody = 'Code returned error response: HTTP 500 — ' + 'x'.repeat(5000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, { ...payload, error_message: hugeBody }, 'https://app.example.com')
    const { blocks } = (await slackPostOf(fetchMock.mock.calls[0]))
    const errBlock = blocks.map((b: { text?: { text: string } }) => b.text?.text ?? '').find((t: string) => t.includes('Code returned error response'))
    // Stays under Slack's hard per-block cap so the POST isn't rejected.
    expect(errBlock.length).toBeLessThanOrEqual(3000)
    expect(errBlock).toContain('full error in execution detail')
  })

  it('includes a markdown "View execution →" link (not an interactive button)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const { blocks } = (await slackPostOf(fetchMock.mock.calls[0]))
    // No block should have type: 'actions' (that's the interactive button pattern)
    expect(blocks.some((b: { type: string }) => b.type === 'actions')).toBe(false)
    // Link block should use mrkdwn with <url|text> syntax
    const allText = blocks.flatMap((b: { text?: { text: string; type?: string } }) =>
      b.text ? [b.text.text] : []
    ).join('\n')
    expect(allText).toMatch(/<https?:.*\|View execution →>/)
  })

  it('embeds workflow_id and execution_id in the execution URL', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const { blocks } = (await slackPostOf(fetchMock.mock.calls[0]))
    const allText = blocks.map((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(allText).toContain('wf-1')
    expect(allText).toContain('exec-abc')
  })

  it('appends node= to the execution URL when the failed step has a node id', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, { ...payload, node_id: 'node-xyz' }, 'https://app.example.com')
    const { blocks } = (await slackPostOf(fetchMock.mock.calls[0]))
    const allText = blocks.map((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(allText).toContain('node=node-xyz')
    // Still carries the execution param so the overlay opens too.
    expect(allText).toContain('execution=exec-abc')
  })

  it('omits the node param when the failed step has no node id', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const { blocks } = (await slackPostOf(fetchMock.mock.calls[0]))
    const allText = blocks.map((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(allText).not.toContain('node=')
  })

  it('formats the timestamp in ET (EST, non-DST)', async () => {
    // 2024-01-15T18:00:00Z = 1:00 PM EST (UTC-5)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const { blocks } = (await slackPostOf(fetchMock.mock.calls[0]))
    const allText = blocks.flatMap((b: { fields?: { text: string }[] }) =>
      (b.fields ?? []).map((f) => f.text)
    ).join('\n')
    expect(allText).toMatch(/EST/)
    expect(allText).toMatch(/1:00/)
  })

  it('formats the timestamp in ET (EDT, DST)', async () => {
    // 2024-07-15T18:00:00Z = 2:00 PM EDT (UTC-4)
    const summerPayload = { ...payload, timestamp: '2024-07-15T18:00:00.000Z' }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, summerPayload, 'https://app.example.com')
    const { blocks } = (await slackPostOf(fetchMock.mock.calls[0]))
    const allText = blocks.flatMap((b: { fields?: { text: string }[] }) =>
      (b.fields ?? []).map((f) => f.text)
    ).join('\n')
    expect(allText).toMatch(/EDT/)
    expect(allText).toMatch(/2:00/)
  })

  it('uses the Authorization: Bearer bot_token header', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const { token } = await slackPostOf(fetchMock.mock.calls[0])
    expect(`Bearer ${token}`).toBe('Bearer xoxb-test-token')
  })

  it('shows the retry count when the step retried before failing', async () => {
    const retried = { ...payload, retries_used: 2 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, retried, 'https://app.example.com')
    const { blocks } = (await slackPostOf(fetchMock.mock.calls[0]))
    const allText = blocks.flatMap((b: { fields?: { text: string }[] }) =>
      (b.fields ?? []).map((f) => f.text)
    ).join('\n')
    expect(allText).toContain('retried 2 times before failing')
  })

  it('singularizes the retry count for a single retry', async () => {
    const retried = { ...payload, retries_used: 1 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, retried, 'https://app.example.com')
    const { blocks } = (await slackPostOf(fetchMock.mock.calls[0]))
    const allText = blocks.flatMap((b: { fields?: { text: string }[] }) =>
      (b.fields ?? []).map((f) => f.text)
    ).join('\n')
    expect(allText).toContain('retried 1 time before failing')
  })

  it('says no retry when the step failed on its first attempt', async () => {
    // payload has no retries_used → treated as 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const { blocks } = (await slackPostOf(fetchMock.mock.calls[0]))
    const allText = blocks.flatMap((b: { fields?: { text: string }[] }) =>
      (b.fields ?? []).map((f) => f.text)
    ).join('\n')
    expect(allText).toContain('failed on first attempt (no retry)')
  })
})

describe('sendDurationAlert', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const durationPayload = {
    workflow_id: 'wf-1',
    workflow_name: 'Lead Routing',
    execution_id: 'exec-abc',
    duration_ms: 12000,
    threshold_ms: 8000,
    timestamp: '2024-01-15T18:00:00.000Z',
  }

  it('appends node= to the execution URL when the bottleneck step has a node id', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendDurationAlert(makeSupabase(slackConnection) as any, 'org-1', null, { ...durationPayload, node_id: 'node-slow' }, 'https://app.example.com')
    const { blocks } = (await slackPostOf(fetchMock.mock.calls[0]))
    const allText = blocks.map((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(allText).toContain('node=node-slow')
    expect(allText).toContain('execution=exec-abc')
  })

  it('omits the node param when no bottleneck node id is present', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendDurationAlert(makeSupabase(slackConnection) as any, 'org-1', null, durationPayload, 'https://app.example.com')
    const { blocks } = (await slackPostOf(fetchMock.mock.calls[0]))
    const allText = blocks.map((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(allText).not.toContain('node=')
  })
})

describe('sendQueryTimeoutAlert (#1043)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const offender = (over: Partial<QueryTimeoutOffender> = {}): QueryTimeoutOffender => ({
    role: 'service_role',
    queryid: '-309324826790438881',
    calls: 820,
    meanMs: 1662,
    maxMs: 29122,
    timeoutMs: 30000,
    meanPct: 1662 / 30000,
    maxPct: 29122 / 30000,
    severity: 'critical',
    querySample: 'WITH pgrst_source AS (SELECT $1)',
    ...over,
  })

  it('names the role, the share of its ceiling, and the full int64 queryid verbatim', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendQueryTimeoutAlert(makeSupabase(slackConnection) as any, 'org-1', [offender()])
    const { blocks } = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = blocks.map((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).toContain('service_role')
    expect(text).toContain('97%')
    // The queryid must survive intact: it is an int64 beyond JS's safe range, and a
    // corrupted value cannot be looked up in pg_stat_statements.
    expect(text).toContain('-309324826790438881')
  })

  it('leads with "close to being cancelled" when a statement is critical, and the softer header otherwise', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendQueryTimeoutAlert(makeSupabase(slackConnection) as any, 'org-1', [offender()]) // critical
    expect((await slackPostOf(fetchMock.mock.calls[0])).blocks[0].text.text).toBe('A database query is close to being cancelled')

    fetchMock.mockClear()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendQueryTimeoutAlert(makeSupabase(slackConnection) as any, 'org-1', [offender({ severity: 'warn', maxMs: 20000, maxPct: 20000 / 30000 })])
    expect((await slackPostOf(fetchMock.mock.calls[0])).blocks[0].text.text).toBe('A database query is approaching its timeout')
  })

  it('does nothing when Slack is not configured', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delivered = await sendQueryTimeoutAlert(makeSupabase(null) as any, 'org-1', [offender()])
    expect(delivered).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// Issue #82 (ok:false is not delivered) and the rest of postMessage's failure
// rules are proven against the Slack client in slack-deliver-message.test.ts (#2331).

describe('sendSlowSpikeAlert — propagates delivery result (for cooldown gating)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
  afterEach(() => vi.unstubAllGlobals())

  const spikePayload: SlowSpikeAlertPayload = {
    workflow_id: 'wf-1', workflow_name: 'Engine Bidding', slow_count: 8, total_count: 20,
    threshold_ms: 30000, slowest_ms: 60000, median_slow_ms: 40000, window_minutes: 5,
    timestamp: '2024-01-15T18:00:00.000Z',
  }

  it('returns null when Slack reports ok:false (so the caller skips the cooldown)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: false, error: 'not_in_channel' }) })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await sendSlowSpikeAlert(makeSupabase(slackConnection) as any, 'org-1', null, spikePayload, 'https://app')
    expect(sent).toBeNull()
  })

  it('returns the ts when delivered', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '200.1' }) })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await sendSlowSpikeAlert(makeSupabase(slackConnection) as any, 'org-1', null, spikePayload, 'https://app')
    expect(sent).toBe('200.1')
  })
})

describe('sendSecretDriftAlert (#199)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.23' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const conn = { bot_token: 'xoxb-test-token', default_channel: '#alerts' } as unknown as SlackConnection

  it('posts a Block Kit message naming the missing secrets', async () => {
    const sent = await sendSecretDriftAlert(
      conn,
      [
        { key: 'STRIPE_KEY', scope: 'global', workflow_id: null },
        { key: 'WF_TOKEN', scope: 'workflow', workflow_id: 'wf-9' },
      ],
      'https://app.test',
    )
    expect(sent).toBe(true)
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    expect(body.channel).toBe('#alerts')
    expect(body.unfurl_links).toBe(false)
    const text = body.blocks.flatMap((b: { fields?: { text: string }[]; text?: { text: string } }) => [
      ...(b.fields ?? []).map((f) => f.text), b.text?.text ?? '',
    ]).join('\n')
    expect(text).toContain('Secret Out of Sync')
    expect(text).toContain('STRIPE_KEY')
    expect(text).toContain('WF_TOKEN')
    expect(text).toContain('no copy in Cloudflare')
  })

  it('does nothing and reports not-sent when there are no missing secrets', async () => {
    expect(await sendSecretDriftAlert(conn, [], 'https://app.test')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('getSlackConnection — distinguishes a DB error from not-configured (#409)', () => {
  // The alert row read returns each queued result in order, repeating the last.
  function makeSeqSupabase(results: Array<{ data?: unknown; error?: { code?: string; message: string } | null }>) {
    let i = 0
    const chain: unknown = new Proxy({}, {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'limit') return alertRowsAnswer(() => {
          const r = results[Math.min(i, results.length - 1)]
          i++
          return Promise.resolve({ data: r.data ?? null, error: r.error ?? null })
        })
        return () => chain
      },
    })
    return { from: () => chain, _calls: () => i }
  }

  const cfg = { bot_token: 'xoxb-t', default_channel: '#a' }
  let errSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => errSpy.mockRestore())

  it('returns the connection on a successful read', async () => {
    const sb = makeSeqSupabase([{ data: { config: cfg } }])
    const conn = await getSlackConnection(sb as never, 'org-1', [0, 0])
    expect(conn?.bot_token).toBe('xoxb-t')
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('returns null silently when the org genuinely has no Slack connection', async () => {
    const sb = makeSeqSupabase([{ data: null, error: null }])
    const conn = await getSlackConnection(sb as never, 'org-1', [0, 0])
    expect(conn).toBeNull()
    expect(errSpy).not.toHaveBeenCalled() // not-configured is not an error
  })

  it('logs and returns null (does NOT look not-configured) when a transient DB error persists', async () => {
    const sb = makeSeqSupabase([{ error: { message: 'pool timeout' } }])
    const conn = await getSlackConnection(sb as never, 'org-1', [0, 0])
    expect(conn).toBeNull()
    expect(errSpy).toHaveBeenCalled()
    expect(String(errSpy.mock.calls[0][0])).toContain('org-1')
  })

  it('retries a transient error and returns the connection when a later attempt succeeds', async () => {
    const sb = makeSeqSupabase([
      { error: { message: 'pool timeout' } },
      { data: { config: cfg } },
    ])
    const conn = await getSlackConnection(sb as never, 'org-1', [0, 0])
    expect(conn?.bot_token).toBe('xoxb-t')
  })

  it('fails fast on a permanent error (schema drift) without retrying', async () => {
    const sb = makeSeqSupabase([{ error: { code: '42P01', message: 'undefined_table' } }])
    const conn = await getSlackConnection(sb as never, 'org-1', [0, 0])
    expect(conn).toBeNull()
    expect(errSpy).toHaveBeenCalled()
    expect(sb._calls()).toBe(1) // no retry attempts on a permanent error
  })
})

describe('sendMatrixSyncFailureAlert (#408)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.23' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  function makeSupabase(connection: Record<string, unknown> | null) {
    const chain: unknown = new Proxy({}, {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'limit') return alertRowsAnswer(() => Promise.resolve({ data: connection ? { config: connection } : null, error: null }))
        return () => chain
      },
    })
    return { from: () => chain }
  }
  const conn = { bot_token: 'xoxb-t', default_channel: '#alerts', config_alerts_enabled: true }

  it('lists failed syncs and preserved matrices with a fix path', async () => {
    const sent = await sendMatrixSyncFailureAlert(makeSupabase(conn) as never, 'org-1', null, {
      failed: [{ config_slug: 'sofi', error: 'Salesforce query failed (503)' }],
      preserved: [{ config_slug: 'nerdwallet' }],
    })
    expect(sent).toBe(true)
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).toContain('sofi')
    expect(text).toContain('503')
    expect(text).toContain('nerdwallet')
    expect(text).toContain('How to fix:')
  })

  it('does nothing when the org opted out of config alerts', async () => {
    const sent = await sendMatrixSyncFailureAlert(makeSupabase({ ...conn, config_alerts_enabled: false }) as never, 'org-1', null, {
      failed: [{ config_slug: 'sofi', error: 'x' }],
      preserved: [],
    })
    expect(sent).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does nothing when there are no issues', async () => {
    const sent = await sendMatrixSyncFailureAlert(makeSupabase(conn) as never, 'org-1', null, { failed: [], preserved: [] })
    expect(sent).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('sendExportFailureAlert (#412)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.23' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  function makeSupabase(connection: Record<string, unknown> | null) {
    const chain: unknown = new Proxy({}, {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'limit') return alertRowsAnswer(() => Promise.resolve({ data: connection ? { config: connection } : null, error: null }))
        return () => chain
      },
    })
    return { from: () => chain }
  }
  const conn = { bot_token: 'xoxb-t', default_channel: '#alerts', config_alerts_enabled: true }

  it('names the job and lists the errors with a fix hint', async () => {
    const sent = await sendExportFailureAlert(makeSupabase(conn) as never, 'org-1', null, {
      jobName: 'Lead sightings export', errors: ['sightings export: Snowflake 503', 'bids export: timeout'],
    })
    expect(sent).toBe(true)
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).toContain('Lead sightings export')
    expect(text).toContain('Snowflake 503')
    expect(text).toContain('not exported')
  })

  it('cuts an address in an error line at its query string, titled or not (L741, #1740)', async () => {
    const leaky = 'sightings export: 401 from https://p.example/x?email=jo%40example.com'
    await sendExportFailureAlert(makeSupabase(conn) as never, 'org-1', null, { jobName: 'Lead sightings export', errors: [leaky] })
    await sendExportFailureAlert(makeSupabase(conn) as never, 'org-1', null, { jobName: 'x', errors: [leaky], title: 'Export failed' })
    for (const call of fetchMock.mock.calls) {
      const body = await slackPostOf(call)
      const text = [body.text, ...body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '')].join('\n')
      expect(text).not.toMatch(/%40|email=/)
      expect(text).toContain('https://p.example/x')
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a titled alert is the title, the findings, an optional context line and a short fix, nothing else', async () => {
    // Dan, 2026-10-01, on the Tripoint pricing alert: "It's so hard to understand
    // right now". A check that names itself and explains itself buries the one
    // line that matters under a job slug and two sentences of framing.
    await sendExportFailureAlert(makeSupabase(conn) as never, 'org-1', null, {
      jobName: 'tripoint-pricing-drift',
      errors: ['$12,500+ debt: Bidspoke 0.12%, Salesforce 0.13%'],
      title: 'Tripoint rate mismatch',
      context: 'Salesforce changed Sep 30 by Daniel Wright.',
      fixHint: 'update whichever is wrong.',
    })
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    expect(body.blocks[0].text.text).toBe('Tripoint rate mismatch')
    const rest = body.blocks.slice(1).map((b: { text?: { text: string } }) => b.text?.text ?? '')
    expect(rest).toEqual([
      '$12,500+ debt: Bidspoke 0.12%, Salesforce 0.13%\nSalesforce changed Sep 30 by Daniel Wright.',
      '*Fix:* update whichever is wrong.',
    ])
    expect(body.text).toBe('Tripoint rate mismatch')
  })

  it('a titled alert with several findings bullets them, and one with no fix hint has no fix line', async () => {
    await sendExportFailureAlert(makeSupabase(conn) as never, 'org-1', null, {
      jobName: 'tripoint-pricing-drift',
      errors: ['one', 'two'],
      title: "Tripoint rate check couldn't run",
    })
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const rest = body.blocks.slice(1).map((b: { text?: { text: string } }) => b.text?.text ?? '')
    expect(rest).toEqual(['• one\n• two'])
  })

  it('a titled reminder says still in its title', async () => {
    await sendExportFailureAlert(makeSupabase(conn) as never, 'org-1', null, {
      jobName: 'tripoint-pricing-drift', errors: ['x'], title: 'Tripoint rate mismatch', repeat: 'Reminder 2.',
    })
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    expect(body.blocks[0].text.text).toBe('Tripoint rate mismatch (still)')
  })

  it('does not call the export nightly (lead sightings runs every 2 hours)', async () => {
    // The header said "Nightly export failed" long after the sightings export
    // moved to a 2-hourly cron (2026-06-29). On 2026-07-09 that made a blip
    // that self-healed within 2 hours read like a full night of stale analytics.
    await sendExportFailureAlert(makeSupabase(conn) as never, 'org-1', null, {
      jobName: 'Lead sightings export', errors: ['bids export: Snowflake 503'],
    })
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const header = body.blocks[0].text.text
    expect(header).toBe('Lead sightings export failed')
    expect(JSON.stringify(body.blocks).toLowerCase()).not.toContain('nightly')
  })

  it('names the failing job in the header instead of blaming Snowflake for everything', async () => {
    // 2026-07-24: a purge blip (Cloudflare 522 reaching Supabase, Snowflake never
    // involved) was headlined "Snowflake export failed", which read as a relapse
    // of the July export incidents. The header must name the job that failed.
    await sendExportFailureAlert(makeSupabase(conn) as never, 'org-1', null, {
      jobName: 'Lead sightings purge', errors: ['sightings purge: error code: 522'],
    })
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    expect(body.blocks[0].text.text).toBe('Lead sightings purge failed')
  })

  // A check that RAN CORRECTLY and found something has not failed, and what it
  // found is not an error. On 2026-09-10 the code node log scan's first real
  // finding arrived headlined "code-node-payload-prints failed" and counted as
  // "1 error", so an alert about a line of code read as a broken job. A caller
  // that knows better says so; every existing caller keeps the failure wording
  // (L11: a message may claim only what its check measured).
  it('lets a caller say the job found something rather than failed', async () => {
    await sendExportFailureAlert(makeSupabase(conn) as never, 'org-1', null, {
      jobName: 'code-node-payload-prints',
      errors: ['A / b prints c to the log.'],
      headlineVerb: 'found something to look at',
      itemNoun: { one: 'finding', many: 'findings' },
    })
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    expect(body.blocks[0].text.text).toBe('code-node-payload-prints found something to look at')
    expect(JSON.stringify(body.blocks)).toContain('reported 1 finding.')
    expect(JSON.stringify(body.blocks)).not.toContain('1 error')
  })

  it('pluralises the caller-supplied noun', async () => {
    await sendExportFailureAlert(makeSupabase(conn) as never, 'org-1', null, {
      jobName: 'code-node-payload-prints',
      errors: ['one', 'two'],
      headlineVerb: 'found something to look at',
      itemNoun: { one: 'finding', many: 'findings' },
    })
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    expect(JSON.stringify(body.blocks)).toContain('reported 2 findings.')
  })

  it('still says failed and errors when the caller supplies neither', async () => {
    await sendExportFailureAlert(makeSupabase(conn) as never, 'org-1', null, {
      jobName: 'Lead sightings export', errors: ['bids export: Snowflake 503'],
    })
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    expect(body.blocks[0].text.text).toBe('Lead sightings export failed')
    expect(JSON.stringify(body.blocks)).toContain('reported 1 error.')
  })

  it('does not claim stale Snowflake analytics for a purge failure', async () => {
    // A failed purge means the rows are ALREADY in Snowflake and only the
    // Supabase cleanup is behind. Saying analytics are stale is false alarm copy.
    await sendExportFailureAlert(makeSupabase(conn) as never, 'org-1', null, {
      jobName: 'Lead sightings purge', errors: ['sightings purge: error code: 522'],
    })
    const text = JSON.stringify((await slackPostOf(fetchMock.mock.calls[0])).blocks)
    expect(text).not.toContain('stale')
    expect(text).toContain('already')
  })

  it('says when the failures started on a second-consecutive-failure alert', async () => {
    await sendExportFailureAlert(makeSupabase(conn) as never, 'org-1', null, {
      jobName: 'Lead sightings purge',
      errors: ['sightings purge: error code: 522'],
      failingSince: '2026-07-24T11:48:00.000Z',
    })
    const text = JSON.stringify((await slackPostOf(fetchMock.mock.calls[0])).blocks)
    expect(text).toContain('second consecutive')
    // Rendered in ET like every other alert timestamp (11:48 UTC = 7:48 AM EDT).
    expect(text).toContain('7:48')
  })

  it('renders a caller-supplied fix hint instead of the canned Snowflake line (#542)', async () => {
    await sendExportFailureAlert(makeSupabase(conn) as never, 'org-1', null, {
      jobName: 'Lead sightings export',
      errors: ['bids export: Snowflake 503: connection termination'],
      fixHint: 'No action needed. The rows retry on the next run.',
    })
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = JSON.stringify(body.blocks)
    expect(text).toContain('No action needed. The rows retry on the next run.')
    expect(text).not.toContain('Check Snowflake availability')
  })

  it('renders a caller-supplied consequence instead of claiming rows were not exported (#1180)', async () => {
    // The 2026-09-05 killed-run alert: the job exports nothing itself, and the
    // run posting it is the one archiving what its predecessor left.
    await sendExportFailureAlert(makeSupabase(conn) as never, 'org-1', null, {
      jobName: 'execution-archive-killed',
      errors: ['the previous run has held the lock for 60 minutes, past its own deadline and the 5 minute grace, so it was killed rather than still working.'],
      consequence: 'This run took over and is archiving the hours its predecessor left:',
      fixHint: 'Nothing is lost.',
    })
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = JSON.stringify(body.blocks)
    expect(text).toContain('is archiving the hours its predecessor left')
    expect(text).not.toContain('not exported')
    expect(text).not.toContain('missing them')
  })

  it('falls back to the generic fix line when no hint is supplied', async () => {
    await sendExportFailureAlert(makeSupabase(conn) as never, 'org-1', null, {
      jobName: 'x', errors: ['boom'],
    })
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    // The generic line no longer names Snowflake (#835): it names no system at all.
    expect(JSON.stringify(body.blocks)).toContain('Read the error above')
  })

  it('does nothing when there are no errors', async () => {
    const sent = await sendExportFailureAlert(makeSupabase(conn) as never, 'org-1', null, { jobName: 'x', errors: [] })
    expect(sent).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('respects the config-alerts opt-out', async () => {
    const sent = await sendExportFailureAlert(makeSupabase({ ...conn, config_alerts_enabled: false }) as never, 'org-1', null, { jobName: 'x', errors: ['boom'] })
    expect(sent).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('sendSecretDecryptAlert (#404)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.23' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const conn = { bot_token: 'xoxb-test-token', default_channel: '#alerts' } as unknown as SlackConnection

  it('posts a Block Kit message naming the undecryptable secrets with a fix path', async () => {
    const sent = await sendSecretDecryptAlert(conn, [{ key: 'ELIGIBILITY_SCOUT_CLIENT_SECRET', workflow: null }], 'https://app.test')
    expect(sent).toBe(true)
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    expect(body.channel).toBe('#alerts')
    expect(body.unfurl_links).toBe(false)
    const text = body.blocks.flatMap((b: { fields?: { text: string }[]; text?: { text: string } }) => [
      ...(b.fields ?? []).map((f) => f.text), b.text?.text ?? '',
    ]).join('\n')
    expect(text).toContain('Secret cannot be decrypted')
    expect(text).toContain('ELIGIBILITY_SCOUT_CLIENT_SECRET')
    expect(text).toContain('How to fix:')
    expect(text).toContain('https://app.test/env')
  })

  // #1681: the same key can be the org's and a workflow's own, and the two are
  // handled differently at load (skipped against withheld), so the line says which.
  it("names the workflow a workflow's own secret was saved for, and says its runs get it empty", async () => {
    await sendSecretDecryptAlert(
      conn,
      [{ key: 'EQUIFAX_PASSWORD', workflow: null }, { key: 'EQUIFAX_PASSWORD', workflow: 'Main Flow' }],
      'https://app.test',
    )
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const lines = (body.blocks[2].text.text as string).split('\n')
    expect(lines).toEqual(['• `EQUIFAX_PASSWORD`', "• `EQUIFAX_PASSWORD`, saved for the workflow Main Flow, whose runs get it empty"])
  })

  // What the loader does with each kind differs, so the alert says what happens
  // to the kinds it lists, and only those: an org secret is left out (and some
  // nodes fall back to its Cloudflare copy), a workflow's own is handed over empty.
  const summary = async (secrets: { key: string; workflow: string | null }[]) => {
    fetchMock.mockClear()
    await sendSecretDecryptAlert(conn, secrets, 'https://app.test')
    return (await slackPostOf(fetchMock.mock.calls[0])).blocks[1].text.text as string
  }
  const ORG_LINE = 'An organization secret is left out of every run. Code, Webhook and Salesforce nodes fall back to its Cloudflare copy if one exists; other nodes get no value.'
  const WORKFLOW_LINE = "A secret saved for one workflow is handed to that workflow's runs empty, so the organization's value of the same name is never sent in its place."

  it('says what happens to an org secret, and nothing about workflow secrets, when only org secrets are listed', async () => {
    expect(await summary([{ key: 'A', workflow: null }])).toBe(
      `*1 secret cannot be decrypted.* ${ORG_LINE} Nothing errors until a call that needs it fails:`,
    )
  })

  it("says what happens to a workflow's own secret when only those are listed", async () => {
    expect(await summary([{ key: 'A', workflow: 'Main Flow' }, { key: 'B', workflow: 'Main Flow' }])).toBe(
      `*2 secrets cannot be decrypted.* ${WORKFLOW_LINE} Nothing errors until a call that needs one fails:`,
    )
  })

  it('says both when both kinds are listed', async () => {
    expect(await summary([{ key: 'A', workflow: null }, { key: 'A', workflow: 'Main Flow' }])).toBe(
      `*2 secrets cannot be decrypted.* ${ORG_LINE} ${WORKFLOW_LINE} Nothing errors until a call that needs one fails:`,
    )
  })

  it('does nothing and reports not-sent when there are no keys', async () => {
    expect(await sendSecretDecryptAlert(conn, [], 'https://app.test')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('sendBackupFailureAlert (#206)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.23' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const conn = { bot_token: 'xoxb-test-token', default_channel: '#alerts' } as unknown as SlackConnection

  it('posts a Block Kit message naming the workflow, failure count, error, and link', async () => {
    const sent = await sendBackupFailureAlert(
      conn,
      { workflow_id: 'wf-9', workflow_name: 'Main Flow', consecutive_failures: 3, error_message: 'GitHub push failed (401): Bad credentials' },
      'https://app.test',
    )
    expect(sent).toBe(true)
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    expect(body.channel).toBe('#alerts')
    expect(body.unfurl_links).toBe(false)
    const text = body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).toContain('Workflow Backup Failing')
    expect(text).toContain('Main Flow')
    expect(text).toContain('3 saves in a row')
    expect(text).toContain('Bad credentials')
    expect(text).toContain('https://app.test/workflows/wf-9')
  })

  it('truncates an overlong error message', async () => {
    await sendBackupFailureAlert(
      conn,
      { workflow_id: 'wf-9', workflow_name: 'X', consecutive_failures: 2, error_message: 'e'.repeat(500) },
      'https://app.test',
    )
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).toContain('…')
    expect(text).not.toContain('e'.repeat(400))
  })

  // #605: the trailing SQLSTATE code is the most searchable token; head-only
  // truncation dropped it once #602 folded Postgres details into the message.
  it('keeps the trailing error code when truncating a long constraint error', async () => {
    const longErr = `insert or update violates foreign key constraint: Key (person_id)=(${'a'.repeat(400)}) is not present. (23503)`
    await sendBackupFailureAlert(
      conn,
      { workflow_id: 'wf-9', workflow_name: 'X', consecutive_failures: 2, error_message: longErr },
      'https://app.test',
    )
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).toContain('(23503)')
  })
})

describe('sendOutcomeDeadLetterAlert for a lost Salesforce update after the answer', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.23' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const conn = { bot_token: 'xoxb-test-token', default_channel: '#alerts' } as unknown as SlackConnection
  const run = { workflow_id: 'wf-7', workflow_name: 'Engine Bidding Workflow', execution_id: 'ex-9', at: '2026-10-03T05:01:03Z' }
  const send = (over: Partial<Parameters<typeof sendOutcomeDeadLetterAlert>[1]> = {}) =>
    sendOutcomeDeadLetterAlert(
      conn,
      {
        label: 'sf_writeback',
        window_loss_count: 1,
        window_minutes: 30,
        error_message: 'Salesforce API error (401): [{"message":"Session expired or invalid","errorCode":"INVALID_SESSION_ID"}]',
        run,
        ...over,
      },
      'https://app.test',
    )
  const textOf = async () => {
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    return body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
  }

  it('names the workflow, the time in ET, what Salesforce said, and links the run', async () => {
    await send()
    const text = (await textOf())
    expect(text).toContain('Salesforce update lost')
    expect(text).toContain('Engine Bidding Workflow answered a lead at 1:01 AM ET')
    expect(text).toContain('1 lead was affected in the last 30 minutes.')
    expect(text).toContain('Salesforce said: Session expired or invalid.')
    expect(text).toContain('Fix: open the run below and enter the outcome in Salesforce by hand. Bidspoke will not retry it.')
    expect(text).toContain('<https://app.test/workflows/wf-7?execution=ex-9|View the run')
  })

  it('drops the internal label, the raw JSON and the claim of retries', async () => {
    await send()
    const text = (await textOf())
    expect(text).not.toContain('sf_writeback')
    expect(text).not.toContain('errorCode')
    expect(text).not.toContain('after all retries')
  })

  it('counts several leads and links the latest run', async () => {
    await send({ window_loss_count: 3 })
    const text = (await textOf())
    // #1944: a chained burst spans longer than the counter's 30 min TTL, so the
    // copy says "recently" rather than asserting a fixed window above one loss.
    expect(text).toContain('3 leads were affected recently.')
    expect(text).not.toMatch(/in the last \d+ minutes/)
    expect(text).toContain('View the latest run')
  })

  it('passes a non-JSON Salesforce error on as written', async () => {
    await send({ error_message: 'Salesforce API error (503): Service Unavailable' })
    expect((await textOf())).toContain('Salesforce said: Service Unavailable')
  })

  it('cuts an address in a Salesforce message at its query string, so a SOQL filter on an email cannot reach Slack (L741, #1740)', async () => {
    await send({ error_message: 'Salesforce API error (400): [{"message":"Bad query at https://pennie.my.salesforce.com/services/data/v60.0/query?q=SELECT+Id+FROM+Lead+WHERE+Email%3D%27jo%40example.com%27","errorCode":"MALFORMED_QUERY"}]' })
    const text = (await textOf())
    expect(text).not.toMatch(/%40|Email%3D|q=SELECT/)
    expect(text).toContain('https://pennie.my.salesforce.com/services/data/v60.0/query')
  })
})

// #1860: a run's work after its answer still running when finalize stopped
// waiting. Its outcome is unknown, so the alert must not say anything was lost.
describe('sendOutcomeDeadLetterAlert for work after the answer that did not finish', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.23' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const conn = { bot_token: '[REDACTED]', default_channel: '#alerts' } as unknown as SlackConnection
  const textOf = async () => {
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    return [body.text, ...body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '')].join('\n')
  }

  // #2024: the page now fires only for work the Salesforce read-back does not
  // hold, and on 2026-10-13, 8 of 18 such writes had not landed. So it no longer
  // suggests the work probably finished: it says nothing confirmed it.
  it('says nothing confirmed the work finished, never that it may have finished or that a record was lost', async () => {
    await sendOutcomeDeadLetterAlert(conn, {
      label: 'continuation_unfinished',
      window_loss_count: 1,
      window_minutes: 30,
      error_message: "The run's work after the answer did not finish within 12 s of the answer. Nothing confirmed whether it finished.",
      run: { workflow_id: 'wf-1', workflow_name: 'Main Flow', execution_id: 'ex-1', at: '2026-10-07T20:00:00Z' },
    }, 'https://app.test')
    const text = (await textOf())
    expect(text).toMatch(/did not finish/i)
    expect(text).toContain('Nothing confirmed whether they finished.')
    expect(text).not.toMatch(/may (still )?(have )?finish/i)
    expect(text).not.toMatch(/lost|must-not-lose|not auto-recovered/i)
    expect(text).toContain('https://app.test/workflows/wf-1?execution=ex-1')
  })

  // #1882: the alert sent the reader to the Salesforce update, which had landed 87
  // ms after the answer; the step still out was the Achieve call. It names the step.
  it('names the step that was still running and sends the reader to it, not to Salesforce', async () => {
    await sendOutcomeDeadLetterAlert(conn, {
      label: 'continuation_unfinished',
      window_loss_count: 3,
      window_minutes: 30,
      error_message: "The run's work after the answer did not finish within 12 s of the answer. Still running then: Achieve under 10k (achieve_under_10k). Nothing confirmed whether it finished.",
      run: {
        workflow_id: 'wf-1', workflow_name: 'Main Flow', execution_id: 'ex-1', at: '2026-10-08T03:20:17Z',
        still_running: ['Achieve under 10k (achieve_under_10k)'],
      },
    }, 'https://app.test')
    const text = (await textOf())
    expect(text).toContain('Main Flow answered a lead at 11:20 PM ET, but the step Achieve under 10k (achieve_under_10k) was still running when Bidspoke stopped waiting. Nothing confirmed whether it or the steps after it finished.')
    expect(text).toContain('Fix: open the run below and check what Achieve under 10k (achieve_under_10k) did, and whether the steps after it ran. If this keeps happening, that step is running slowly.')
    expect(text).not.toMatch(/salesforce/i)
  })

  // A step's name is its label, which anyone editing the canvas types. Slack reads
  // <, > and & as markup, so a label like <!channel> would ping the whole channel.
  it('escapes a step label so it cannot become a Slack mention or link', async () => {
    await sendOutcomeDeadLetterAlert(conn, {
      label: 'continuation_unfinished',
      window_loss_count: 3,
      window_minutes: 30,
      error_message: 'x',
      run: {
        workflow_id: 'wf-1', workflow_name: 'Main Flow', execution_id: 'ex-1', at: '2026-10-08T03:20:17Z',
        still_running: ['<!channel> & <https://evil.test|click> (patch_a)'],
      },
    }, 'https://app.test')
    const text = (await textOf())
    expect(text).toContain('&lt;!channel&gt; &amp; &lt;https://evil.test|click&gt; (patch_a)')
    expect(text).not.toContain('<!channel>')
  })

  it('lists every step when more than one was still running', async () => {
    await sendOutcomeDeadLetterAlert(conn, {
      label: 'continuation_unfinished',
      window_loss_count: 3,
      window_minutes: 30,
      error_message: 'x',
      run: {
        workflow_id: 'wf-1', workflow_name: 'Main Flow', execution_id: 'ex-1', at: '2026-10-08T03:20:17Z',
        still_running: ['patch_a', 'patch_b', 'patch_c'],
      },
    }, 'https://app.test')
    const text = (await textOf())
    expect(text).toContain('the steps patch_a, patch_b and patch_c were still running')
    expect(text).toContain('those steps are running slowly')
  })

  it('keeps that wording when the payload carries no run', async () => {
    await sendOutcomeDeadLetterAlert(conn, {
      label: 'continuation_unfinished',
      window_loss_count: 3,
      window_minutes: 30,
      error_message: "The run's work after the answer did not finish within 12 s of the answer; it may still finish, but nothing confirmed it",
    }, 'https://app.test')
    const text = (await textOf())
    expect(text).toMatch(/did not finish/i)
    expect(text).not.toMatch(/lost|must-not-lose|not auto-recovered/i)
  })

  // #1944: the window counter rewrites its key with a fresh 30 min TTL on every
  // loss, so three losses ~25 min apart chain to a count of 3 while spanning ~50
  // min. "about 3 times in the last 30 minutes" overstates the precision of a
  // sliding window, so the copy must not assert a fixed clock period.
  it('does not claim a fixed clock window, since the counter slides past 30 minutes', async () => {
    await sendOutcomeDeadLetterAlert(conn, {
      label: 'continuation_unfinished',
      window_loss_count: 3,
      window_minutes: 30,
      error_message: 'x',
      run: { workflow_id: 'wf-1', workflow_name: 'Main Flow', execution_id: 'ex-1', at: '2026-10-08T03:20:17Z' },
    }, 'https://app.test')
    const text = (await textOf())
    expect(text).toContain('about 3 times recently')
    expect(text).not.toMatch(/in the last \d+ minutes/)
  })

  // #1944: this renderer is reached only for continuation_unfinished, whose
  // dead-letter threshold is 3, so window_loss_count is always >= 3 when it
  // fires. The singular "once" / "View the run" branches are unreachable (L29).
  it('never renders the singular forms, since it only fires at a count of three or more', async () => {
    await sendOutcomeDeadLetterAlert(conn, {
      label: 'continuation_unfinished',
      window_loss_count: 3,
      window_minutes: 30,
      error_message: 'x',
      run: { workflow_id: 'wf-1', workflow_name: 'Main Flow', execution_id: 'ex-1', at: '2026-10-08T03:20:17Z' },
    }, 'https://app.test')
    const text = (await textOf())
    expect(text).not.toContain('This happened once')
    expect(text).not.toContain('|View the run ')
    expect(text).toContain('View the latest run')
  })

  // #1944: the renderer is count-agnostic by design, so even though production
  // never reaches it below a count of 3, a single loss must still read correctly:
  // the noun is singular ("1 time"), the period keeps the precise window (a lone
  // loss really is inside it), and the link stays the one shared "View the latest
  // run". This covers the n = 1 branch of deadLetterPeriod and the pluralisation.
  it('reads correctly at a count of one, keeping one vocabulary', async () => {
    await sendOutcomeDeadLetterAlert(conn, {
      label: 'continuation_unfinished',
      window_loss_count: 1,
      window_minutes: 30,
      error_message: 'x',
      run: { workflow_id: 'wf-1', workflow_name: 'Main Flow', execution_id: 'ex-1', at: '2026-10-08T03:20:17Z' },
    }, 'https://app.test')
    const text = (await textOf())
    expect(text).toContain('This happened about 1 time in the last 30 minutes.')
    expect(text).not.toContain('1 times')
    expect(text).not.toContain('This happened once')
    expect(text).toContain('View the latest run')
  })
})

describe('sendOutcomeDeadLetterAlert (#309)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.23' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const conn = { bot_token: 'xoxb-test-token', default_channel: '#alerts' } as unknown as SlackConnection

  it('names the lost op, the windowed loss count, the error, and how to fix it', async () => {
    const sent = await sendOutcomeDeadLetterAlert(
      conn,
      // lead_sightings.insert is a genuine, non-self-healing loss (no in_flight
      // row for the drain to find); lead_sightings.finalize now self-heals (#1953).
      { label: 'lead_sightings.insert', window_loss_count: 47, window_minutes: 30, error_message: 'PGRST002 schema cache' },
      'https://app.test',
    )
    expect(sent).toBe(true)
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    expect(body.channel).toBe('#alerts')
    expect(body.unfurl_links).toBe(false)
    const text = body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).toContain('Outcome Record Lost')
    expect(text).toContain('lead_sightings.insert')
    // #599: report the true windowed magnitude, not a consecutive streak.
    expect(text).toContain('*47*')
    // #1944: a chained burst spans longer than the 30 min TTL, so above one loss
    // the copy says "recently" instead of asserting a fixed window.
    expect(text).toContain('writes were lost recently')
    expect(text).not.toMatch(/in the last \d+ minutes/)
    expect(text).toContain('PGRST002 schema cache')
    expect(text).toContain('How to fix:')
  })

  it('uses singular copy when exactly one write was lost', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      { label: 'lead_sightings.insert', window_loss_count: 1, window_minutes: 30, error_message: 'x' },
      'https://app.test',
    )
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).toContain('*1*')
    expect(text).toContain('write was lost in the last 30 minutes')
  })

  // #600: the guidance must not blame Supabase / the purge window for a
  // permanent no-row-matched cause (the #591 ordering race). It should name the
  // real cause and never send the reader at infrastructure.
  it('gives ordering-race guidance and no Supabase/purge blame for a no-row-matched loss', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      {
        label: 'lead_sightings.finalize',
        window_loss_count: 3,
        window_minutes: 30,
        error_message: 'finalize matched zero rows (BIDSPOKE_NO_ROW_MATCHED)',
        error_code: 'BIDSPOKE_NO_ROW_MATCHED',
      },
      'https://app.test',
    )
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).toContain('How to fix:')
    expect(text).not.toContain('Supabase')
    expect(text).not.toContain('purge')
    expect(text).toContain('execution log')
    expect(text).toMatch(/ordering race|#591/)
  })

  // #600: a permanent constraint code is not fixable by waiting; don't blame the
  // purge window or Supabase health.
  it('gives permanent-error guidance and no Supabase/purge blame for a constraint loss', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      {
        label: 'lead_sightings.finalize',
        window_loss_count: 2,
        window_minutes: 30,
        error_message: 'violates foreign key constraint (23503)',
        error_code: '23503',
      },
      'https://app.test',
    )
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).not.toContain('Supabase')
    expect(text).not.toContain('purge')
    expect(text).toMatch(/permanent/i)
    expect(text).toContain('execution log')
  })

  // #600: a genuinely transient DB code is the ONLY case that mentions Supabase,
  // and it must not blame the brief nightly purge (a dead-letter already outlasted
  // the full retry ladder).
  it('mentions Supabase (but not the purge window) for a transient DB code', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      {
        label: 'lead_sightings.insert',
        window_loss_count: 5,
        window_minutes: 30,
        error_message: 'Could not query the database for the schema cache (PGRST002)',
        error_code: 'PGRST002',
      },
      'https://app.test',
    )
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).toContain('Supabase')
    expect(text).not.toContain('nightly partition-purge')
    expect(text).toContain('execution log')
  })

  // #600: an error with no DB code (e.g. tier-3 Salesforce writeback) must not be
  // blamed on Supabase; it gets neutral inspect-the-error guidance.
  it('gives neutral guidance and no Supabase blame when there is no error code', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      {
        label: 'salesforce.writeback',
        window_loss_count: 1,
        window_minutes: 30,
        error_message: 'Salesforce 503 Service Unavailable',
      },
      'https://app.test',
    )
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).toContain('How to fix:')
    expect(text).not.toContain('Supabase')
    expect(text).toContain('execution log')
  })

  // #585: an execution_finalize loss that left the row stuck at 'running' is
  // recovered automatically by the stranded-execution drain. The alert must say
  // so, so an on-call reader knows it self-heals rather than panicking.
  it('tells the reader the stranded drain will recover an execution_finalize row stuck at running', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      {
        label: 'execution_finalize',
        window_loss_count: 4,
        window_minutes: 30,
        error_message: 'Could not query the database for the schema cache (PGRST002)',
        error_code: 'PGRST002',
      },
      'https://app.test',
    )
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).toMatch(/stranded/i)
    expect(text).toMatch(/running/)
    // It self-heals, so it must NOT claim the record is lost / not auto-recovered.
    expect(text).not.toContain('not auto-recovered')
  })

  // #585: the zero-row (BIDSPOKE_NO_ROW_MATCHED) case is genuinely unrecoverable
  // by the drain (no 'running' row exists to repair), so it keeps paging and must
  // NOT promise automatic recovery.
  it('keeps paging (no drain promise) for an execution_finalize no-row loss', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      {
        label: 'execution_finalize',
        window_loss_count: 1,
        window_minutes: 30,
        error_message: 'the execution record is missing (BIDSPOKE_NO_ROW_MATCHED)',
        error_code: 'BIDSPOKE_NO_ROW_MATCHED',
      },
      'https://app.test',
    )
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).not.toMatch(/stranded/i)
    expect(text).not.toMatch(/recover(s|ed|ered) automatically|will be recovered/i)
  })

  // #585/#1953: the drain note is for the finalize labels that self-heal; a
  // genuine loss like lead_sightings.insert (no in_flight row to recover) keeps
  // its Supabase-health guidance and no drain promise.
  it('does not add the drain note for a genuinely-lost label', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      {
        label: 'lead_sightings.insert',
        window_loss_count: 2,
        window_minutes: 30,
        error_message: 'schema cache (PGRST002)',
        error_code: 'PGRST002',
      },
      'https://app.test',
    )
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).not.toMatch(/stranded/i)
    expect(text).toContain('Supabase')
  })

  // #605: keep the trailing SQLSTATE code when a rich constraint error runs long.
  it('keeps the trailing error code when truncating a long constraint error', async () => {
    const longErr = `insert or update violates foreign key constraint: Key (person_id)=(${'a'.repeat(400)}) is not present. (23503)`
    await sendOutcomeDeadLetterAlert(
      conn,
      { label: 'lead_sightings.finalize', window_loss_count: 3, window_minutes: 30, error_message: longErr },
      'https://app.test',
    )
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).toContain('(23503)')
  })
})

// #1953: the lead-sighting finalize and bid-insert losses recover automatically
// via reduce_finalize_stranded (the :27/:57 strand drain), the same way the
// execution_finalize loss does via the per-minute execution drain. The alert
// must say so for the recoverable cases, and must NOT claim recovery for the
// cases the drain genuinely cannot repair (a permanent error that would recur on
// the replay, or a bid row whose sighting already finalized).
describe('sendOutcomeDeadLetterAlert sighting self-healing (#1953)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.23' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())
  const conn = { bot_token: '[REDACTED]', default_channel: '#alerts' } as unknown as SlackConnection
  const textOf = async () => {
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    return body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
  }

  it('reframes a read-back lead_sightings.finalize loss as a self-healing delay', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      {
        label: 'lead_sightings.finalize',
        window_loss_count: 2,
        window_minutes: 30,
        error_message: 'timed out; read back found it never landed',
        error_code: 'BIDSPOKE_READ_BACK_MISSING',
      },
      'https://app.test',
    )
    const text = (await textOf())
    expect(text).toContain('Outcome Record Delayed')
    expect(text).not.toContain('Outcome Record Lost')
    expect(text).toMatch(/in_flight/)
    expect(text).toMatch(/strand drain/i)
    expect(text).not.toContain('not auto-recovered')
  })

  it('still reports a permanent lead_sightings.finalize error as a real loss, not self-healing', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      {
        label: 'lead_sightings.finalize',
        window_loss_count: 1,
        window_minutes: 30,
        error_message: 'violates check constraint (23514)',
        error_code: '23514',
      },
      'https://app.test',
    )
    const text = (await textOf())
    expect(text).toContain('Outcome Record Lost')
    expect(text).toMatch(/permanent/i)
    expect(text).not.toMatch(/in_flight|strand drain/i)
  })

  it('tells the reader a lost bid row self-heals only if the sighting is also in_flight', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      {
        label: 'lead_sighting_bids.insert',
        window_loss_count: 1,
        window_minutes: 30,
        error_message: 'timed out; read back found the bid row not there',
        error_code: 'BIDSPOKE_READ_BACK_MISSING',
      },
      'https://app.test',
    )
    const text = (await textOf())
    expect(text).toMatch(/in_flight/)
    expect(text).toMatch(/strand drain/i)
    // Honest about the case it does NOT recover: a bid lost while the sighting finalized.
    expect(text).toContain('not auto-recovered')
  })
})

describe('sendFailureSpikeAlert (#248)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.23' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const spikePayload = {
    workflow_id: 'wf-1',
    workflow_name: 'Engine Bidding',
    signal: 'ACRO_GATEWAY',
    failure_count: 12,
    window_minutes: 5,
    timestamp: '2024-01-15T18:00:00.000Z',
  }

  it('no-ops when Slack is not connected', async () => {
    const ts = await sendFailureSpikeAlert(makeSupabase(null) as never, 'org-1', null, spikePayload, 'https://app.example.com')
    expect(ts).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts the signal and count, returns the ts', async () => {
    const ts = await sendFailureSpikeAlert(makeSupabase(slackConnection) as never, 'org-1', null, spikePayload, 'https://app.example.com')
    expect(ts).toBe('1.23')
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = JSON.stringify(body.blocks)
    expect(text).toContain('ACRO_GATEWAY')
    expect(text).toContain('12 failures')
    expect(body.channel).toBe('#alerts')
  })

  it('honors a channel override', async () => {
    await sendFailureSpikeAlert(makeSupabase(slackConnection) as never, 'org-1', '#outages', spikePayload, 'https://app.example.com')
    expect((await slackPostOf(fetchMock.mock.calls[0])).channel).toBe('#outages')
  })
})

describe('sendUpstreamOutageAlert (#331)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '9.99' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const outagePayload = {
    cause_key: 'salesforce',
    cause_label: 'Salesforce',
    failure_count: 23,
    window_minutes: 5,
    workflow_names: ['Engine Bidding', 'Main Flow'],
    timestamp: '2024-01-15T18:00:00.000Z',
  }

  it('no-ops when Slack is not connected', async () => {
    const ts = await sendUpstreamOutageAlert(makeSupabase(null) as never, 'org-1', outagePayload, 'https://app.example.com')
    expect(ts).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('@here-mentions the channel, names the cause + count, and uses no emoji', async () => {
    const ts = await sendUpstreamOutageAlert(makeSupabase(slackConnection) as never, 'org-1', outagePayload, 'https://app.example.com')
    expect(ts).toBe('9.99')
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = JSON.stringify(body.blocks)
    expect(text).toContain('<!here>')
    expect(text).toContain('with errors matching *Salesforce*')
    expect(text).toContain('23 leads')
    expect(text).toContain('Engine Bidding')
    // Every header block must opt out of emoji rendering.
    for (const block of body.blocks) {
      if (block.type === 'header') expect(block.text.emoji).toBe(false)
    }
    // No literal emoji characters in the payload.
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false)
    expect(body.channel).toBe('#alerts')
  })

  // #834: the cause label alone cannot tell a vendor outage from our own call
  // pattern hitting their concurrency governor, and on 2026-08-17 it sent the
  // reader to the Salesforce status page for 31 runs the governor had rejected.
  it('shows the specific errors and the advice derived from them', async () => {
    await sendUpstreamOutageAlert(
      makeSupabase(slackConnection) as never,
      'org-1',
      {
        ...outagePayload,
        error_shapes: [
          { sample: 'Salesforce API error (403): ConcurrentPerOrgLongTxn Limit exceeded.', count: 21 },
          { sample: 'Salesforce API error (503): Service Unavailable', count: 2 },
        ],
        other_shape_count: 2,
        how_to_check: 'The dominant error is a limit or governor rejection. Check concurrent in-flight calls first.',
      },
      'https://app.example.com',
    )

    const text = JSON.stringify((await slackPostOf(fetchMock.mock.calls[0])).blocks)
    expect(text).toContain('ConcurrentPerOrgLongTxn')
    expect(text).toContain('21 x')
    // The remainder is counted, so the top shape does not read as the whole story.
    expect(text).toContain('2 other error shapes')
    expect(text).toContain('Check concurrent in-flight calls')
    // And it no longer steers towards the vendor status page for this case.
    expect(text).not.toContain('status page')
  })

  it('cuts an address in an error sample at its query string (L741, #1740)', async () => {
    await sendUpstreamOutageAlert(
      makeSupabase(slackConnection) as never,
      'org-1',
      { ...outagePayload, error_shapes: [{ sample: 'Fetch API cannot load: https://p.example/x?phone=%28201%29555', count: 4 }] },
      'https://app.example.com',
    )
    const text = JSON.stringify((await slackPostOf(fetchMock.mock.calls[0])).blocks)
    expect(text).not.toMatch(/%28201%29|phone=/)
    expect(text).toContain('https://p.example/x')
  })

  // The failure path the issue asks for by name. Losing the page is worse than
  // sending it with only the cause label, so a payload with nothing to show must
  // still send, and must assert no cause it cannot support (L36).
  it('still sends, with neutral advice, when no error detail was captured', async () => {
    const ts = await sendUpstreamOutageAlert(
      makeSupabase(slackConnection) as never,
      'org-1',
      outagePayload,
      'https://app.example.com',
    )

    expect(ts).toBe('9.99')
    const text = JSON.stringify((await slackPostOf(fetchMock.mock.calls[0])).blocks)
    expect(text).toContain('with errors matching *Salesforce*')
    expect(text).toContain('review the affected runs')
    expect(text).not.toContain('status page')
    expect(text).not.toContain('What they failed on')
  })

  it('keeps a long sample inside the Slack section cap', async () => {
    await sendUpstreamOutageAlert(
      makeSupabase(slackConnection) as never,
      'org-1',
      {
        ...outagePayload,
        error_shapes: Array.from({ length: 3 }, (_, i) => ({ sample: `${'x'.repeat(220)}${i}`, count: 5 })),
        other_shape_count: 0,
        how_to_check: 'Review the affected runs.',
      },
      'https://app.example.com',
    )

    const blocks = (await slackPostOf(fetchMock.mock.calls[0])).blocks as { text?: { text?: string } }[]
    for (const b of blocks) {
      if (b.text?.text) expect(b.text.text.length).toBeLessThanOrEqual(3000)
    }
  })
})

describe('sendRequiredSecretsAlert', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1700000000.0001' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does nothing when Slack is not configured', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await sendRequiredSecretsAlert(makeSupabase(null) as any, 'org-1', ['SSN_HASH_PEPPER'])
    expect(sent).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not alert when config alerts are disabled', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = { ...slackConnection, config_alerts_enabled: false } as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await sendRequiredSecretsAlert(makeSupabase(conn) as any, 'org-1', ['SSN_HASH_PEPPER'])
    expect(sent).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts an actionable alert naming each missing secret and its fix command', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await sendRequiredSecretsAlert(makeSupabase(slackConnection) as any, 'org-1', ['SSN_HASH_PEPPER', 'SNOWFLAKE_USER'])
    expect(sent).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = JSON.stringify(body.blocks)
    expect(text).toContain('SSN_HASH_PEPPER')
    expect(text).toContain('SNOWFLAKE_USER')
    expect(text).toContain('How to fix:')
    expect(text).toContain('wrangler secret put SSN_HASH_PEPPER --name bidspoke-worker')
    // fallback text names the secrets so a collapsed notification is still useful
    expect(body.text).toContain('SSN_HASH_PEPPER')
    // no em dash / smart quotes / emoji in alert copy (project copy rules)
    expect(text).not.toContain('—')
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false)
  })
})

describe('sendRequiredEnvVarsAlert (#394)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1700000000.0001' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does nothing when Slack is not configured', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await sendRequiredEnvVarsAlert(makeSupabase(null) as any, 'org-1', ['SALESFORCE_CLIENT_ID'])
    expect(sent).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not alert when config alerts are disabled', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = { ...slackConnection, config_alerts_enabled: false } as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await sendRequiredEnvVarsAlert(makeSupabase(conn) as any, 'org-1', ['SALESFORCE_CLIENT_ID'])
    expect(sent).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts an actionable alert naming each missing key with a link to the env page', async () => {
    const sent = await sendRequiredEnvVarsAlert(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase(slackConnection) as any,
      'org-1',
      ['SALESFORCE_INSTANCE_URL', 'EQUIFAX_USERNAME'],
      'https://app.test',
    )
    expect(sent).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = JSON.stringify(body.blocks)
    expect(text).toContain('SALESFORCE_INSTANCE_URL')
    expect(text).toContain('EQUIFAX_USERNAME')
    expect(text).toContain('How to fix:')
    // link points at the Bidspoke Environment Variables page, not wrangler
    expect(text).toContain('https://app.test/env')
    expect(text).not.toContain('wrangler')
    // fallback text names the keys so a collapsed notification is still useful
    expect(body.text).toContain('SALESFORCE_INSTANCE_URL')
    // no em dash / smart quotes / emoji in alert copy (project copy rules)
    expect(text).not.toContain('—')
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false)
  })

  it('omits the link cleanly when no app URL is supplied', async () => {
    const sent = await sendRequiredEnvVarsAlert(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase(slackConnection) as any,
      'org-1',
      ['SALESFORCE_CLIENT_ID'],
    )
    expect(sent).toBe(true)
    const body = (await slackPostOf(fetchMock.mock.calls[0]))
    const text = JSON.stringify(body.blocks)
    expect(text).not.toContain('/env')
  })
})

describe('the scheduled job all-clears (#851)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.23' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const connected = () => {
    const chain: unknown = new Proxy({}, {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'limit') return alertRowsAnswer(() => Promise.resolve({ data: { config: { bot_token: 'xoxb-t', default_channel: '#alerts' } }, error: null }))
        return () => chain
      },
    })
    return { from: () => chain } as never
  }
  const sent = async () => (await slackPostOf(fetchMock.mock.calls[0]))
  const ALERTED = '2026-08-15T01:32:00.000Z'
  const ENDED = '2026-08-15T03:04:00.000Z'
  const NOW = Date.parse('2026-08-15T03:34:00.000Z')

  it('names the database job by its plain name and how long it was unhealthy', async () => {
    expect(await sendPgCronRecoveryAlert(connected(), 'org-1', { jobname: 'refresh-field-presence-daily', alertedAt: ALERTED, endedAt: ENDED }, NOW)).toBe(true)
    const body = (await sent())
    expect(body.channel).toBe('#alerts')
    const text = JSON.stringify(body.blocks)
    expect(text).toContain('refresh-field-presence-daily')
    expect(text).toContain('is running and succeeding again')
    expect(text).toContain('lasted 1 hour 32 minutes')
  })

  it('names the scheduled workflow by its label', async () => {
    expect(await sendWorkflowScheduleRecoveryAlert(connected(), 'org-1', { label: 'Nightly backup', alertedAt: ALERTED, endedAt: ENDED }, NOW)).toBe(true)
    const text = JSON.stringify((await sent()).blocks)
    expect(text).toContain('Nightly backup')
    expect(text).toContain('is running on schedule again')
  })
})

describe('sendRecoveryAlert (#253, #814)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.23' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const slack = { bot_token: 'xoxb-test-token' }
  // The real Aug 14 incident: paged 9:32 PM EDT, last failure 11:04 PM EDT.
  const ALERTED = '2026-08-15T01:32:00.000Z'
  const ENDED = '2026-08-15T03:04:00.000Z'
  const base = { signal: '"ACRO_GATEWAY" failure rate', subject: 'Engine Bidding Workflow', alertedAt: ALERTED }
  const sentText = async () => JSON.stringify((await slackPostOf(fetchMock.mock.calls[0])).blocks)

  it('measures the duration to the LAST FAILURE, not to the announcement', async () => {
    // Announced 30 minutes after it cleared. The outage lasted 1h 32m, and the
    // reader must not be told 2 hours because we waited to be sure.
    await sendRecoveryAlert(slack, '#alerts', { ...base, endedAt: ENDED }, Date.parse('2026-08-15T03:34:00.000Z'))
    expect((await sentText())).toContain('lasted 1 hour 32 minutes')
  })

  it('names when it cleared, since the all-clear arrives after a re-arm delay', async () => {
    await sendRecoveryAlert(slack, '#alerts', { ...base, endedAt: ENDED }, Date.parse('2026-08-15T03:34:00.000Z'))
    expect((await sentText())).toContain('11:04 PM EDT')
  })

  it('falls back to the announcement time when no end was recorded', async () => {
    await sendRecoveryAlert(slack, '#alerts', { ...base, endedAt: null }, Date.parse('2026-08-15T02:32:00.000Z'))
    const text = (await sentText())
    expect(text).toContain('lasted 1 hour')
    expect(text).not.toContain('clearing at')
  })

  it('says nothing about the duration when the marker is unparseable', async () => {
    await sendRecoveryAlert(slack, '#alerts', { ...base, alertedAt: 'garbage', endedAt: null })
    const text = (await sentText())
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('lasted')
  })

  it('reads an end recorded before the start as a zero length span, never a negative one (#2101)', async () => {
    // The real db-unreachable row recorded before #2115: its last sighting was
    // read 36 seconds before its start. The one span rule reads it as zero.
    await sendRecoveryAlert(
      slack,
      '#alerts',
      { ...base, alertedAt: '2026-10-14T21:48:37.000Z', endedAt: '2026-10-14T21:48:01.000Z' },
      Date.parse('2026-10-14T22:20:00.000Z'),
    )
    const text = (await sentText())
    expect(text).toContain('lasted under a minute, clearing at Oct 14, 5:48 PM EDT')
    expect(text).not.toContain('-')
  })
})

/**
 * #1101. A detector that judges a trailing window observes an incident once per
 * tick, so the gap between the first and last alerting tick is not the length of
 * the incident. On an hourly check a one-tick incident has a zero gap, and the
 * notice would report "under a minute" for the real thirty minute outage of
 * 2026-09-02 (168 of 261 Main Flow runs, 12:20 to 12:50 UTC).
 *
 * That is the same defect in the other direction from the one the issue was
 * filed about, where the day-to-date rule reported "lasted 1 hour". A duration
 * nobody measured must not be asserted either way (L11).
 */
describe('sendRecoveryAlert on a windowed check', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.23' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const slack = { bot_token: 'xoxb-test-token' }
  const textOf = async () => JSON.stringify((await slackPostOf(fetchMock.mock.calls[0])).blocks)

  it('reports the measured window, not a zero gap, for a single-tick incident', async () => {
    await sendRecoveryAlert(
      slack,
      'C1',
      {
        signal: 'output field stopped',
        subject: 'Main Flow trades_request.body.pennieLeadCalculations',
        alertedAt: '2026-09-02T13:00:00Z',
        endedAt: '2026-09-02T13:00:00Z',
        measuredWindowMinutes: 60,
      },
      Date.parse('2026-09-02T15:00:00Z'),
    )
    const text = (await textOf())
    expect(text).not.toMatch(/under a minute/)
    expect(text).toMatch(/hour/)
  })

  // #1268. The 2026-09-10 LendSwift outage: the ping API failed from 5:36 to
  // 6:52 AM EDT, the only failing tick was 6:01, and the notice said the field
  // was "clearing at 6:01 AM EDT", the very moment the alert fired, while the
  // failures ran another 51 minutes. A single-tick incident has NO observed end:
  // the check knows the field was still missing at the alert tick and back at
  // the next one, and must say exactly that (L11, L440).
  it('names the tick it was still missing on and the tick it was back on, never a clearing time, for a single-tick incident', async () => {
    await sendRecoveryAlert(
      slack,
      'C1',
      {
        signal: 'output field stopped',
        subject: 'RML - Bidding Workflow (LendSwift) ping_lendswift.data.data',
        alertedAt: '2026-09-10T10:01:15Z',
        endedAt: '2026-09-10T10:01:15Z',
        measuredWindowMinutes: 60,
      },
      Date.parse('2026-09-10T11:00:05Z'),
    )
    const text = (await textOf())
    expect(text).not.toContain('clearing at')
    expect(text).toContain('6:01 AM EDT')
    expect(text).toContain('7:00 AM EDT')
  })

  // The control. A genuinely long incident was OBSERVED failing at both ends, so
  // its span is a real measurement and must still be reported.
  it('still reports a span longer than one window as a duration', async () => {
    await sendRecoveryAlert(
      slack,
      'C1',
      {
        signal: 'output field stopped',
        subject: 'Main Flow some.field',
        alertedAt: '2026-09-02T05:00:00Z',
        endedAt: '2026-09-02T11:00:00Z',
        measuredWindowMinutes: 60,
      },
      Date.parse('2026-09-02T12:00:00Z'),
    )
    expect((await textOf())).toMatch(/6 hours/)
  })

  // The other checks pass no window and must be untouched by this.
  it('leaves a check that declares no window reporting its span as before', async () => {
    await sendRecoveryAlert(
      slack,
      'C1',
      {
        signal: 'failure spike',
        subject: 'Main Flow',
        alertedAt: '2026-09-02T13:00:00Z',
        endedAt: '2026-09-02T13:20:00Z',
      },
      Date.parse('2026-09-02T14:00:00Z'),
    )
    expect((await textOf())).toMatch(/20 minutes/)
  })
})

/**
 * #1267. The field presence alert is one message per channel (#1120), but its
 * all-clear was still one message per field, so the 2026-09-10 LendSwift outage
 * produced one page and four Recovered messages saying the same sentence with
 * a different field name each time.
 */
describe('sendGroupedRecoveryAlert', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.23' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const slack = { bot_token: 'xoxb-test-token' }
  const items = [
    {
      subject: 'RML - Bidding Workflow (LendSwift) ping_lendswift.data.data',
      alertedAt: '2026-09-10T10:01:15Z',
      endedAt: '2026-09-10T10:01:15Z',
      url: 'https://app/workflows/wf-1',
    },
    {
      subject: 'RML - Bidding Workflow (LendSwift) ping_lendswift.data.data.status',
      alertedAt: '2026-09-10T10:01:15Z',
      endedAt: '2026-09-10T10:01:15Z',
      url: 'https://app/workflows/wf-1',
    },
  ]

  it('posts ONE message naming every recovered subject', async () => {
    const ok = await sendGroupedRecoveryAlert(
      slack,
      'C1',
      { signal: 'output field stopped', measuredWindowMinutes: 60, items },
      Date.parse('2026-09-10T11:00:05Z'),
    )
    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const text = JSON.stringify((await slackPostOf(fetchMock.mock.calls[0])).blocks)
    expect(text).toContain('ping_lendswift.data.data.status')
    expect(text).toContain('ping_lendswift.data.data*')
    // One header, not one per field.
    expect(text.match(/"Recovered"/g)?.length).toBe(1)
  })

  // #1270: when every subject paged and recovered on the same tick, the timing
  // sentence is identical on every line, so the two facts that differ (which
  // fields) are buried in the repetition (L605). Say the timing once.
  it('says the shared timing once when every subject recovered on the same tick (#1270)', async () => {
    await sendGroupedRecoveryAlert(
      slack,
      'C1',
      { signal: 'output field stopped', measuredWindowMinutes: 60, items },
      Date.parse('2026-09-10T11:00:05Z'),
    )
    const section = (await slackPostOf(fetchMock.mock.calls[0])).blocks[1].text.text as string
    // Both subjects still named.
    expect(section).toContain('ping_lendswift.data.data*')
    expect(section).toContain('ping_lendswift.data.data.status*')
    // The timing clause appears exactly once, not once per subject.
    expect(section.match(/alert fired at/g)?.length).toBe(1)
  })

  // The collapse must NOT hide a genuine difference: subjects that recovered at
  // different ticks keep their own timing sentence.
  it('keeps a per-subject sentence when the subjects recovered at different ticks (#1270)', async () => {
    const mixed = [
      items[0],
      { ...items[1], alertedAt: '2026-09-10T09:00:00Z', endedAt: '2026-09-10T09:00:00Z' },
    ]
    await sendGroupedRecoveryAlert(
      slack,
      'C1',
      { signal: 'output field stopped', measuredWindowMinutes: 60, items: mixed },
      Date.parse('2026-09-10T11:00:05Z'),
    )
    const section = (await slackPostOf(fetchMock.mock.calls[0])).blocks[1].text.text as string
    expect(section.match(/alert fired at/g)?.length).toBe(2)
  })

  // The line cap was sized for the page's 120 character lines (L81: size a
  // batch in the unit the limit is expressed in). An all-clear line is nearly
  // three times longer, so twenty of them would be refused by Slack, never
  // settle, and be rebuilt identically on every tick.
  it('keeps the section under Slack\'s 3,000 character block limit however many subjects recovered', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...items[0],
      subject: `RML - Bidding Workflow (LendSwift) ping_lendswift.data.data.field_${i}`,
      url: 'https://bidspoke.trypennie.dev/workflows/e1b810da-16c0-49eb-bf12-ba1c9b67c914',
    }))
    await sendGroupedRecoveryAlert(
      slack,
      'C1',
      { signal: 'output field stopped', measuredWindowMinutes: 60, items: many },
      Date.parse('2026-09-10T11:00:05Z'),
    )
    const section = (await slackPostOf(fetchMock.mock.calls[0])).blocks[1].text.text as string
    expect(section.length).toBeLessThanOrEqual(3000)
    expect(section).toMatch(/and \d+ more/)
  })

  it('reports a delivery failure so the caller keeps every incident open', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: false, error: 'channel_not_found' }) })
    const ok = await sendGroupedRecoveryAlert(
      slack,
      'C1',
      { signal: 'output field stopped', measuredWindowMinutes: 60, items },
      Date.parse('2026-09-10T11:00:05Z'),
    )
    expect(ok).toBe(false)
  })
})

/**
 * The saturation alert's own message (#1100). Dan's call on 2026-09-02: it says
 * something serious but it is not worth interrupting the whole channel for,
 * measured at roughly three firings in five days.
 */
describe('sendFailureSaturationAlert', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.23' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const payload = {
    workflow_id: 'wf-1',
    workflow_name: 'Main Flow',
    failure_count: 17,
    total_count: 19,
    window_minutes: 5,
    error_shapes: [{ sample: 'Salesforce API error (500): boom', count: 17 }],
    other_shape_count: 0,
    timestamp: '2026-09-02T12:23:00Z',
  }
  const sentText = async () => JSON.stringify((await slackPostOf(fetchMock.mock.calls[0])).blocks)

  it('does not ping the channel', async () => {
    await sendFailureSaturationAlert(makeSupabase(slackConnection) as never, 'org-1', payload, 'https://app.example.com')
    expect((await sentText())).not.toContain('!here')
  })

  it('cuts an address in an error sample at its query string (L741, #1740)', async () => {
    const leaky = { ...payload, error_shapes: [{ sample: 'Fetch API cannot load: https://p.example/x?email=jo%40example.com', count: 17 }] }
    await sendFailureSaturationAlert(makeSupabase(slackConnection) as never, 'org-1', leaky, 'https://app.example.com')
    const text = (await sentText())
    expect(text).not.toMatch(/%40|email=/)
    expect(text).toContain('https://p.example/x')
  })

  // Not just an absence: the message still has to carry what it measured, or a
  // builder that produced nothing at all would satisfy the assertion above.
  it('states how many runs failed out of how many, and over what window', async () => {
    await sendFailureSaturationAlert(makeSupabase(slackConnection) as never, 'org-1', payload, 'https://app.example.com')
    const text = (await sentText())
    expect(text).toContain('Main Flow')
    expect(text).toContain('17 of the 19 runs')
    expect(text).toContain('5 minutes')
    expect(text).toContain('Salesforce API error (500)')
  })

  // It must claim no cause, which is the whole reason this alert is separate
  // from the cause-keyed one.
  it('says explicitly that it has not identified a cause', async () => {
    await sendFailureSaturationAlert(makeSupabase(slackConnection) as never, 'org-1', payload, 'https://app.example.com')
    expect((await sentText())).toMatch(/not identified a cause|not why/i)
  })

  // The positive control (L159). The sibling alert in the same file DOES ping
  // the channel, so an assertion that this one does not would be satisfied by a
  // change that broke channel pings everywhere.
  it('while the shared-upstream alert next to it still does ping the channel', async () => {
    await sendUpstreamOutageAlert(
      makeSupabase(slackConnection) as never,
      'org-1',
      {
        cause_key: 'salesforce',
        cause_label: 'Salesforce',
        failure_count: 12,
        window_minutes: 1,
        workflow_names: ['Main Flow'],
        timestamp: '2026-09-02T12:38:00Z',
      },
      'https://app.example.com',
    )
    expect((await sentText())).toContain('!here')
  })
})
