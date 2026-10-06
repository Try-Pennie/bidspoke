/**
 * The alert summarizer sends each step's error text to Anthropic, an outside
 * service, so an address inside it loses its query string first (L741, #1740).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { draftAlertSummary } from '../alert-summarizer'

afterEach(() => vi.unstubAllGlobals())

describe('draftAlertSummary', () => {
  it('sends no query string from any address in the step errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'The step failed.' }] }) })
    vi.stubGlobal('fetch', fetchMock)
    const step = { step_namespace: 'call_partner', step_type: 'code', duration_ms: 900, status: 'failed' as const, error_message: 'Fetch API cannot load: https://p.example/x?email=jo%40example.com', error_type: 'transient' as const }
    const out = await draftAlertSummary('key', { alert_type: 'failure', workflow_name: 'Main Flow', total_duration_ms: 900, bottleneck: step, top_steps: [step] })
    expect(out).toBe('The step failed.')
    const sent = fetchMock.mock.calls[0][1].body as string
    expect(sent).not.toMatch(/%40|email=/)
    expect(sent).toContain('https://p.example/x')
  })
})
