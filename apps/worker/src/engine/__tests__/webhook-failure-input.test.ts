/**
 * A failed webhook step keeps the request it sent (#3057).
 *
 * The step record's `input` is the request a step resolved. A completed webhook
 * step records it from its result, and a non-2xx already carried it on the
 * thrown Response. A timeout and a dropped connection carried none: withTimeout's
 * own error wins the race against the executor's, and a fetch that throws never
 * reached the line that attached it. All 22 failed Main Flow relay posts in the
 * three days to 2026-10-29 were timeouts with a null input, so the run page
 * showed nothing they sent.
 *
 * This walks a real webhook step through the real walk (sequential and inside a
 * parallel block) and reads the step row it queues. The secret test is the one
 * that matters most: whatever the failure, the stored input holds the same
 * masked headers a completed step's does, so a credential never lands in it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { EdgeDefinition, NodeDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'
import { stubFetch, type FetchMock } from '../../__tests__/helpers/fetch-mock'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))

import { walkGraph } from '../index'
import { buildContext } from '../context'
import { stepTimeoutMessage, stepTimedOutAfterMs } from '../step-timeout'

const env = { PII_REDACTION_FIELDS: '' } as unknown as Env
const supabase = {} as SupabaseClient

// Plainly fake credentials. Each must never appear in a stored input.
const FAKE_BEARER = 'fake-bearer-token-1'
const FAKE_API_KEY = 'fake-api-key-1'
const FAKE_HEADER_AUTH = 'fake-header-auth-1'
const SECRETS = [FAKE_BEARER, FAKE_API_KEY, FAKE_HEADER_AUTH]

const RELAY_URL = 'https://relay.example.test/hook'

function relayPost(namespace: string, auth: Record<string, unknown> = { type: 'bearer', token: '{{env.RELAY_TOKEN}}' }): NodeDefinition {
  return {
    id: namespace,
    namespace,
    type: 'webhook',
    config: {
      url: RELAY_URL,
      method: 'POST',
      headers: { 'X-Lead-Source': 'website_form', Authorization: '{{env.RELAY_HEADER_AUTH}}' },
      body: { submission_id: '{{trigger.payload.submission_id}}', amount: 12000 },
      auth,
      retries: 0,
      timeout_ms: 3750,
    },
  }
}

function ctx() {
  const c = buildContext({ submission_id: 'sub-3057' }, 'website_form', 'wf-1', 'trace-3057', {
    RELAY_TOKEN: FAKE_BEARER,
    RELAY_KEY: FAKE_API_KEY,
    RELAY_HEADER_AUTH: FAKE_HEADER_AUTH,
  }, 'org-1', 'exec-3057')
  c.retrySleep = async () => {}
  return c
}

const edge = (source: string, target: string, source_handle?: string): EdgeDefinition => ({ id: `${source}-${target}`, source, target, ...(source_handle ? { source_handle } : {}) })

function sequential(node: NodeDefinition) {
  return { nodes: [node, { id: 'done', namespace: 'done', type: 'exit', config: {} } as NodeDefinition], edges: [edge(node.id, 'done')] }
}

function inParallel(node: NodeDefinition) {
  const nodes: NodeDefinition[] = [
    { id: 'fan', namespace: 'fan', type: 'parallel', config: { wait_for: 'all', on_child_error: 'continue', on_timeout: 'partial', timeout_ms: 30_000, children: [{ id: 'child-0' }] } },
    node,
    { id: 'fan_end', namespace: 'fan_end', type: 'parallel_end', config: {} },
    { id: 'done', namespace: 'done', type: 'exit', config: {} },
  ]
  const edges = [edge('fan', node.id, 'child-0'), edge('fan', 'fan_end', 'output'), edge(node.id, 'fan_end'), edge('fan_end', 'done')]
  return { nodes, edges }
}

/** A fetch that never answers and rejects the way the platform's does when its signal aborts. */
function hangUntilAborted(fetchMock: FetchMock, onCall: () => void = () => {}): void {
  fetchMock.mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
    onCall()
    return new Promise((_, reject) => {
      const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
      if (init.signal?.aborted) return abort()
      init.signal?.addEventListener('abort', abort, { once: true })
    })
  })
}

