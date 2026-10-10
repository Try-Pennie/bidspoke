/**
 * The #693 burst throttle is actually wired into fireExecutionAlert: a signature
 * whose window is already open skips the Slack send, the window is opened only
 * after a send that actually produced a page, a collapsed run is not recorded as
 * having fired an alert, and a duration alert is never throttled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  sendFailureAlert: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ ts: '1.23' })),
  sendDurationAlert: vi.fn(async () => ({ ts: '1.23' })),
  sendThreadReply: vi.fn(async () => undefined),
}))

vi.mock('../slack', () => ({
  sendFailureAlert: h.sendFailureAlert,
  sendDurationAlert: h.sendDurationAlert,
  sendThreadReply: h.sendThreadReply,
}))
// Keep the Claude summary path inert so the test exercises only the send gate.
vi.mock('../changelog-drafter', () => ({ getAnthropicKey: vi.fn(async () => null) }))

import { fireExecutionAlert, type ExecutionAlertArgs } from '../execution-alerts'

// update(patch).eq().eq().select('id') resolving to one matched row, capturing
// every patch written so a test can assert what the snapshot recorded.
const patches: Record<string, unknown>[] = []
const supabase = {
  from: () => ({
    update: (patch: Record<string, unknown>) => {
      patches.push(patch)
      return { eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [{ id: 'x' }], error: null }) }) }) }
    },
  }),
} as never

// A Map-backed IDEMPOTENCY KV double with spies.
function kvDouble(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => {
      store.set(k, v)
    }),
  }
}

let kv: ReturnType<typeof kvDouble>

const baseArgs = (over: Partial<ExecutionAlertArgs>): ExecutionAlertArgs => ({
  alertType: 'failure',
  supabase,
  env: { IDEMPOTENCY: kv, APP_URL: 'https://app.test' } as never,
  executionCtx: { waitUntil: vi.fn() },
  orgId: 'org-1',
  slackChannel: null,
  workflowId: 'wf-1',
  workflowName: 'Engine Bidding',
  executionId: 'exec-1',
  executionStartedAt: '2026-07-21T00:00:00Z',
  durationMs: 100,
  failedStep: 'ping_lendswift',
  errorMessage: 'Code returned error response (500)',
  errorType: 'permanent',
  timestamp: '2026-07-21T00:00:01Z',
  stepLogQueue: [],
  ...over,
})

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  patches.length = 0
  kv = kvDouble()
  h.sendFailureAlert.mockClear()
  h.sendDurationAlert.mockClear()
  h.sendFailureAlert.mockResolvedValue({ ts: '1.23' })
})
afterEach(() => vi.restoreAllMocks())

describe('fireExecutionAlert burst throttle (#693)', () => {
  it('sends the failure alert when the signature window is not open', async () => {
    await fireExecutionAlert(baseArgs({}))
    expect(h.sendFailureAlert).toHaveBeenCalledOnce()
  })

  it('opens the collapse window after a successful send', async () => {
    await fireExecutionAlert(baseArgs({}))
    expect([...kv.store.keys()].some((k) => k.startsWith('failure-alert-cooldown:'))).toBe(true)
  })

  it('does NOT send when the signature window is already open (burst collapsed)', async () => {
    await fireExecutionAlert(baseArgs({}))
    h.sendFailureAlert.mockClear()
    // Second failure of the same signature: window is now open.
    await fireExecutionAlert(baseArgs({}))
    expect(h.sendFailureAlert).not.toHaveBeenCalled()
  })

  it('does NOT open the window when the send produced no page (so the burst is not silenced)', async () => {
    h.sendFailureAlert.mockResolvedValue(null)
    await fireExecutionAlert(baseArgs({}))
    expect([...kv.store.keys()].some((k) => k.startsWith('failure-alert-cooldown:'))).toBe(false)
  })

  it('a collapsed run records the reason but not slack_alert_fired_at', async () => {
    await fireExecutionAlert(baseArgs({})) // first of the signature: sends and opens the window
    await fireExecutionAlert(baseArgs({})) // second of the same signature: collapsed
    const patch = patches[patches.length - 1] // the collapsed run's snapshot
    expect(patch.slack_alert_fired_at).toBeUndefined()
    expect((patch.slack_alert_reason as Record<string, unknown>).collapsed_into_burst).toBe(true)
  })

  it('a sent run records slack_alert_fired_at', async () => {
    await fireExecutionAlert(baseArgs({}))
    expect(patches[0].slack_alert_fired_at).toBeDefined()
  })

  it('fails open: if the cooldown read throws, the failure still pages', async () => {
    kv.get.mockRejectedValue(new Error('kv down'))
    await fireExecutionAlert(baseArgs({}))
    expect(h.sendFailureAlert).toHaveBeenCalledOnce()
  })

  it('never throttles a duration alert: it sends without reading the cooldown', async () => {
    await fireExecutionAlert(
      baseArgs({
        alertType: 'duration',
        thresholdMs: 50,
        failedStep: undefined,
        errorMessage: undefined,
        errorType: undefined,
        stepLogQueue: [
          { step_namespace: 'slow', step_type: 'code', duration_ms: 999, status: 'success' } as never,
        ],
      }),
    )
    expect(h.sendDurationAlert).toHaveBeenCalledOnce()
    expect(kv.get).not.toHaveBeenCalled()
  })
})
