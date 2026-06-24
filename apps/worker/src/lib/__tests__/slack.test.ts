/**
 * Slack alert lib — PRD Section 1.7
 * Verifies: blocks structure, unfurl_links: false, ET timezone (DST-aware),
 * markdown link (not interactive button), channel override, no-op when unconfigured.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendFailureAlert, sendDurationAlert, postMessage, sendSlowSpikeAlert, sendSecretDriftAlert, sendBackupFailureAlert, sendFailureSpikeAlert, sendUpstreamOutageAlert, sendOutcomeDeadLetterAlert } from '../slack'
import type { FailureAlertPayload, SlowSpikeAlertPayload, SlackConnection } from '../slack'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSupabase(connection: Record<string, string> | null) {
  const chain: unknown = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'maybeSingle') return () =>
        connection
          ? Promise.resolve({ data: { config: connection }, error: null })
          : Promise.resolve({ data: null, error: null })
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
      json: async () => ({ ok: true }),
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does nothing when Slack is not configured', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(null) as any, 'org-1', null, payload, 'https://app.example.com')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the channel override when provided', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', '#custom-channel', payload, 'https://app.example.com')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.channel).toBe('#custom-channel')
  })

  it('falls back to default_channel when no override', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.channel).toBe('#alerts')
  })

  it('sends unfurl_links: false', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.unfurl_links).toBe(false)
  })

  it('includes a header block', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const { blocks } = JSON.parse(fetchMock.mock.calls[0][1].body)
    const header = blocks.find((b: { type: string }) => b.type === 'header')
    expect(header).toBeDefined()
    expect(header.text.text).toContain('Failed')
  })

  it('includes workflow name and step namespace in a section block', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const { blocks } = JSON.parse(fetchMock.mock.calls[0][1].body)
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
    const { blocks } = JSON.parse(fetchMock.mock.calls[0][1].body)
    const allText = blocks.flatMap((b: { text?: { text: string } }) => [b.text?.text ?? '']).join('\n')
    expect(allText).toContain('Connection refused')
    expect(allText).toContain('```')
  })

  it('sends a long error message whole when it fits under the Slack block limit', async () => {
    const longBody = 'Code returned error response: HTTP 500 — ' + 'x'.repeat(2000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, { ...payload, error_message: longBody }, 'https://app.example.com')
    const { blocks } = JSON.parse(fetchMock.mock.calls[0][1].body)
    const errBlock = blocks.map((b: { text?: { text: string } }) => b.text?.text ?? '').find((t: string) => t.includes('Code returned error response'))
    expect(errBlock).toContain('x'.repeat(2000))
    expect(errBlock).not.toContain('truncated')
  })

  it('caps an error message that would exceed the Slack 3000-char block limit, pointing to the execution detail', async () => {
    const hugeBody = 'Code returned error response: HTTP 500 — ' + 'x'.repeat(5000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, { ...payload, error_message: hugeBody }, 'https://app.example.com')
    const { blocks } = JSON.parse(fetchMock.mock.calls[0][1].body)
    const errBlock = blocks.map((b: { text?: { text: string } }) => b.text?.text ?? '').find((t: string) => t.includes('Code returned error response'))
    // Stays under Slack's hard per-block cap so the POST isn't rejected.
    expect(errBlock.length).toBeLessThanOrEqual(3000)
    expect(errBlock).toContain('full error in execution detail')
  })

  it('includes a markdown "View execution →" link (not an interactive button)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const { blocks } = JSON.parse(fetchMock.mock.calls[0][1].body)
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
    const { blocks } = JSON.parse(fetchMock.mock.calls[0][1].body)
    const allText = blocks.map((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(allText).toContain('wf-1')
    expect(allText).toContain('exec-abc')
  })

  it('appends node= to the execution URL when the failed step has a node id', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, { ...payload, node_id: 'node-xyz' }, 'https://app.example.com')
    const { blocks } = JSON.parse(fetchMock.mock.calls[0][1].body)
    const allText = blocks.map((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(allText).toContain('node=node-xyz')
    // Still carries the execution param so the overlay opens too.
    expect(allText).toContain('execution=exec-abc')
  })

  it('omits the node param when the failed step has no node id', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const { blocks } = JSON.parse(fetchMock.mock.calls[0][1].body)
    const allText = blocks.map((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(allText).not.toContain('node=')
  })

  it('formats the timestamp in ET (EST, non-DST)', async () => {
    // 2024-01-15T18:00:00Z = 1:00 PM EST (UTC-5)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const { blocks } = JSON.parse(fetchMock.mock.calls[0][1].body)
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
    const { blocks } = JSON.parse(fetchMock.mock.calls[0][1].body)
    const allText = blocks.flatMap((b: { fields?: { text: string }[] }) =>
      (b.fields ?? []).map((f) => f.text)
    ).join('\n')
    expect(allText).toMatch(/EDT/)
    expect(allText).toMatch(/2:00/)
  })

  it('uses the Authorization: Bearer bot_token header', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const { headers } = fetchMock.mock.calls[0][1]
    expect(headers['Authorization']).toBe('Bearer xoxb-test-token')
  })

  it('shows the retry count when the step retried before failing', async () => {
    const retried = { ...payload, retries_used: 2 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, retried, 'https://app.example.com')
    const { blocks } = JSON.parse(fetchMock.mock.calls[0][1].body)
    const allText = blocks.flatMap((b: { fields?: { text: string }[] }) =>
      (b.fields ?? []).map((f) => f.text)
    ).join('\n')
    expect(allText).toContain('retried 2 times before failing')
  })

  it('singularizes the retry count for a single retry', async () => {
    const retried = { ...payload, retries_used: 1 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, retried, 'https://app.example.com')
    const { blocks } = JSON.parse(fetchMock.mock.calls[0][1].body)
    const allText = blocks.flatMap((b: { fields?: { text: string }[] }) =>
      (b.fields ?? []).map((f) => f.text)
    ).join('\n')
    expect(allText).toContain('retried 1 time before failing')
  })

  it('says no retry when the step failed on its first attempt', async () => {
    // payload has no retries_used → treated as 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendFailureAlert(makeSupabase(slackConnection) as any, 'org-1', null, payload, 'https://app.example.com')
    const { blocks } = JSON.parse(fetchMock.mock.calls[0][1].body)
    const allText = blocks.flatMap((b: { fields?: { text: string }[] }) =>
      (b.fields ?? []).map((f) => f.text)
    ).join('\n')
    expect(allText).toContain('failed on first attempt (no retry)')
  })
})

describe('sendDurationAlert', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
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
    const { blocks } = JSON.parse(fetchMock.mock.calls[0][1].body)
    const allText = blocks.map((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(allText).toContain('node=node-slow')
    expect(allText).toContain('execution=exec-abc')
  })

  it('omits the node param when no bottleneck node id is present', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendDurationAlert(makeSupabase(slackConnection) as any, 'org-1', null, durationPayload, 'https://app.example.com')
    const { blocks } = JSON.parse(fetchMock.mock.calls[0][1].body)
    const allText = blocks.map((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(allText).not.toContain('node=')
  })
})

// Issue #82: Slack returns HTTP 200 with { ok: false } for channel_not_found /
// not_in_channel / invalid_auth. postMessage (and the senders/cooldowns that
// gate on its result) must treat that as a failure, not a silent success.
describe('postMessage — ok:false detection', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
  afterEach(() => vi.unstubAllGlobals())

  it('returns the ts on a delivered message', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: '171.99' }) })
    expect(await postMessage('tok', '#c', [], 'hi')).toBe('171.99')
  })

  it('returns null on an HTTP-200 ok:false (e.g. channel_not_found)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: 'channel_not_found' }) })
    expect(await postMessage('tok', '#c', [], 'hi')).toBeNull()
  })

  it('returns null on an HTTP error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    expect(await postMessage('tok', '#c', [], 'hi')).toBeNull()
  })
})

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
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: 'not_in_channel' }) })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await sendSlowSpikeAlert(makeSupabase(slackConnection) as any, 'org-1', null, spikePayload, 'https://app')
    expect(sent).toBeNull()
  })

  it('returns the ts when delivered', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: '200.1' }) })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await sendSlowSpikeAlert(makeSupabase(slackConnection) as any, 'org-1', null, spikePayload, 'https://app')
    expect(sent).toBe('200.1')
  })
})

describe('sendSecretDriftAlert (#199)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: '1.23' }) })
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
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.channel).toBe('#alerts')
    expect(body.unfurl_links).toBe(false)
    const text = body.blocks.flatMap((b: { fields?: { text: string }[]; text?: { text: string } }) => [
      ...(b.fields ?? []).map((f) => f.text), b.text?.text ?? '',
    ]).join('\n')
    expect(text).toContain('Secret Out of Sync')
    expect(text).toContain('STRIPE_KEY')
    expect(text).toContain('WF_TOKEN')
    expect(text).toContain('missing from Cloudflare')
  })

  it('does nothing and reports not-sent when there are no missing secrets', async () => {
    expect(await sendSecretDriftAlert(conn, [], 'https://app.test')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('sendBackupFailureAlert (#206)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: '1.23' }) })
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
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
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
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const text = body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).toContain('…')
    expect(text).not.toContain('e'.repeat(400))
  })
})

describe('sendOutcomeDeadLetterAlert (#309)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: '1.23' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const conn = { bot_token: 'xoxb-test-token', default_channel: '#alerts' } as unknown as SlackConnection

  it('names the lost op, the failure count, the error, and how to fix it', async () => {
    const sent = await sendOutcomeDeadLetterAlert(
      conn,
      { label: 'lead_sightings.finalize', consecutive_failures: 1, error_message: 'PGRST002 schema cache' },
      'https://app.test',
    )
    expect(sent).toBe(true)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.channel).toBe('#alerts')
    expect(body.unfurl_links).toBe(false)
    const text = body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '').join('\n')
    expect(text).toContain('Outcome Record Lost')
    expect(text).toContain('lead_sightings.finalize')
    expect(text).toContain('PGRST002 schema cache')
    expect(text).toContain('How to fix:')
  })
})

describe('sendFailureSpikeAlert (#248)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: '1.23' }) })
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
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const text = JSON.stringify(body.blocks)
    expect(text).toContain('ACRO_GATEWAY')
    expect(text).toContain('12 failures')
    expect(body.channel).toBe('#alerts')
  })

  it('honors a channel override', async () => {
    await sendFailureSpikeAlert(makeSupabase(slackConnection) as never, 'org-1', '#outages', spikePayload, 'https://app.example.com')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).channel).toBe('#outages')
  })
})

describe('sendUpstreamOutageAlert (#331)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: '9.99' }) })
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
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const text = JSON.stringify(body.blocks)
    expect(text).toContain('<!here>')
    expect(text).toContain('Salesforce appears degraded')
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
})
