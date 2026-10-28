/**
 * OpsInternal.run (#1950, PR 4b of B3): a claimed run the tick dispatched,
 * verified, its definition found, and run through invokeRun against the ops
 * database's own functions. The database here is a fake PostgREST answering
 * each function by name, so these tests prove the wiring: the signature and
 * item checks, the definition read from the frozen copy and fetched from the
 * bidding Worker when not held, and a run whose definition cannot be had
 * returned to the queue without being started.
 */
import { describe, expect, it, vi } from 'vitest'
import { CONTINUATION_BUDGET } from '../checkpoint'
import { dispatchKey, signDispatch } from '../dispatch-auth'
import type { OpsEnv } from '../index'
import type { ClaimedRun } from '../ops-writes'
import { organizationIdFrom } from '../ops-db'
import { RUN_DEFINITION_RETRY_MS, runDispatched } from '../run-live'

const NOW = Date.parse('2026-10-17T10:02:31.000Z')
const ORG = organizationIdFrom('6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60')
const WF = '00000000-0000-4000-8000-0000000019a1'
const DEF = { nodes: [], edges: [] }

const RUN: ClaimedRun = {
  runRequestId: '0192f4a0-0000-7000-8000-000000000001', organizationId: ORG, workflowId: WF, workflowVersion: 3,
  triggerKind: 'schedule', claimToken: '11111111-2222-4333-8444-555555555555', claimExpiresAt: '2026-10-17T10:03:31.000Z', stateVersion: 2,
  attempts: 0, unchargedAttempts: 0, maxAttempts: 3, resumeReason: null, executionChainId: '0192f4a0-0000-7000-9000-000000000001',
  resumedFromExecutionId: null, payload: null, payloadRef: null,
}

/** The ops database: each function answered by name (or by a function of its arguments), every call recorded with its arguments. */
function opsDb(answers: Record<string, unknown>) {
  const calls: Array<{ name: string; body: Record<string, unknown> }> = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const name = new URL(input instanceof Request ? input.url : input.toString()).pathname.replace('/rest/v1/rpc/', '')
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ name, body })
    if (!(name in answers)) return Response.json({ code: '42883', message: `no function ${name}` }, { status: 404 })
    const answer = answers[name]
    return Response.json(typeof answer === 'function' ? (answer as (b: Record<string, unknown>) => unknown)(body) : answer)
  }) as typeof globalThis.fetch
  return { fetch, calls, names: () => calls.map((c) => c.name) }
}

const LIFECYCLE = {
  start_run_execution: [{ outcome: 'started', state_version: 3, attempt: 1 }],
  extend_run_lease: true,
  complete_run_request: [{ outcome: 'completed', run_status: 'failed', state_version: 4 }],
  save_workflow_definition: 'saved',
}

function env(gateway?: { opsWorkflowDefinitions(r: unknown): Promise<unknown> }): OpsEnv {
  return {
    LANE: 'ops', PORTING_CAPTURE_MASTER: 'master-secret', OPS_SUPABASE_URL: 'https://zwihpjxouklvkvngkvmw.supabase.co', OPS_SUPABASE_SECRET_KEY: 'sb_secret_test_not_real',
    ...(gateway ? { OPS_GATEWAY: gateway } : {}),
  } as unknown as OpsEnv
}

async function signed(item: unknown, master = 'master-secret') {
  return signDispatch(await dispatchKey(master), { v: 1, tick_id: 'tick-1', signed_at: new Date(NOW).toISOString(), item: item as never })
}

const deps = (fetch: typeof globalThis.fetch) => ({ nowMs: NOW, opsFetch: fetch, newExecutionId: () => '0192f4a0-0000-7000-8000-0000000000ee' })

