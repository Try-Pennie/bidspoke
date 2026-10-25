/**
 * Testing an ops workflow's app_action step (#2339): POST test-node forwards to
 * the ops Worker's testStep through OPS_CONNECTIONS, and GET test-results reads
 * the kept result back for the data picker. The result lives on ops alone (Dan,
 * 2026-10-23); the bidding Worker writes nothing.
 *
 * Who may test: the caller's organization's workflow, found by its id and the
 * organization from the verified JWT, and the step is stamped as bound by the
 * caller, so a person's own account is tested only by its owner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../engine/definition-loader')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/github')
vi.mock('../../../lib/github-backup-alert')
vi.mock('../../../lib/archive-read')
vi.mock('../../../lib/env-loader')
vi.mock('../../../lib/code-node-deployer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/code-node-deployer')>()),
  deployCodeNodes: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../../engine/nodes/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../engine/nodes/index')>()),
  executeNode: vi.fn().mockResolvedValue({ output: { ran: true } }),
}))

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { executeNode } from '../../../engine/nodes/index'
import { makeSupabase } from './_supabase-mock'
import api from '../index'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const DAN = '0199f0a0-0000-7000-8000-0000000000d1'
const WF = '0199f0a0-0000-7000-8000-0000000000aa'
const CONN = '0199f0a0-0000-7000-8000-000000000001'
const testUser = { id: DAN, organization_id: ORG, email: 'dan@pennie.com' }
const validPayload = { sub: DAN, email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const mockCtx = recordingContext()

const appStep = { id: 'node_1', namespace: 'notify', type: 'app_action', config: { service: 'slack', action: 'slack.send-message', actionVersion: 1, connection: CONN, args: { text: 'hi' }, boundBy: 'someone-else' } }
const definition = { nodes: [appStep, { id: 'n2', namespace: 'n2', type: 'code', config: { script: 'return 1' } }], edges: [], trigger: { type: 'schedule', config: {} } }

const view = {
  node_id: 'node_1', namespace: 'notify', tested_by: DAN, tested_at: '2026-10-23T14:00:01.000Z', status: 'completed',
  output: { ok: true, ts: '1729.1' }, output_bytes: 27, error: null, requests: [{ method: 'POST', url: 'https://slack.com/api/chat.postMessage' }], duration_ms: 310,
}

function opsBinding(answers: Record<string, unknown>) {
  const calls: Array<{ method: string; request: unknown }> = []
  const methods: Record<string, (r: unknown) => Promise<unknown>> = {}
  for (const [method, answer] of Object.entries(answers)) {
    methods[method] = async (request) => {
      calls.push({ method, request })
      if (answer instanceof Error) throw answer
      return answer
    }
  }
  return { binding: methods, calls }
}

function withWorkflow(workflow: Record<string, unknown> | null) {
  vi.mocked(createSupabaseClient).mockReturnValue(
    makeSupabase({ users: { single: testUser }, workflows: { single: workflow } }) as unknown as ReturnType<typeof createSupabaseClient>,
  )
}

async function call(method: 'POST' | 'GET', path: string, env: Partial<Env>, body?: unknown): Promise<Response> {
  return await api.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {}, APP_URL: 'https://app.test', ...env } as unknown as Env, mockCtx)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload)
})

describe('POST test-node for an ops workflow\'s app_action step', () => {
  it('forwards the step to ops with the caller\'s organization and the caller as its binder, and answers the kept result with its picker rows', async () => {
    withWorkflow({ id: WF, lane: 'ops' })
    const ops = opsBinding({ testStep: { ok: true, recorded: true, result: view } })
    const res = await call('POST', `/workflows/${WF}/test-node`, { OPS_CONNECTIONS: ops.binding } as never, {
      namespace: 'notify', definition, trigger_payload: { name: 'Ada' }, steps: { earlier: { output: { a: 1 }, status: 'completed' } }, confirm_send: true,
    })
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json).toMatchObject({ status: 'completed', output: { ok: true, ts: '1729.1' }, error_message: null, duration_ms: 310, tested_at: view.tested_at, recorded: true })
    expect(json.rows).toContainEqual({ label: 'Ts', path: 'steps.notify.output.ts', sample: '1729.1' })
    expect(ops.calls).toEqual([{
      method: 'testStep',
      request: {
        organization_id: ORG, workflow_id: WF, tested_by: DAN,
        // A boundBy the browser sent is never kept: the person testing is the binder.
        node: { id: 'node_1', namespace: 'notify', config: { ...appStep.config, boundBy: DAN } },
        trigger_payload: { name: 'Ada' }, steps: { earlier: { output: { a: 1 }, status: 'completed' } }, confirm_send: true,
      },
    }])
    expect(executeNode).not.toHaveBeenCalled()
  })

  it('a send the person has not confirmed is refused by name, saying nothing was sent', async () => {
    withWorkflow({ id: WF, lane: 'ops' })
    const ops = opsBinding({ testStep: { ok: false, refused: 'step_test_send_unconfirmed', detail: 'slack.send-message changes something', retry_at: null } })
    const res = await call('POST', `/workflows/${WF}/test-node`, { OPS_CONNECTIONS: ops.binding } as never, { namespace: 'notify', definition })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'step_test_send_unconfirmed', message: expect.stringContaining('Nothing was sent') })
    expect((ops.calls[0].request as { confirm_send: boolean }).confirm_send).toBe(false)
  })

  it('ops that does not answer is named as unavailable', async () => {
    withWorkflow({ id: WF, lane: 'ops' })
    const res = await call('POST', `/workflows/${WF}/test-node`, {} as never, { namespace: 'notify', definition })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'ops_connections_unavailable', cause: 'binding_absent' })
  })

  it('refuses a test built from a run, whose history ops keeps, before calling ops', async () => {
    withWorkflow({ id: WF, lane: 'ops' })
    const ops = opsBinding({ testStep: { ok: true, recorded: true, result: view } })
    const res = await call('POST', `/workflows/${WF}/test-node`, { OPS_CONNECTIONS: ops.binding } as never, { namespace: 'notify', definition, execution_id: 'exec-1' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'step_test_from_run_unsupported' })
    expect(ops.calls).toEqual([])
  })

  it('another organization\'s workflow is not found, and ops is never called', async () => {
    withWorkflow(null)
    const ops = opsBinding({ testStep: { ok: true, recorded: true, result: view } })
    const res = await call('POST', `/workflows/${WF}/test-node`, { OPS_CONNECTIONS: ops.binding } as never, { namespace: 'notify', definition })
    expect(res.status).toBe(404)
    expect(ops.calls).toEqual([])
  })

  it('any other step of an ops workflow is still refused for its lane, as before', async () => {
    withWorkflow({ id: WF, lane: 'ops' })
    const ops = opsBinding({ testStep: { ok: true, recorded: true, result: view } })
    const res = await call('POST', `/workflows/${WF}/test-node`, { OPS_CONNECTIONS: ops.binding } as never, { namespace: 'n2', definition })
    expect(res.status).toBe(421)
    expect(ops.calls).toEqual([])
  })
})

describe('GET test-results for an ops workflow\'s step', () => {
  it('reads the organization\'s kept result through ops, with its picker rows', async () => {
    withWorkflow({ id: WF, lane: 'ops' })
    const ops = opsBinding({ stepTestResult: { ok: true, result: view } })
    const res = await call('GET', `/workflows/${WF}/test-results/node_1`, { OPS_CONNECTIONS: ops.binding } as never)
    expect(res.status).toBe(200)
    const json = await res.json() as { result: Record<string, unknown> }
    expect(json.result).toMatchObject({ status: 'completed', tested_at: view.tested_at, rows_truncated: false })
    expect(json.result.rows).toContainEqual({ label: 'Ok', path: 'steps.notify.output.ok', sample: 'true' })
    expect(ops.calls).toEqual([{ method: 'stepTestResult', request: { organization_id: ORG, workflow_id: WF, node_id: 'node_1' } }])
  })

  it('answers no result once there is none under 7 days old, so the picker asks for a fresh test', async () => {
    withWorkflow({ id: WF, lane: 'ops' })
    const ops = opsBinding({ stepTestResult: { ok: true, result: null } })
    const res = await call('GET', `/workflows/${WF}/test-results/node_1`, { OPS_CONNECTIONS: ops.binding } as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: null })
  })

  it('a read ops could not make is named, never answered as no result', async () => {
    withWorkflow({ id: WF, lane: 'ops' })
    const ops = opsBinding({ stepTestResult: { ok: false, refused: 'step_test_unavailable', detail: 'could not be read', retry_at: null } })
    const res = await call('GET', `/workflows/${WF}/test-results/node_1`, { OPS_CONNECTIONS: ops.binding } as never)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'step_test_unavailable' })
  })

  it('another organization\'s workflow is not found, and a money workflow keeps no such results', async () => {
    const ops = opsBinding({ stepTestResult: { ok: true, result: view } })
    withWorkflow(null)
    expect((await call('GET', `/workflows/${WF}/test-results/node_1`, { OPS_CONNECTIONS: ops.binding } as never)).status).toBe(404)
    withWorkflow({ id: WF, lane: 'money' })
    expect((await call('GET', `/workflows/${WF}/test-results/node_1`, { OPS_CONNECTIONS: ops.binding } as never)).status).toBe(422)
    expect(ops.calls).toEqual([])
  })
})
