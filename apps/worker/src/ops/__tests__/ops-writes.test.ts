/**
 * The ops write choke point, Worker side (#1948).
 *
 * The database functions themselves are proven against a real Postgres in
 * supabase-ops/supabase/tests/run_engine_*.test.sql. These tests prove the half
 * that lives here: callOpsRpc reaches only classified functions, scopes every
 * organization call, gives every call a deadline and reports one that passed it
 * as possibly committed, and each wrapper refuses an answer of the wrong shape
 * and turns a lost claim into an error the caller cannot mistake for success.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpsSupabaseClient, organizationIdFrom, type OpsDbEnv } from '../ops-db'
import {
  OPS_RPC_DEADLINE_MS,
  OpsClaimLostError,
  OpsWriteError,
  OpsWriteTimeoutError,
  callOpsRpc,
  claimRunRequests,
  completeRunRequest,
  enqueueRunRequest,
  extendRunLease,
  recordSendIntent,
  startRunExecution,
  sweepExpiredLeases,
} from '../ops-writes'

const ORG = organizationIdFrom('6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60')
const RUN = '0199f0a0-0000-7000-8000-000000000001'
const TOKEN = '11111111-2222-4333-8444-555555555555'
const WF = '22222222-3333-4444-8555-666666666666'

const env: OpsDbEnv = { OPS_SUPABASE_URL: 'https://zwihpjxouklvkvngkvmw.supabase.co', OPS_SUPABASE_SECRET_KEY: 'sb_secret_test_not_real' }

interface Call {
  path: string
  body: Record<string, unknown>
}

/** A fetch answering every rpc with `answer` (or an error), recording what was sent. */
function rpcFetch(answer: unknown, opts: { status?: number } = {}) {
  const calls: Call[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    calls.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return Response.json(answer, { status: opts.status ?? 200 })
  }) as typeof fetch
  return { client: createOpsSupabaseClient(env, { fetch: f }), calls }
}

/** A fetch that never answers until its request is aborted. */
function hangingFetch() {
  let sent = 0
  const f = ((_input: string | URL | Request, init?: RequestInit) => {
    sent++
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
    })
  }) as typeof fetch
  return { client: createOpsSupabaseClient(env, { fetch: f }), sent: () => sent }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('callOpsRpc', () => {
  it('calls the named function with its arguments', async () => {
    const { client, calls } = rpcFetch([{ requeued: 0, retried: 0, needs_human: 0, dead: 0, more: false }])
    await sweepExpiredLeases(client, 500)
    expect(calls).toEqual([{ path: '/rest/v1/rpc/sweep_expired_leases', body: { p_limit: 500 } }])
  })

  it('refuses a function not classified in ops-rpcs.ts, sending nothing', async () => {
    const { client, calls } = rpcFetch([])
    await expect(callOpsRpc(client, 'drop_everything' as never, {})).rejects.toThrow(/drop_everything is not an ops database function classified in ops-rpcs\.ts/)
    expect(calls).toEqual([])
  })

  it('refuses an organization scoped call whose organization is not a uuid, sending nothing', async () => {
    const { client, calls } = rpcFetch([])
    for (const org of [undefined, '', 'not-a-uuid', 42]) {
      await expect(callOpsRpc(client, 'enqueue_run_request', { p_organization_id: org })).rejects.toThrow(/acts within one organization/)
    }
    expect(calls).toEqual([])
  })

  it('refuses an organization on a lane wide call, which would be ignored', async () => {
    const { client, calls } = rpcFetch([])
    await expect(callOpsRpc(client, 'claim_run_requests', { p_organization_id: ORG })).rejects.toThrow(/lane wide and takes no organization/)
    expect(calls).toEqual([])
  })

  it('throws on a database error with its code, never answering an empty success', async () => {
    const { client } = rpcFetch({ code: '22023', message: 'claim_run_requests: limit must be 1 to 1000, not 5000' }, { status: 400 })
    await expect(claimRunRequests(client, { worker: 't', limit: 5000, perWorkflow: 1, leaseSeconds: 60 })).rejects.toThrow(
      /claim_run_requests failed \(22023\): claim_run_requests: limit must be 1 to 1000/,
    )
  })

  it('reports a call past its deadline as possibly committed, never as not done (L110)', async () => {
    vi.useFakeTimers()
    const { client, sent } = hangingFetch()
    const pending = enqueueRunRequest(client, ORG, { workflowId: WF, workflowVersion: 1, triggerKind: 'http_webhook', dedupKey: 'k' })
    // Handler attached before the clock moves, so the rejection is never unhandled (L749).
    const outcome = pending.then(() => 'resolved', (err: unknown) => err)
    await vi.advanceTimersByTimeAsync(OPS_RPC_DEADLINE_MS)
    const err = await outcome
    expect(err).toBeInstanceOf(OpsWriteTimeoutError)
    expect(String(err)).toMatch(/enqueue_run_request passed its 9000 ms deadline and may still have committed/)
    expect(sent()).toBe(1)
  })

  it('sets its deadline past the ops project\'s 8 s statement timeout, so the database gives up first', () => {
    expect(OPS_RPC_DEADLINE_MS).toBeGreaterThan(8_000)
    expect(OPS_RPC_DEADLINE_MS).toBeLessThan(60_000)
  })
})