describe('OpsInternal.run', () => {
  it('refuses outside the ops lane, a signature that does not verify, and an item that is not a run, each by name', async () => {
    const db = opsDb(LIFECYCLE)
    expect(await runDispatched({ ...env(), LANE: 'money' } as OpsEnv, await signed({ kind: 'run', run: RUN }), deps(db.fetch))).toMatchObject({ refused: 'lane_not_ops (money)' })
    expect(await runDispatched(env(), await signed({ kind: 'run', run: RUN }, 'another-master'), deps(db.fetch))).toEqual({ refused: 'bad_signature' })
    expect(await runDispatched(env(), await signed({ kind: 'probe' }), deps(db.fetch))).toEqual({ refused: 'not_a_run' })
    expect(db.calls).toEqual([])
  })

  it('runs a run whose definition ops holds: reads it in the run\'s organization, starts under the claim token, and ends the claim', async () => {
    const db = opsDb({ ...LIFECYCLE, workflow_definition: [{ definition: DEF, saved_at: '2026-10-17T09:00:00Z' }] })
    const report = await runDispatched(env(), await signed({ kind: 'run', run: RUN }), deps(db.fetch))
    expect(report).toMatchObject({ outcome: 'completed' })
    const read = db.calls.find((c) => c.name === 'workflow_definition')
    expect(read?.body).toEqual({ p_organization_id: ORG, p_workflow_id: WF, p_version_number: 3 })
    expect(db.calls.find((c) => c.name === 'start_run_execution')?.body).toMatchObject({ p_run_request_id: RUN.runRequestId, p_claim_token: RUN.claimToken })
    expect(db.names().indexOf('start_run_execution')).toBeLessThan(db.names().indexOf('complete_run_request'))
  })

  it('records each step through record_ops_step, under the run\'s organization, claim token and execution (#2703)', async () => {
    const def = { nodes: [{ id: 'shape', namespace: 'shape', type: 'transform', config: { mappings: [{ source: 'trigger.payload.amount', target: 'amount' }] } }], edges: [{ id: 'e0', source: 'trigger', target: 'shape' }] }
    const db = opsDb({ ...LIFECYCLE, workflow_definition: [{ definition: def, saved_at: '2026-10-17T09:00:00Z' }], record_ops_step: 'recorded' })
    const report = await runDispatched(env(), await signed({ kind: 'run', run: { ...RUN, payload: { amount: 7 } } }), deps(db.fetch))
    expect(report).toMatchObject({ outcome: 'completed' })
    expect(db.calls.find((c) => c.name === 'record_ops_step')?.body).toMatchObject({
      p_organization_id: ORG, p_run_request_id: RUN.runRequestId, p_claim_token: RUN.claimToken, p_execution_id: '0192f4a0-0000-7000-8000-0000000000ee',
      p_seq: 0, p_node_id: 'shape', p_namespace: 'shape', p_step_type: 'transform', p_status: 'completed', p_output: { amount: 7 }, p_error: null,
    })
    expect(db.names().indexOf('record_ops_step')).toBeLessThan(db.names().indexOf('complete_run_request'))
  })

  it('fetches a definition ops does not hold from the bidding Worker, freezes it, then runs', async () => {
    const asked: unknown[] = []
    const gateway = { opsWorkflowDefinitions: async (r: unknown) => { asked.push(r); return { definitions: [{ workflow_id: WF, organization_id: ORG, version_number: 3, definition: DEF }], unserved: [] } } }
    const db = opsDb({ ...LIFECYCLE, workflow_definition: [] })
    const report = await runDispatched(env(gateway), await signed({ kind: 'run', run: RUN }), deps(db.fetch))
    expect(asked).toEqual([{ versions: [{ workflow_id: WF, version_number: 3 }] }])
    expect(db.names()).toContain('save_workflow_definition')
    expect(report).toMatchObject({ outcome: 'completed' })
  })

  it('runs on the variables ops froze with the version, never asking the bidding Worker for them again (#2702)', async () => {
    const def = { nodes: [{ id: 'shape', namespace: 'shape', type: 'transform', config: { mappings: [{ source: 'env.API_BASE', target: 'base' }] } }], edges: [{ id: 'e0', source: 'trigger', target: 'shape' }] }
    const asked: unknown[] = []
    const gateway = { opsWorkflowDefinitions: async (r: unknown) => { asked.push(r); return { definitions: [], unserved: [] } } }
    const db = opsDb({
      ...LIFECYCLE, record_ops_step: 'recorded',
      workflow_definition: [{ definition: def, saved_at: '2026-10-17T09:00:00Z', variables: { values: { API_BASE: 'kept-at-save' }, secret_keys: [] } }],
    })
    expect(await runDispatched(env(gateway), await signed({ kind: 'run', run: RUN }), deps(db.fetch))).toMatchObject({ outcome: 'completed' })
    expect(asked).toEqual([])
    expect(db.calls.find((c) => c.name === 'record_ops_step')?.body).toMatchObject({ p_status: 'completed', p_output: { base: 'kept-at-save' } })
  })

  it('freezes the variables served with a version it fetches, and runs on them (#2702)', async () => {
    const def = { nodes: [{ id: 'shape', namespace: 'shape', type: 'transform', config: { mappings: [{ source: 'env.API_BASE', target: 'base' }] } }], edges: [{ id: 'e0', source: 'trigger', target: 'shape' }] }
    const variables = { values: { API_BASE: 'served' }, secret_keys: [] }
    const gateway = { opsWorkflowDefinitions: async () => ({ definitions: [{ workflow_id: WF, organization_id: ORG, version_number: 3, definition: def, variables }], unserved: [] }) }
    const db = opsDb({ ...LIFECYCLE, workflow_definition: [], record_ops_step: 'recorded' })
    expect(await runDispatched(env(gateway), await signed({ kind: 'run', run: RUN }), deps(db.fetch))).toMatchObject({ outcome: 'completed' })
    expect(db.calls.find((c) => c.name === 'save_workflow_definition')?.body).toMatchObject({ p_variables: variables })
    expect(db.calls.find((c) => c.name === 'record_ops_step')?.body).toMatchObject({ p_output: { base: 'served' } })
  })

  it('a run of a version holding a secret variable ends failed by name, before any step (#2702)', async () => {
    const def = { nodes: [{ id: 'shape', namespace: 'shape', type: 'transform', config: { mappings: [{ source: 'env.TOKEN', target: 't' }] } }], edges: [{ id: 'e0', source: 'trigger', target: 'shape' }] }
    const db = opsDb({
      ...LIFECYCLE, record_ops_step: 'recorded',
      workflow_definition: [{ definition: def, saved_at: '2026-10-17T09:00:00Z', variables: { values: {}, secret_keys: ['TOKEN'] } }],
    })
    await runDispatched(env(), await signed({ kind: 'run', run: RUN }), deps(db.fetch))
    expect(db.names()).not.toContain('record_ops_step')
    expect(String(db.calls.find((c) => c.name === 'complete_run_request')?.body.p_error)).toMatch(/secret variable env\.TOKEN.*connection/)
  })

  it('a definition it cannot have returns the run to the queue a minute on, without starting it', async () => {
    const gateway = { opsWorkflowDefinitions: async () => { throw new Error('the bidding Worker did not answer') } }
    const db = opsDb({ ...LIFECYCLE, workflow_definition: [], complete_run_request: [{ outcome: 'completed', run_status: 'queued', state_version: 3 }] })
    const report = await runDispatched(env(gateway), await signed({ kind: 'run', run: RUN }), deps(db.fetch))
    expect(db.names()).not.toContain('start_run_execution')
    const complete = db.calls.find((c) => c.name === 'complete_run_request')
    expect(complete?.body).toMatchObject({ p_outcome: 'retry', p_not_before: new Date(NOW + RUN_DEFINITION_RETRY_MS).toISOString() })
    expect(String(complete?.body.p_error)).toMatch(/definition/)
    expect(report).toMatchObject({ outcome: 'definition_unavailable' })
  })

  it('answers a value, never a throw, when the ops database is not configured or the retry cannot be recorded', async () => {
    const db = opsDb(LIFECYCLE)
    const unconfigured = await runDispatched({ ...env(), OPS_SUPABASE_SECRET_KEY: '' } as OpsEnv, await signed({ kind: 'run', run: RUN }), deps(db.fetch))
    expect(unconfigured).toMatchObject({ refused: expect.stringMatching(/^ops_database_not_configured/) })
    expect(db.calls).toEqual([])

    const gateway = { opsWorkflowDefinitions: async () => { throw new Error('the bidding Worker did not answer') } }
    const { complete_run_request: _unanswered, ...noComplete } = LIFECYCLE
    const down = opsDb({ ...noComplete, workflow_definition: [] })
    const report = await runDispatched(env(gateway), await signed({ kind: 'run', run: RUN }), deps(down.fetch))
    expect(down.names()).toContain('complete_run_request')
    expect(down.names()).not.toContain('start_run_execution')
    // Not started, so the lapsed lease is swept back to the queue; the tick counts it by this answer.
    expect(report).toMatchObject({ outcome: 'complete_failed', end: { outcome: 'retry' }, error: expect.stringMatching(/definition/) })
  })
})