/** The step deadline passes as soon as the request is on the wire, as a slow relay's does. */
function deadlineOnceSent(c: ReturnType<typeof ctx>, fetchMock: FetchMock): void {
  let sent!: () => void
  const onWire = new Promise<void>((r) => { sent = r })
  hangUntilAborted(fetchMock, () => sent())
  c.stepDeadline = (_ms, signal) => new Promise<void>((resolve) => {
    void onWire.then(resolve)
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

async function walk(c: ReturnType<typeof ctx>, def: { nodes: NodeDefinition[]; edges: EdgeDefinition[] }): Promise<StepLogEntry[]> {
  const queue: StepLogEntry[] = []
  await walkGraph(c, def, 'exec-3057', '2026-10-29T12:00:00.000Z', supabase, env, 'money', 'v1', queue, () => {}).catch(() => null)
  return queue
}

function rowOf(queue: StepLogEntry[], ns: string): StepLogEntry {
  const row = queue.find((r) => r.step_namespace === ns)
  if (!row) throw new Error(`no step row for ${ns}: ${queue.map((r) => r.step_namespace).join(', ')}`)
  return row
}

interface StoredRequest { method: string; url: string; headers: Record<string, string>; body: unknown }
const resolvedOf = (row: StepLogEntry): StoredRequest => (row.input as { resolved: StoredRequest }).resolved

function expectTheRequestSent(row: StepLogEntry): void {
  expect(row.status).toBe('failed')
  const sent = resolvedOf(row)
  expect(sent.method).toBe('POST')
  expect(sent.url).toBe(RELAY_URL)
  expect(sent.body).toEqual({ submission_id: 'sub-3057', amount: 12000 })
  expect(sent.headers['X-Lead-Source']).toBe('website_form')
}

function expectNoSecret(row: StepLogEntry): void {
  const stored = JSON.stringify(row.input)
  for (const secret of SECRETS) expect({ secret, inStoredInput: stored.includes(secret) }).toEqual({ secret, inStoredInput: false })
  // The error message is stored beside it and must not carry one either.
  for (const secret of SECRETS) expect(String(row.error_message ?? '')).not.toContain(secret)
}

let fetchMock: FetchMock
beforeEach(() => {
  fetchMock = stubFetch()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a timed out webhook step records what it sent (#3057)', () => {
  it('in the walk: the step deadline passes with the request on the wire', async () => {
    const c = ctx()
    deadlineOnceSent(c, fetchMock)
    const row = rowOf(await walk(c, sequential(relayPost('tripoint_sf_post'))), 'tripoint_sf_post')
    expect(row.error_message).toBe(stepTimeoutMessage(3750))
    expect(stepTimedOutAfterMs(row)).toBe(3750)
    expect(row).toMatchObject({ timeout_kind: 'step', timed_out_after_ms: 3750 })
    expectTheRequestSent(row)
  })

  it('in a parallel block: the same', async () => {
    const c = ctx()
    deadlineOnceSent(c, fetchMock)
    const row = rowOf(await walk(c, inParallel(relayPost('tripoint_sf_post'))), 'tripoint_sf_post')
    expect(row.error_message).toBe(stepTimeoutMessage(3750))
    expect(stepTimedOutAfterMs(row)).toBe(3750)
    expect(row).toMatchObject({ timeout_kind: 'step', timed_out_after_ms: 3750 })
    expectTheRequestSent(row)
  })

  it('after a retry: the last attempt is what it records', async () => {
    const c = ctx()
    deadlineOnceSent(c, fetchMock)
    const node = relayPost('tripoint_sf_post')
    node.config.retries = 1
    const row = rowOf(await walk(c, sequential(node)), 'tripoint_sf_post')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(row.retries_used).toBe(1)
    expectTheRequestSent(row)
  })
})

describe('a webhook step whose connection fails records what it sent (#3057)', () => {
  it('a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network connection lost.'))
    const row = rowOf(await walk(ctx(), sequential(relayPost('amone_sf_post'))), 'amone_sf_post')
    expect(row.error_message).toContain('Network connection lost')
    expectTheRequestSent(row)
  })

  it('a network error inside a parallel block', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network connection lost.'))
    const row = rowOf(await walk(ctx(), inParallel(relayPost('amone_sf_post'))), 'amone_sf_post')
    expectTheRequestSent(row)
  })

  it('a non-2xx answer keeps the request it already carried', async () => {
    fetchMock.mockResolvedValue(new Response('relay unavailable', { status: 502 }))
    const row = rowOf(await walk(ctx(), sequential(relayPost('amone_sf_post'))), 'amone_sf_post')
    expect(row.error_message).toContain('502')
    expectTheRequestSent(row)
  })
})

describe('a failed webhook step never stores a credential (#3057)', () => {
  const failures: Array<[string, (c: ReturnType<typeof ctx>) => void]> = [
    ['a step timeout', (c) => deadlineOnceSent(c, fetchMock)],
    ['a network error', () => { fetchMock.mockRejectedValue(new TypeError('Network connection lost.')) }],
    ['a non-2xx answer', () => { fetchMock.mockResolvedValue(new Response('relay unavailable', { status: 503 })) }],
  ]
  const auths: Array<[string, Record<string, unknown>, string]> = [
    ['a bearer token', { type: 'bearer', token: '{{env.RELAY_TOKEN}}' }, 'Authorization'],
    ['an api key in its own header', { type: 'api_key', header: 'X-Relay-Key', key: '{{env.RELAY_KEY}}' }, 'X-Relay-Key'],
  ]
  for (const [failure, arrange] of failures) {
    for (const [authName, auth, header] of auths) {
      it(`${failure} with ${authName}: the header is masked, as a completed step's is`, async () => {
        const c = ctx()
        arrange(c)
        const row = rowOf(await walk(c, sequential(relayPost('tripoint_sf_post', auth))), 'tripoint_sf_post')
        expectTheRequestSent(row)
        expect(resolvedOf(row).headers[header]).toBe('[redacted]')
        expectNoSecret(row)
        // The real credential still went on the wire.
        const sentHeaders = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers
        expect(Object.values(sentHeaders).join(' ')).toContain(auth.type === 'bearer' ? FAKE_BEARER : FAKE_API_KEY)
      })
    }
  }

  it('the stored input of a failed step is exactly what a completed step of the same request stores', async () => {
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const done = rowOf(await walk(ctx(), sequential(relayPost('tripoint_sf_post'))), 'tripoint_sf_post')
    expect(done.status).toBe('completed')
    fetchMock.mockReset()
    const c = ctx()
    deadlineOnceSent(c, fetchMock)
    const failed = rowOf(await walk(c, sequential(relayPost('tripoint_sf_post'))), 'tripoint_sf_post')
    expect(failed.status).toBe('failed')
    expect(failed.input).toEqual(done.input)
  })
})
