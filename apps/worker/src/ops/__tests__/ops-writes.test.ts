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
  CONNECTION_SERVE_WINDOW_MS,
  OPS_RPC_DEADLINE_MS,
  OpsClaimLostError,
  OpsWriteError,
  OpsWriteTimeoutError,
  acquireSfLease,
  callOpsRpc,
  chargedAttempts,
  claimOpsSweep,
  claimRunRequests,
  completeRunRequest,
  dueQueueDepth,
  enqueueRunRequest,
  extendRunLease,
  lastChargedAttempt,
  opsNow,
  purgeExpiredConnectionTombstones,
  readConnectionCopy,
  readConnectionStatus,
  readWorkflowCopies,
  recordConnectionCheck,
  recordConnectionNeedsReauth,
  recordConnectionReauthCleared,
  recordConnectionTombstone,
  recordMeasuredIdentity,
  recordScheduleObservation,
  recordSendIntent,
  recordSfBudgetReading,
  releaseSfLease,
  saveConnectionCopies,
  saveWorkflowCopies,
  startRunExecution,
  sweepExpiredLeases,
  sweepSfLeases,
} from '../ops-writes'
import type { ResourceWaitCause } from '../run-vocabulary'

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
    const { client, calls } = rpcFetch([{ requeued: 0, retried: 0, needs_human: 0, dead: 0, failed: 0, more: false }])
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
      uncharged_attempts: 0,
    }
    const { client } = rpcFetch([row])
    const [claimed] = await claimRunRequests(client, { worker: 'tick', limit: 10, perWorkflow: 2, leaseSeconds: 60 })
    expect(claimed).toMatchObject({ runRequestId: RUN, organizationId: ORG, claimToken: TOKEN, stateVersion: 2 })

    const { client: bad } = rpcFetch([{ ...row, organization_id: 'someone-else' }])
    await expect(claimRunRequests(bad, { worker: 'tick', limit: 10, perWorkflow: 2, leaseSeconds: 60 })).rejects.toThrow(/organization is not a uuid/)
  })

  it('claim: answers the uncharged attempts, so the Worker sees the charged count (#2336)', async () => {
    const row = {
      run_request_id: RUN, organization_id: ORG, workflow_id: WF, workflow_version: 2, trigger_kind: 'http_webhook', claim_token: TOKEN,
      claim_expires_at: '2026-10-18T12:01:00Z', state_version: 9, attempts: 2, max_attempts: 2, resume_reason: 'resource_wait',
      execution_chain_id: RUN, resumed_from_execution_id: null, payload: null, payload_ref: null, uncharged_attempts: 1,
    }
    const claim = { worker: 'tick', limit: 10, perWorkflow: 2, leaseSeconds: 60 }
    const [claimed] = await claimRunRequests(rpcFetch([row]).client, claim)
    expect(claimed).toMatchObject({ attempts: 2, unchargedAttempts: 1, maxAttempts: 2, resumeReason: 'resource_wait' })

    // Ops migration 20261018140000 is applied, so every claim answers it. An answer
    // without it is refused by name, never read as 0 (L163) or as unknown.
    const { uncharged_attempts: _omitted, ...before } = row
    await expect(claimRunRequests(rpcFetch([before]).client, claim)).rejects.toThrow(
      /claim_run_requests returned no uncharged_attempts/,
    )
    // One row missing it refuses the whole claim, not just that run.
    await expect(claimRunRequests(rpcFetch([row, before]).client, claim)).rejects.toThrow(
      /claim_run_requests returned no uncharged_attempts/,
    )

    for (const bad of ['1', 1.5, null, -1, 3]) {
      await expect(claimRunRequests(rpcFetch([{ ...row, uncharged_attempts: bad }]).client, claim), String(bad)).rejects.toThrow(
        /claim_run_requests returned uncharged_attempts that is not a whole number from 0 to attempts/,
      )
    }
  })

  it('claim: the charged count, and whether a retry after this start is the last, judged as the database judges them (#2336)', () => {
    // A run of max_attempts 2 that waited twice on the Salesforce pool, claimed to resume:
    // attempts alone (this start would be the third of 2) calls it spent, but one attempt
    // is charged and a start resumed from a wait is not.
    const waited = { attempts: 2, unchargedAttempts: 1, maxAttempts: 2, resumeReason: 'resource_wait' }
    expect(chargedAttempts(waited)).toBe(1)
    expect(waited.attempts + 1 >= waited.maxAttempts).toBe(true)
    expect(lastChargedAttempt(waited)).toBe(false)
    // The same run claimed as a retry after those waits: this start is charged, 2 of 2.
    expect(lastChargedAttempt({ attempts: 3, unchargedAttempts: 2, maxAttempts: 2, resumeReason: 'retry' })).toBe(true)
    // A lapse the sweep refunded leaves its one attempt to spend.
    expect(lastChargedAttempt({ attempts: 1, unchargedAttempts: 1, maxAttempts: 2, resumeReason: 'retry' })).toBe(false)
    // A run that never waited: the charged count is attempts.
    expect(chargedAttempts({ attempts: 1, unchargedAttempts: 0 })).toBe(1)
    expect(lastChargedAttempt({ attempts: 0, unchargedAttempts: 0, maxAttempts: 1, resumeReason: null })).toBe(true)
    expect(lastChargedAttempt({ attempts: 0, unchargedAttempts: 0, maxAttempts: 3, resumeReason: null })).toBe(false)
    // Always a count now the claim always answers it, so a caller has no unknown case
    // to handle (typed number and boolean, which the typecheck holds).
    const charged: number = chargedAttempts({ attempts: 2, unchargedAttempts: 0 })
    const last: boolean = lastChargedAttempt({ attempts: 2, unchargedAttempts: 0, maxAttempts: 3, resumeReason: null })
    expect(charged).toBe(2)
    expect(last).toBe(true)
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

  it('complete: a resource wait sends its cause as p_error with its wake time (#2334)', async () => {
    const { client, calls } = rpcFetch([{ outcome: 'completed', run_status: 'suspended', state_version: 6 }])
    const done = await completeRunRequest(client, ORG, RUN, TOKEN, { outcome: 'suspend', reason: 'resource_wait', cause: 'sf_budget_floor', notBefore: new Date('2026-10-17T23:05:00Z') })
    expect(done).toEqual({ outcome: 'completed', runStatus: 'suspended' })
    expect(calls[0].body).toEqual({
      p_organization_id: ORG, p_run_request_id: RUN, p_claim_token: TOKEN, p_outcome: 'suspend', p_reason: 'resource_wait',
      p_error: 'sf_budget_floor', p_not_before: '2026-10-17T23:05:00.000Z',
    })
  })

  it('complete: a resource wait ended for waiting too long reads as failed, the status the database chose', async () => {
    const { client } = rpcFetch([{ outcome: 'completed', run_status: 'failed', state_version: 7 }])
    const done = await completeRunRequest(client, ORG, RUN, TOKEN, { outcome: 'suspend', reason: 'resource_wait', cause: 'pool_full', notBefore: new Date('2026-10-17T23:05:00Z') })
    expect(done).toEqual({ outcome: 'completed', runStatus: 'failed' })
  })

  it('complete: refuses a resource wait whose cause is not one the database takes, sending nothing', async () => {
    const { client, calls } = rpcFetch([])
    await expect(completeRunRequest(client, ORG, RUN, TOKEN, {
      outcome: 'suspend', reason: 'resource_wait', cause: 'pool_busy' as ResourceWaitCause, notBefore: new Date('2026-10-17T23:05:00Z'),
    })).rejects.toThrow(/pool_busy is not a resource wait cause/)
    expect(calls).toEqual([])
  })

  it('the lease sweep reads the runs it ended failed, and refuses an answer without that count', async () => {
    expect(await sweepExpiredLeases(rpcFetch([{ requeued: 1, retried: 2, needs_human: 0, dead: 0, failed: 1, more: false }]).client, 100))
      .toEqual({ requeued: 1, retried: 2, needsHuman: 0, dead: 0, failed: 1, more: false })
    await expect(sweepExpiredLeases(rpcFetch([{ requeued: 0, retried: 0, needs_human: 0, dead: 0, more: false }]).client, 100))
      .rejects.toThrow(/sweep_expired_leases returned failed that is not a count/)
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

describe('the minute cron wrappers (#1949)', () => {
  it('ops_now refuses an answer that is not a time', async () => {
    const { client } = rpcFetch('soon')
    await expect(opsNow(client)).rejects.toThrow(/ops_now returned something other than a time/)
  })

  it('claim_ops_sweep refuses an unknown sweep before sending, and reads a stand down', async () => {
    const empty = rpcFetch([])
    await expect(claimOpsSweep(empty.client, 'purge_everything' as never, 'tick', 50)).rejects.toThrow(/not a sweep/)
    expect(empty.calls).toEqual([])
    const { client, calls } = rpcFetch([{ owned: false, db_now: '2026-10-17T10:00:00+00:00', last_started_at: '2026-10-17T09:59:40+00:00', last_owner: 'tick-a' }])
    expect(await claimOpsSweep(client, 'lease_expiry', 'tick-b', 50)).toEqual({ owned: false, lastStartedAt: '2026-10-17T09:59:40+00:00', lastOwner: 'tick-a' })
    expect(calls[0]).toEqual({ path: '/rest/v1/rpc/claim_ops_sweep', body: { p_sweep: 'lease_expiry', p_owner: 'tick-b', p_every_seconds: 50 } })
  })

  it('save_workflow_copies refuses more than one save carries, sending nothing', async () => {
    const { client, calls } = rpcFetch([])
    const one = { workflowId: WF, organizationId: ORG, isActive: true, deletedAt: null, rowUpdatedAt: '2026-10-17T09:00:00Z', versionNumber: 1, trigger: null }
    await expect(saveWorkflowCopies(client, '2026-10-17T10:00:00Z', true, Array.from({ length: 1001 }, () => one))).rejects.toThrow(/more than one save carries/)
    expect(calls).toEqual([])
  })

  it('workflow_copies refuses a copy whose organization is not a uuid, and says when a page was full', async () => {
    const row = {
      workflow_id: WF, organization_id: ORG, is_active: true, deleted_at: null, withdrawn_at: null, row_updated_at: '2026-10-17T09:00:00+00:00',
      version_number: 1, trigger: null, schedule_known_since: null, switched_off_at: null, served_at: '2026-10-17T10:00:00+00:00',
      received_at: '2026-10-17T10:00:00+00:00', confirmed_at: '2026-10-17T10:00:00+00:00', may_start: true, last_served: null, last_observed: null,
      db_now: '2026-10-17T10:00:00+00:00',
    }
    expect((await readWorkflowCopies(rpcFetch([row]).client, 1)).reachedLimit).toBe(true)
    await expect(readWorkflowCopies(rpcFetch([{ ...row, organization_id: 'org-1' }]).client, 10)).rejects.toThrow(/organization is not a uuid/)
    await expect(readWorkflowCopies(rpcFetch([{ ...row, may_start: 'yes' }]).client, 10)).rejects.toThrow(/may_start that is not true or false/)
  })

  it('record_schedule_observation refuses a reason that is not its outcome\'s, sending nothing', async () => {
    const { client, calls } = rpcFetch([])
    await expect(recordScheduleObservation(client, ORG, {
      workflowId: WF, workflowVersion: 1, scheduledFor: new Date('2026-10-17T10:00:00Z'), outcome: 'would_fire', reason: 'catch_up_none',
      dispatchAt: new Date('2026-10-17T10:00:00Z'), previousScheduledFor: null, tickId: 'tick',
    })).rejects.toThrow(/catch_up_none is not a reason for would_fire/)
    expect(calls).toEqual([])
  })

  it('due_queue_depth reads its counts', async () => {
    const { client } = rpcFetch([{ due_runs: 7, due_workflows: 2, oldest_due: '2026-10-17T09:00:00+00:00' }])
    expect(await dueQueueDepth(client)).toEqual({ dueRuns: 7, dueWorkflows: 2, oldestDue: '2026-10-17T09:00:00+00:00' })
  })
})

describe('the ops connection wrappers (#2334)', () => {
  const CONN = '33333333-4444-4555-8666-777777777777'
  const SF = '00D5e000000AbCdEAA'
  const envelope = { v: 1, kid: 'ops-2026-10', wrapped_key: 'd2s', iv: 'aXY', ct: 'Y3Q' }
  const copy = {
    connectionId: CONN, organizationId: ORG, service: 'salesforce', generation: 2, envelope, publicConfig: { name: 'trypennie' },
    target: { instance_url: 'https://trypennie.my.salesforce.com' }, serveUntil: '2026-10-17T16:00:00Z',
  }

  it('save_connection_copies sends each copy and reads every count', async () => {
    const { client, calls } = rpcFetch([{ inserted: 1, updated: 0, confirmed: 0, refused_older: 0, refused_expired: 0, refused_removed: 0, withdrawn: 0 }])
    expect(await saveConnectionCopies(client, '2026-10-17T10:00:00Z', true, [copy])).toEqual({
      inserted: 1, updated: 0, confirmed: 0, refusedOlder: 0, refusedExpired: 0, refusedRemoved: 0, withdrawn: 0,
    })
    expect(calls[0]).toEqual({
      path: '/rest/v1/rpc/save_connection_copies',
      body: {
        p_served_at: '2026-10-17T10:00:00Z', p_complete: true,
        p_copies: [{
          connection_id: CONN, organization_id: ORG, service: 'salesforce', generation: 2, envelope, public_config: { name: 'trypennie' },
          target: { instance_url: 'https://trypennie.my.salesforce.com' }, serve_until: '2026-10-17T16:00:00Z',
        }],
      },
    })
  })

  it('save_connection_copies refuses a copy served for longer than 6 hours (Dan\'s decision 3), sending nothing', async () => {
    expect(CONNECTION_SERVE_WINDOW_MS).toBe(6 * 60 * 60 * 1000)
    const { client, calls } = rpcFetch([])
    await expect(saveConnectionCopies(client, '2026-10-17T10:00:00Z', false, [{ ...copy, serveUntil: '2026-10-17T16:00:01Z' }]))
      .rejects.toThrow(/serve_until more than 6 hours after it was served/)
    await expect(saveConnectionCopies(client, '2026-10-17T10:00:00Z', false, Array.from({ length: 1001 }, () => copy))).rejects.toThrow(/more than one save carries/)
    expect(calls).toEqual([])
  })

  it('connection_copy hands back the envelope only for a usable copy, and refuses an unknown state', async () => {
    const row = {
      state: 'usable', connection_id: CONN, service: 'salesforce', generation: 2, envelope, public_config: {}, target: null,
      served_at: '2026-10-17T10:00:00+00:00', serve_until: '2026-10-17T16:00:00+00:00', db_now: '2026-10-17T10:01:00+00:00',
    }
    const usable = rpcFetch([row])
    expect(await readConnectionCopy(usable.client, ORG, CONN)).toMatchObject({ state: 'usable', generation: 2, envelope })
    expect(usable.calls[0]).toEqual({ path: '/rest/v1/rpc/connection_copy', body: { p_organization_id: ORG, p_connection_id: CONN } })
    expect(await readConnectionCopy(rpcFetch([{ ...row, state: 'connection_copy_expired', envelope: null }]).client, ORG, CONN))
      .toMatchObject({ state: 'connection_copy_expired', envelope: null })
    await expect(readConnectionCopy(rpcFetch([{ ...row, state: 'connection_copy_expired' }]).client, ORG, CONN))
      .rejects.toThrow(/an envelope with the state connection_copy_expired/)
    await expect(readConnectionCopy(rpcFetch([{ ...row, state: 'mostly_fine' }]).client, ORG, CONN)).rejects.toThrow(/state that is not a copy state/)
  })

  it('a tombstone is sent with its generation and removal time, and the purge reads its page', async () => {
    const { client, calls } = rpcFetch([{ outcome: 'recorded', copies_removed: 1 }])
    expect(await recordConnectionTombstone(client, ORG, CONN, 2, new Date('2026-10-17T10:00:00Z'))).toEqual({ outcome: 'recorded', copiesRemoved: 1 })
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_connection_id: CONN, p_generation: 2, p_removed_at: '2026-10-17T10:00:00.000Z' })
    expect(await purgeExpiredConnectionTombstones(rpcFetch([{ purged: 3, more: false }]).client, 100)).toEqual({ purged: 3, more: false })
  })

  it('each health writer sends only its own fields, and a check failure needs a cause', async () => {
    const check = rpcFetch('recorded')
    expect(await recordConnectionCheck(check.client, ORG, CONN, { ok: false, cause: 'userinfo answered 503' })).toBe('recorded')
    expect(check.calls[0]).toEqual({ path: '/rest/v1/rpc/record_connection_check', body: { p_organization_id: ORG, p_connection_id: CONN, p_ok: false, p_cause: 'userinfo answered 503' } })
    const pass = rpcFetch('recorded')
    await recordConnectionCheck(pass.client, ORG, CONN, { ok: true })
    expect(pass.calls[0].body).toEqual({ p_organization_id: ORG, p_connection_id: CONN, p_ok: true, p_cause: null })
    expect(await recordConnectionNeedsReauth(rpcFetch('connection_removed').client, ORG, CONN, 'invalid_grant')).toBe('connection_removed')
    expect(await recordConnectionReauthCleared(rpcFetch('recorded').client, ORG, CONN)).toBe('recorded')
    await expect(recordConnectionNeedsReauth(rpcFetch('maybe').client, ORG, CONN, 'invalid_grant')).rejects.toThrow(/not a health outcome/)
  })

  it('connection_status keeps a status this Worker does not know as text, and says when a page was full', async () => {
    const row = {
      connection_id: CONN, service: 'salesforce', generation: 2, status: 'needs_reauth', last_check_ok_at: '2026-10-17T10:05:00+00:00',
      last_check_failed_at: null, last_check_cause: null, needs_reauth_at: '2026-10-17T10:00:00+00:00', needs_reauth_cause: 'invalid_grant', reauth_cleared_at: null,
    }
    const read = await readConnectionStatus(rpcFetch([row, { ...row, status: 'refresh_failing' }]).client, ORG, 2)
    expect(read.reachedLimit).toBe(true)
    expect(read.connections.map((c) => c.status)).toEqual(['needs_reauth', 'refresh_failing'])
    await expect(readConnectionStatus(rpcFetch([{ ...row, needs_reauth_at: 'later' }]).client, ORG, 10)).rejects.toThrow(/needs_reauth_at that is not a time or null/)
  })

  it('a measured identity must be an 18 character org id, refused before sending', async () => {
    const { client, calls } = rpcFetch('recorded')
    await expect(recordMeasuredIdentity(client, ORG, CONN, 2, { sfOrgId: '00D5e000000AbCd', username: 'ops@x' })).rejects.toThrow(/18 character/)
    expect(calls).toEqual([])
    expect(await recordMeasuredIdentity(client, ORG, CONN, 2, { sfOrgId: SF, username: 'ops@x' })).toBe('recorded')
    expect(calls[0].body).toEqual({ p_organization_id: ORG, p_connection_id: CONN, p_generation: 2, p_sf_org_id: SF, p_username: 'ops@x' })
    expect(await recordMeasuredIdentity(rpcFetch('identity_changed').client, ORG, CONN, 2, { sfOrgId: SF, username: 'ops@x' })).toBe('identity_changed')
  })

  it('acquire_sf_lease sends a verify with its host, and reads a grant', async () => {
    const { client, calls } = rpcFetch([{ outcome: 'granted', lease_id: TOKEN, expires_at: '2026-10-17T10:01:00+00:00', retry_at: null, pool: 'bootstrap' }])
    expect(await acquireSfLease(client, ORG, { connectionId: CONN, generation: 1, purpose: 'verify', holder: 'h-1', ttlSeconds: 60, bootstrapHost: 'trypennie.my.salesforce.com' }))
      .toEqual({ outcome: 'granted', leaseId: TOKEN, expiresAt: '2026-10-17T10:01:00+00:00', pool: 'bootstrap' })
    expect(calls[0].body).toEqual({
      p_organization_id: ORG, p_connection_id: CONN, p_generation: 1, p_purpose: 'verify', p_workflow_id: null, p_holder: 'h-1', p_ttl_seconds: 60,
      p_bootstrap_host: 'trypennie.my.salesforce.com',
    })
  })

  it('acquire_sf_lease reads every refusal by name, with its retry time', async () => {
    for (const outcome of ['pool_full', 'workflow_share_full', 'sf_budget_floor', 'sf_budget_unmeasured', 'sf_org_unmeasured', 'sf_cap_unset'] as const) {
      const retry = outcome === 'sf_org_unmeasured' || outcome === 'sf_cap_unset' ? null : '2026-10-17T10:02:00+00:00'
      const { client, calls } = rpcFetch([{ outcome, lease_id: null, expires_at: null, retry_at: retry, pool: 'org' }])
      expect(await acquireSfLease(client, ORG, { connectionId: CONN, generation: 1, purpose: 'step', workflowId: WF, holder: 'h-2', ttlSeconds: 60 }))
        .toEqual({ outcome, retryAt: retry })
      expect(calls[0].body).toMatchObject({ p_purpose: 'step', p_workflow_id: WF, p_bootstrap_host: null })
    }
  })

  it('acquire_sf_lease fails closed: an unknown answer, or a grant with no lease, is an error, never a grant', async () => {
    const ask = { connectionId: CONN, generation: 1, purpose: 'lookup' as const, holder: 'h-3', ttlSeconds: 60 }
    await expect(acquireSfLease(rpcFetch([{ outcome: 'probably', lease_id: null, expires_at: null, retry_at: null, pool: 'org' }]).client, ORG, ask))
      .rejects.toThrow(/not a lease outcome/)
    await expect(acquireSfLease(rpcFetch([{ outcome: 'granted', lease_id: null, expires_at: null, retry_at: null, pool: 'org' }]).client, ORG, ask))
      .rejects.toThrow(/lease_id that is not an id/)
  })

  it('acquire_sf_lease refuses a step with no workflow and a host on anything but verify, sending nothing', async () => {
    const { client, calls } = rpcFetch([])
    await expect(acquireSfLease(client, ORG, { connectionId: CONN, generation: 1, purpose: 'step', holder: 'h', ttlSeconds: 60 })).rejects.toThrow(/a step names its workflow/)
    await expect(acquireSfLease(client, ORG, { connectionId: CONN, generation: 1, purpose: 'lookup', workflowId: WF, holder: 'h', ttlSeconds: 60 })).rejects.toThrow(/a step names its workflow/)
    await expect(acquireSfLease(client, ORG, { connectionId: CONN, generation: 1, purpose: 'lookup', holder: 'h', ttlSeconds: 60, bootstrapHost: 'x.my.salesforce.com' }))
      .rejects.toThrow(/only verify/)
    await expect(acquireSfLease(client, ORG, { connectionId: CONN, generation: 1, purpose: 'drain' as never, holder: 'h', ttlSeconds: 60 })).rejects.toThrow(/not a purpose/)
    expect(calls).toEqual([])
  })

  it('release, the lease sweep and a budget reading read their answers', async () => {
    const release = rpcFetch('not_held')
    expect(await releaseSfLease(release.client, ORG, 'h-1')).toBe('not_held')
    expect(release.calls[0].body).toEqual({ p_organization_id: ORG, p_holder: 'h-1' })
    expect(await sweepSfLeases(rpcFetch([{ swept: 2, more: false }]).client, 500)).toEqual({ swept: 2, more: false })
    const reading = rpcFetch('recorded')
    expect(await recordSfBudgetReading(reading.client, SF, { dailyApiMax: 15000, dailyApiRemaining: -3, source: 'sforce_limit_info' })).toBe('recorded')
    expect(reading.calls[0].body).toEqual({ p_sf_org_id: SF, p_daily_api_max: 15000, p_daily_api_remaining: -3, p_source: 'sforce_limit_info' })
    await expect(recordSfBudgetReading(reading.client, SF, { dailyApiMax: 1, dailyApiRemaining: 1, source: 'guess' as never })).rejects.toThrow(/not a reading source/)
  })
})
