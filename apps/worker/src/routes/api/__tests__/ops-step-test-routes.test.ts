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
  output: { ok: true, ts: '1729.1' }, output_bytes: 27, output_dropped: false, error: null, requests: [{ method: 'POST', url: 'https://slack.com/api/chat.postMessage' }], duration_ms: 310,
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

  it('passes through whether the answer was dropped for size, so an action that answered nothing never reads as one (#2773)', async () => {
    const nothing = { ...view, output: null, output_bytes: null, output_dropped: false }
    const dropped = { ...view, output: null, output_bytes: 200_000, output_dropped: true }
    for (const result of [nothing, dropped]) {
      withWorkflow({ id: WF, lane: 'ops' })
      const ops = opsBinding({ testStep: { ok: true, recorded: true, result }, stepTestResult: { ok: true, result } })
      const posted = await call('POST', `/workflows/${WF}/test-node`, { OPS_CONNECTIONS: ops.binding } as never, {
        namespace: 'notify', definition, trigger_payload: {}, steps: {}, confirm_send: true,
      })
      expect(await posted.json()).toMatchObject({ output: null, output_bytes: result.output_bytes, output_dropped: result.output_dropped })
      withWorkflow({ id: WF, lane: 'ops' })
      const read = await call('GET', `/workflows/${WF}/test-results/node_1`, { OPS_CONNECTIONS: ops.binding } as never)
      expect((await read.json() as { result: unknown }).result).toMatchObject({ output: null, output_bytes: result.output_bytes, output_dropped: result.output_dropped })
    }
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

  // #2703: a run's steps are recorded on ops, so a step is tested with a past run's data there.
  it('forwards a test from a past run to ops with the run\'s id, leaving its payload and steps to the run unless the browser gave its own', async () => {
    withWorkflow({ id: WF, lane: 'ops' })
    const EXEC = '0199f0a0-0000-7000-8000-0000000000e1'
    const ops = opsBinding({ testStep: { ok: true, recorded: true, result: view } })
    const res = await call('POST', `/workflows/${WF}/test-node`, { OPS_CONNECTIONS: ops.binding } as never, { namespace: 'notify', definition, execution_id: EXEC, confirm_send: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'completed', output: { ok: true, ts: '1729.1' } })
    expect(ops.calls).toEqual([{
      method: 'testStep',
      request: {
        organization_id: ORG, workflow_id: WF, tested_by: DAN, execution_id: EXEC,
        node: { id: 'node_1', namespace: 'notify', config: { ...appStep.config, boundBy: DAN } }, confirm_send: true,
      },
    }])

    const given = opsBinding({ testStep: { ok: true, recorded: true, result: view } })
    await call('POST', `/workflows/${WF}/test-node`, { OPS_CONNECTIONS: given.binding } as never, {
      namespace: 'notify', definition, execution_id: EXEC, trigger_payload: { name: 'Ada' }, steps: { earlier: { output: 1, status: 'completed' } },
    })
    expect(given.calls[0].request).toMatchObject({ execution_id: EXEC, trigger_payload: { name: 'Ada' }, steps: { earlier: { output: 1, status: 'completed' } } })
  })

  it('refuses an execution id that is not one, before calling ops', async () => {
    withWorkflow({ id: WF, lane: 'ops' })
    const ops = opsBinding({ testStep: { ok: true, recorded: true, result: view } })
    const res = await call('POST', `/workflows/${WF}/test-node`, { OPS_CONNECTIONS: ops.binding } as never, { namespace: 'notify', definition, execution_id: 'exec-1' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'execution_id_invalid', message: expect.stringContaining('Nothing was sent') })
    expect(ops.calls).toEqual([])
  })

  it('words each refusal of a test from a past run, saying nothing was sent', async () => {
    const cases: Array<[string, number]> = [
      ['step_test_run_not_found', 404],
      ['step_test_run_records_gone', 410],
      ['step_test_run_steps_missing', 409],
      ['step_test_run_output_not_kept', 409],
      ['step_test_run_payload_not_held', 409],
      ['step_test_run_unavailable', 503],
    ]
    for (const [refused, status] of cases) {
      withWorkflow({ id: WF, lane: 'ops' })
      const ops = opsBinding({ testStep: { ok: false, refused, detail: 'the run recorded no earlier, which it reads, so nothing was sent', retry_at: null } })
      const res = await call('POST', `/workflows/${WF}/test-node`, { OPS_CONNECTIONS: ops.binding } as never, { namespace: 'notify', definition, execution_id: '0199f0a0-0000-7000-8000-0000000000e1' })
      expect(res.status, refused).toBe(status)
      const body = await res.json() as { error: string; message: string }
      expect(body.error, refused).toBe(refused)
      expect(body.message, refused).toMatch(/Nothing was sent\./)
    }
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

// #2702: a step test is given the plain values the workflow's newest saved
// version kept, as a run of it would be, and ops refuses by name a step reading
// a secret variable or one that version did not keep.
describe('POST test-node: the variables an ops step test is given (#2702)', () => {
  const readsEnv = { ...appStep, config: { ...appStep.config, args: { text: 'to {{env.API_BASE}}' } } }
  const envDefinition = { ...definition, nodes: [readsEnv] }
  const capture = [
    { key: 'API_BASE', value: 'https://hooks.example.test', is_secret: false, scope: 'global', workflow_id: null },
    { key: 'UNREAD', value: 'kept but not read by this step', is_secret: false, scope: 'global', workflow_id: null },
  ]
  const withVersions = (versions: { list?: Record<string, unknown>[]; listError?: { message: string; code?: string } }) => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { id: WF, lane: 'ops' } }, workflow_versions: versions })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    return sb
  }

  it('sends the values the newest saved version kept that the step reads, with that version\'s number', async () => {
    const sb = withVersions({ list: [{ version_number: 7, env_capture: capture }] })
    const ops = opsBinding({ testStep: { ok: true, recorded: true, result: view } })
    const res = await call('POST', `/workflows/${WF}/test-node`, { OPS_CONNECTIONS: ops.binding } as never, { namespace: 'notify', definition: envDefinition, confirm_send: true })
    expect(res.status).toBe(200)
    expect((ops.calls[0].request as { version: unknown }).version).toEqual({ number: 7, variables: { values: { API_BASE: 'https://hooks.example.test' }, secret_keys: [] } })
    const calls = sb.calls.workflow_versions ?? []
    expect(calls).toContainEqual(['eq', ['workflow_id', WF]])
    expect(calls).toContainEqual(['order', ['version_number', { ascending: false }]])
  })

  it('names no version when the workflow has none, or one saved before its variables were kept', async () => {
    for (const [list, sent] of [[[], null], [[{ version_number: 3, env_capture: null }], { number: 3, variables: null }]] as const) {
      withVersions({ list: [...list] })
      const ops = opsBinding({ testStep: { ok: true, recorded: true, result: view } })
      await call('POST', `/workflows/${WF}/test-node`, { OPS_CONNECTIONS: ops.binding } as never, { namespace: 'notify', definition: envDefinition, confirm_send: true })
      expect((ops.calls[0].request as { version: unknown }).version).toEqual(sent)
    }
  })

  it('a step reading no variable never reads the versions', async () => {
    const sb = withVersions({ listError: { message: 'must not be read' } })
    const ops = opsBinding({ testStep: { ok: true, recorded: true, result: view } })
    const res = await call('POST', `/workflows/${WF}/test-node`, { OPS_CONNECTIONS: ops.binding } as never, { namespace: 'notify', definition, confirm_send: true })
    expect(res.status).toBe(200)
    expect(sb.calls.workflow_versions).toBeUndefined()
    expect(Object.keys(ops.calls[0].request as object)).not.toContain('version')
  })

  it('sends nothing when the saved variables cannot be read, saying so', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    withVersions({ listError: { message: 'the database is not answering', code: 'PGRST000' } })
    const ops = opsBinding({ testStep: { ok: true, recorded: true, result: view } })
    const res = await call('POST', `/workflows/${WF}/test-node`, { OPS_CONNECTIONS: ops.binding } as never, { namespace: 'notify', definition: envDefinition, confirm_send: true })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'step_test_variables_unavailable', message: expect.stringContaining('Nothing was sent') })
    expect(ops.calls).toEqual([])
  })

  it('words ops\'s refusal of a step reading a secret or missing variable as the sentence ops gave', async () => {
    withVersions({ list: [{ version_number: 7, env_capture: capture }] })
    const detail = 'this step reads the secret variable env.TOKEN, and an ops step is never given a secret: a credential belongs in a connection, so nothing was sent'
    const ops = opsBinding({ testStep: { ok: false, refused: 'step_test_variable_unavailable', detail, retry_at: null } })
    const res = await call('POST', `/workflows/${WF}/test-node`, { OPS_CONNECTIONS: ops.binding } as never, { namespace: 'notify', definition: envDefinition, confirm_send: true })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'step_test_variable_unavailable',
      message: 'This step reads the secret variable env.TOKEN, and an ops step is never given a secret: a credential belongs in a connection, so nothing was sent.',
    })
  })
})
