import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendWorkflowDispatchAlert } from '../slack'
import type { DispatchAttempt } from '../workflow-dispatch-driver'

/**
 * The Slack message for the worker's workflow dispatch driver (#1058).
 *
 * This alert exists because of LESSONS L11. When the driver cannot dispatch, the
 * watch's own alert eventually fires and says the workflow "has stopped
 * running", pointing the reader at GitHub Actions to re-enable a workflow that
 * was never disabled. The real fault is on our side, hours earlier, and only the
 * driver knows it. So a refused dispatch says so in its own words rather than
 * waiting to be mistranslated.
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

const posts = () => vi.mocked(fetch).mock.calls.map((call) => String((call[1] as { body: string }).body))

const attempt = (file: string, outcome: DispatchAttempt['outcome'], reason: string): DispatchAttempt => ({
  file,
  outcome,
  reason,
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

describe('sendWorkflowDispatchAlert', () => {
  it('says nothing when every dispatch worked', async () => {
    const sent = await sendWorkflowDispatchAlert(makeSupabase(connection), 'org-1', [
      attempt('deploy-drift.yml', 'dispatched', 'overdue'),
      attempt('db-types-drift.yml', 'not_due', 'ran recently'),
    ])
    expect(sent).toBe(false)
    expect(posts().length).toBe(0)
  })

  it('names the workflow and carries the refusal reason verbatim', async () => {
    await sendWorkflowDispatchAlert(makeSupabase(connection), 'org-1', [
      attempt('deploy-drift.yml', 'failed', 'GitHub refused the dispatch of deploy-drift.yml with 403'),
    ])
    const text = posts().join('')
    expect(text).toContain('deploy-drift.yml')
    expect(text, 'the reason is the whole diagnosis and must not be summarised away').toContain('403')
  })

  it('reports two failures in a single post rather than one message each', async () => {
    // One shared cause (a token that cannot dispatch) fails every workflow at
    // once, and one message per registry entry makes the registry length decide
    // how loud one fact is (L36).
    await sendWorkflowDispatchAlert(makeSupabase(connection), 'org-1', [
      attempt('deploy-drift.yml', 'failed', 'GitHub refused the dispatch with 403'),
      attempt('db-types-drift.yml', 'failed', 'GitHub refused the dispatch with 403'),
    ])
    expect(posts().length).toBe(1)
    const text = posts()[0]
    expect(text).toContain('deploy-drift.yml')
    expect(text).toContain('db-types-drift.yml')
  })

  it('tells the reader the checks are NOT running, which is what the failure costs', async () => {
    // A dispatch failure is not interesting in itself. What matters is that the
    // safety checks it drives are not running, and the alert has to say so or the
    // reader cannot judge the urgency (L112).
    await sendWorkflowDispatchAlert(makeSupabase(connection), 'org-1', [
      attempt('deploy-drift.yml', 'failed', 'GitHub refused the dispatch with 403'),
    ])
    expect(posts()[0].toLowerCase()).toContain('not running')
  })

  it('reports an unconfigured driver differently from a refused dispatch', async () => {
    // Distinct causes get distinct messages (L11): a missing secret and a token
    // GitHub refused need different repairs.
    await sendWorkflowDispatchAlert(makeSupabase(connection), 'org-1', [
      attempt('deploy-drift.yml', 'unconfigured', 'GITHUB_CODE_REPO is not set'),
    ])
    expect(posts()[0]).toContain('GITHUB_CODE_REPO')
  })

  it('does not alert about a workflow whose last run merely could not be read', async () => {
    // `unknown` means nothing was measured. The schedule watch reports that
    // condition itself, and repeating it here would be two checks alerting on one
    // fact (L53).
    const sent = await sendWorkflowDispatchAlert(makeSupabase(connection), 'org-1', [
      attempt('deploy-drift.yml', 'unknown', 'the last run could not be read: GitHub returned 500'),
    ])
    expect(sent).toBe(false)
  })

  it('stays silent when the org has no Slack connection', async () => {
    const sent = await sendWorkflowDispatchAlert(makeSupabase(null), 'org-1', [
      attempt('deploy-drift.yml', 'failed', 'GitHub refused the dispatch with 403'),
    ])
    expect(sent).toBe(false)
    expect(posts().length).toBe(0)
  })
})
