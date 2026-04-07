/**
 * Slack alert lib — PRD Section 1.7
 * Verifies: blocks structure, unfurl_links: false, ET timezone (DST-aware),
 * markdown link (not interactive button), channel override, no-op when unconfigured.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendFailureAlert } from '../slack'
import type { FailureAlertPayload } from '../slack'

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
})