describe('OpsInternal.run: time sliced continuation (#1951)', () => {
  const three = {
    nodes: ['a', 'b', 'c'].map((id) => ({ id, namespace: id, type: 'transform', config: { mappings: [{ source: 'trigger.payload.amount', target: 'amount' }] } })),
    edges: [{ id: 'e0', source: 'trigger', target: 'a' }, { id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'c' }],
  }
  const oneStepSlices = { ...CONTINUATION_BUDGET, sliceSteps: 1 }

  /** A bucket with R2's put only where nothing is, holding what was written. */
  function bucket() {
    const objects = new Map<string, string>()
    return {
      objects,
      binding: {
        put: async (key: string, body: string) => {
          if (objects.has(key)) return null
          objects.set(key, body)
          return { key }
        },
        get: async (key: string) => (objects.has(key) ? { text: async () => objects.get(key)! } : null),
      } as unknown as R2Bucket,
    }
  }

  /** The database's named checkpoint: record_run_checkpoint stores it, run_checkpoint answers it. */
  function namingDb() {
    let named: Record<string, unknown> | null = null
    return opsDb({
      ...LIFECYCLE,
      workflow_definition: [{ definition: three, saved_at: '2026-10-17T09:00:00Z' }],
      record_ops_step: 'recorded',
      record_run_checkpoint: (b: Record<string, unknown>) => { named = b; return 'recorded' },
      run_checkpoint: () => [{
        state_version: 3,
        checkpoint_key: named?.p_checkpoint_key ?? null, checkpoint_state_version: named?.p_state_version ?? null, checkpoint_steps: named?.p_steps ?? null,
        checkpoint_sha256: named?.p_sha256 ?? null, checkpoint_bytes: named?.p_bytes ?? null, checkpoint_execution_id: named?.p_execution_id ?? null,
        checkpoint_at: named === null ? null : '2026-10-17T10:02:32Z',
      }],
    })
  }

  it('in observe mode writes each boundary\'s checkpoint to OPS_CHECKPOINTS and names it under the state version the start answered, and the run ends as it would', async () => {
    const db = namingDb()
    const b = bucket()
    const report = await runDispatched({ ...env(), OPS_CONTINUATION: 'observe', OPS_CHECKPOINTS: b.binding } as OpsEnv,
      await signed({ kind: 'run', run: { ...RUN, payload: { amount: 7 } } }), { ...deps(db.fetch), continuationBudget: oneStepSlices })
    expect(report).toMatchObject({ outcome: 'completed' })
    const names = db.calls.filter((c) => c.name === 'record_run_checkpoint')
    expect(names.map((c) => c.body.p_steps)).toEqual([1, 2])
    expect(names[0].body).toMatchObject({ p_organization_id: ORG, p_claim_token: RUN.claimToken, p_execution_id: '0192f4a0-0000-7000-8000-0000000000ee', p_state_version: 3 })
    expect([...b.objects.keys()]).toEqual([`checkpoints/v1/${ORG}/${RUN.runRequestId}/3-1.json`, `checkpoints/v1/${ORG}/${RUN.runRequestId}/3-2.json`])
    expect(db.names().filter((n) => n === 'record_ops_step')).toHaveLength(3)
  })

  it('off (unset) writes and names nothing, whatever the budget', async () => {
    const db = namingDb()
    const b = bucket()
    await runDispatched({ ...env(), OPS_CHECKPOINTS: b.binding } as OpsEnv, await signed({ kind: 'run', run: RUN }), { ...deps(db.fetch), continuationBudget: oneStepSlices })
    expect(db.names()).not.toContain('record_run_checkpoint')
    expect(b.objects.size).toBe(0)
  })

  it('in observe mode without the OPS_CHECKPOINTS binding, logs it by name and the run still completes', async () => {
    const db = namingDb()
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)) })
    try {
      const report = await runDispatched({ ...env(), OPS_CONTINUATION: 'observe' } as OpsEnv, await signed({ kind: 'run', run: RUN }), { ...deps(db.fetch), continuationBudget: oneStepSlices })
      expect(report).toMatchObject({ outcome: 'completed' })
    } finally {
      spy.mockRestore()
    }
    expect(db.names()).not.toContain('record_run_checkpoint')
    expect(lines.filter((l) => l.includes('"observe_failed"') && l.includes('"store_missing"') && l.includes('OPS_CHECKPOINTS'))).toHaveLength(1)
  })
})