describe('the typed wrappers', () => {
  it('enqueue: sends only the fields given, and reads a duplicate as the first run', async () => {
    const { client, calls } = rpcFetch([{ outcome: 'duplicate', run_request_id: RUN, run_status: 'running' }])
    const result = await enqueueRunRequest(client, ORG, {
      workflowId: WF, workflowVersion: 3, triggerKind: 'http_webhook', dedupKey: 'idem-1', notBefore: new Date('2026-10-16T12:00:00Z'),
    })
    expect(result).toEqual({ outcome: 'duplicate', runRequestId: RUN, runStatus: 'running' })
    expect(calls[0].body).toEqual({
      p_organization_id: ORG, p_workflow_id: WF, p_workflow_version: 3, p_trigger_kind: 'http_webhook', p_dedup_key: 'idem-1',
      p_not_before: '2026-10-16T12:00:00.000Z',
    })
  })

  it('enqueue: refuses an answer of the wrong shape by name', async () => {
    const { client } = rpcFetch([{ outcome: 'maybe', run_request_id: RUN, run_status: 'queued' }])
    await expect(enqueueRunRequest(client, ORG, { workflowId: WF, workflowVersion: 1, triggerKind: 'http_webhook', dedupKey: 'k' })).rejects.toThrow(
      /enqueue_run_request returned outcome that is not an enqueue outcome/,
    )
    const { client: empty } = rpcFetch([])
    await expect(enqueueRunRequest(empty, ORG, { workflowId: WF, workflowVersion: 1, triggerKind: 'http_webhook', dedupKey: 'k' })).rejects.toThrow(
      /enqueue_run_request returned 0 rows, expected 1/,
    )
  })

  it('claim: returns each run with its organization checked, and refuses one that is not a uuid', async () => {
    const row = {
      run_request_id: RUN, organization_id: ORG, workflow_id: WF, workflow_version: 2, trigger_kind: 'schedule', claim_token: TOKEN,
      claim_expires_at: '2026-10-16T12:01:00Z', state_version: 2, attempts: 0, max_attempts: 3, resume_reason: null,
      execution_chain_id: RUN, resumed_from_execution_id: null, payload: { scheduled_for: '2026-10-16T12:00:00Z' }, payload_ref: null,
    }
    const { client } = rpcFetch([row])
    const [claimed] = await claimRunRequests(client, { worker: 'tick', limit: 10, perWorkflow: 2, leaseSeconds: 60 })
    expect(claimed).toMatchObject({ runRequestId: RUN, organizationId: ORG, claimToken: TOKEN, stateVersion: 2 })

    const { client: bad } = rpcFetch([{ ...row, organization_id: 'someone-else' }])
    await expect(claimRunRequests(bad, { worker: 'tick', limit: 10, perWorkflow: 2, leaseSeconds: 60 })).rejects.toThrow(/organization is not a uuid/)
  })

  it('start: a lost claim is an error, never a start', async () => {
    const { client } = rpcFetch([{ outcome: 'claim_lost', state_version: null, attempt: null }])
    await expect(startRunExecution(client, ORG, RUN, TOKEN, '0199f0a0-0000-7000-8000-0000000000e1')).rejects.toBeInstanceOf(OpsClaimLostError)
  })

  it('extend: false is a lost claim, and anything but a boolean is refused', async () => {
    expect(await extendRunLease(rpcFetch(false).client, ORG, RUN, TOKEN, 60)).toBe(false)
    expect(await extendRunLease(rpcFetch(true).client, ORG, RUN, TOKEN, 60)).toBe(true)
    await expect(extendRunLease(rpcFetch([{ extended: true }]).client, ORG, RUN, TOKEN, 60)).rejects.toThrow(/returned something other than true or false/)
  })

  it('complete: a lost claim or a run not found throws, and a repeat of its own success does not', async () => {
    for (const outcome of ['claim_lost', 'not_found']) {
      const { client } = rpcFetch([{ outcome, run_status: 'running', state_version: 4 }])
      await expect(completeRunRequest(client, ORG, RUN, TOKEN, { outcome: 'done' })).rejects.toBeInstanceOf(OpsClaimLostError)
    }
    const { client, calls } = rpcFetch([{ outcome: 'already_completed', run_status: 'suspended', state_version: 5 }])
    const done = await completeRunRequest(client, ORG, RUN, TOKEN, { outcome: 'suspend', reason: 'wake', notBefore: new Date('2026-10-16T13:00:00Z') })
    expect(done).toEqual({ outcome: 'already_completed', runStatus: 'suspended' })
    expect(calls[0].body).toEqual({
      p_organization_id: ORG, p_run_request_id: RUN, p_claim_token: TOKEN, p_outcome: 'suspend', p_reason: 'wake', p_not_before: '2026-10-16T13:00:00.000Z',
    })
  })

  it('send intent: stale comes back as stale, so the caller can refuse to send', async () => {
    const { client, calls } = rpcFetch([{ outcome: 'stale', ledger_id: null, ledger_status: null }])
    const result = await recordSendIntent(client, ORG, {
      runRequestId: RUN, claimToken: TOKEN, stateVersion: 3, nodeId: 'post_lead', seq: 1, method: 'POST', host: 'partner.example', idempotent: false,
    })
    expect(result.outcome).toBe('stale')
    expect(calls[0].body).not.toHaveProperty('p_attempt_key')
  })

  it('send intent: refuses a GET, which the ledger does not record', async () => {
    const { client, calls } = rpcFetch([])
    await expect(recordSendIntent(client, ORG, {
      runRequestId: RUN, claimToken: TOKEN, stateVersion: 3, nodeId: 'n', seq: 1, method: 'GET' as never, host: 'h', idempotent: false,
    })).rejects.toThrow(OpsWriteError)
    expect(calls).toEqual([])
  })
})
