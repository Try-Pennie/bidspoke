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
import { encryptSecret } from '../../../lib/secret-crypto'
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

// #3002 (phase 6 of #2982; Dan, 2026-10-28: "It should always read the current
// version of the variable", and 2026-10-29: "Yes, ops reads secrets"): a step
// test is given the CURRENT value of each variable the step reads, resolved over
// the organization's saved rows by the one resolver, each secret decrypted here.
// Never the newest saved version's kept copy, and no fallback copy: a failed
// read refuses the test (503), and a secret that will not decrypt refuses it by
// name, never sent blank.
describe('POST test-node: the current variables an ops step test is given (#3002)', () => {
  const KEY = btoa('0'.repeat(32))
  const WRONG_KEY = btoa('1'.repeat(32))
  const OTHER_ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f61'
  const readsEnv = { ...appStep, config: { ...appStep.config, args: { text: 'to {{env.API_BASE}} as {{env.TOKEN}}' } } }
  const envDefinition = { ...definition, nodes: [readsEnv] }
  let seq = 0
  const row = (key: string, value: string, over: Record<string, unknown> = {}) => ({
    id: `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`, organization_id: ORG, key, value, is_secret: false, scope: 'global', workflow_id: null, ...over,
  })
  /** The organization's saved rows, in saved order, and a saved version, which must never be read. */
  const withRows = (variables: { list?: Record<string, unknown>[]; listError?: { message: string; code?: string } }) => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: { single: { id: WF, lane: 'ops' } },
      environment_variables: variables,
      workflow_versions: { list: [{ version_number: 7, definition: envDefinition }] },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    return sb
  }
  const test = (ops: ReturnType<typeof opsBinding>, body: Record<string, unknown> = { namespace: 'notify', definition: envDefinition, confirm_send: true }) =>
    call('POST', `/workflows/${WF}/test-node`, { OPS_CONNECTIONS: ops.binding, SECRET_ENCRYPTION_KEY: KEY } as never, body)

  it('gives the step the current value of each variable it reads after a change, never reading a saved version', async () => {
    const token = await encryptSecret('tok-live-value', KEY)
    const sb = withRows({ list: [
      row('API_BASE', 'https://changed-once.example.test'),
      // The later saved row at one level wins: the value as it is now.
      row('API_BASE', 'https://current.example.test'),
      row('TOKEN', token, { is_secret: true }),
      row('UNREAD', 'not read by this step'),
    ] })
    const ops = opsBinding({ testStep: { ok: true, recorded: true, result: view } })
    const res = await test(ops)
    expect(res.status).toBe(200)
    const sent = ops.calls[0].request as Record<string, unknown>
    expect(sent.variables).toEqual({ values: { API_BASE: 'https://current.example.test' }, secret_values: { TOKEN: 'tok-live-value' } })
    expect(Object.keys(sent)).not.toContain('version')
    expect(sb.calls.workflow_versions).toBeUndefined()
    // Read for the caller's organization alone, the names the step reads, in saved order.
    const calls = sb.calls.environment_variables ?? []
    expect(calls).toContainEqual(['eq', ['organization_id', ORG]])
    expect(calls).toContainEqual(['in', ['key', ['API_BASE', 'TOKEN']]])
    expect(calls).toContainEqual(['order', ['created_at', { ascending: true }]])
  })

  it('decrypts a secret the step reads and gives it to the step; the ciphertext never leaves, nor a row of another organization', async () => {
    const token = await encryptSecret('tok-live-value', KEY)
    withRows({ list: [row('API_BASE', 'https://current.example.test'), row('TOKEN', token, { is_secret: true }), row('TOKEN', 'theirs', { organization_id: OTHER_ORG })] })
    const ops = opsBinding({ testStep: { ok: true, recorded: true, result: view } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await test(ops)
    expect((ops.calls[0].request as { variables: unknown }).variables).toEqual({ values: { API_BASE: 'https://current.example.test' }, secret_values: { TOKEN: 'tok-live-value' } })
    expect(JSON.stringify(ops.calls[0].request)).not.toContain(token)
    expect(JSON.stringify(ops.calls[0].request)).not.toContain('theirs')
  })

  it('leaves out a variable with no saved value, so ops names it missing', async () => {
    withRows({ list: [row('API_BASE', 'https://current.example.test')] })
    const ops = opsBinding({ testStep: { ok: true, recorded: true, result: view } })
    await test(ops)
    expect((ops.calls[0].request as { variables: unknown }).variables).toEqual({ values: { API_BASE: 'https://current.example.test' }, secret_values: {} })
  })

  it('a step reading no variable never reads them', async () => {
    const sb = withRows({ listError: { message: 'must not be read' } })
    const ops = opsBinding({ testStep: { ok: true, recorded: true, result: view } })
    const res = await test(ops, { namespace: 'notify', definition, confirm_send: true })
    expect(res.status).toBe(200)
    expect(sb.calls.environment_variables).toBeUndefined()
    expect(Object.keys(ops.calls[0].request as object)).not.toContain('variables')
  })

  it('sends nothing when the variables cannot be read, saying so', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    withRows({ listError: { message: 'the database is not answering', code: 'PGRST000' } })
    const ops = opsBinding({ testStep: { ok: true, recorded: true, result: view } })
    const res = await test(ops)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'step_test_variables_unavailable', message: expect.stringContaining('Nothing was sent') })
    expect(ops.calls).toEqual([])
  })

  it('refuses by name a secret that will not decrypt, never sending it blank, and logs no value', async () => {
    const token = await encryptSecret('tok-live-value', WRONG_KEY)
    withRows({ list: [row('API_BASE', 'https://current.example.test'), row('TOKEN', token, { is_secret: true })] })
    const ops = opsBinding({ testStep: { ok: true, recorded: true, result: view } })
    const lines: unknown[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args) })
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(args) })
    const res = await test(ops)
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; message: string }
    expect(body.error).toBe('step_test_secret_unreadable')
    expect(body.message).toContain('env.TOKEN')
    expect(body.message).toContain('Nothing was sent')
    expect(ops.calls).toEqual([])
    expect(JSON.stringify(lines)).not.toContain(token)
    expect(JSON.stringify(body)).not.toContain(token)
  })

  it('words ops\'s refusal of a step reading a missing variable as the sentence ops gave', async () => {
    withRows({ list: [row('API_BASE', 'https://current.example.test')] })
    const detail = 'this step reads env.TOKEN, which has no saved value for this workflow, so nothing was sent; add it on the environment variables page and test again'
    const ops = opsBinding({ testStep: { ok: false, refused: 'step_test_variable_unavailable', detail, retry_at: null } })
    const res = await test(ops)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'step_test_variable_unavailable',
      message: 'This step reads env.TOKEN, which has no saved value for this workflow, so nothing was sent; add it on the environment variables page and test again.',
    })
  })
})
