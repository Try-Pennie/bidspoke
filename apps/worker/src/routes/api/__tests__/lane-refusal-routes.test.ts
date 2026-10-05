/**
 * A run refused for its lane answers by name on every dashboard route that
 * starts one (#1725): test, test-node, resume and replay.
 *
 * The engine refuses a workflow stored under another lane (WorkflowLaneError)
 * and a definition carrying a node its lane cannot run (LaneRefusedNodeError)
 * before anything is recorded (#1707). The public webhook routes already answer
 * 421 for the first; the dashboard routes let both fall through to the generic
 * 500, so the person who pressed Test, Resume or Replay was told "Internal
 * server error" for a run that was refused on purpose. They now answer the same
 * 421 the public routes use, or 422 for a step the lane cannot run, with a
 * sentence saying what is wrong and that nothing ran.
 *
 * The two routes that do work of their own before the engine (test deploys a
 * test bundle, test-node deploys code and runs a node with no engine around it)
 * refuse a workflow stored under another lane from the row they already read,
 * before that work.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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
  deployTestCodeBundle: vi.fn().mockResolvedValue({ bundleName: 'test-bundle' }),
}))
// The engine run is replaced; the lane errors, the runtime and the lane
// resolver stay real, so the routes are seen mapping the genuine classes.
vi.mock('../../../engine/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../engine/index')>()),
  executeWorkflow: vi.fn(),
}))
// The money lane's node executor, which test-node reaches through the resolver.
vi.mock('../../../engine/nodes/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../engine/nodes/index')>()),
  executeNode: vi.fn().mockResolvedValue({ output: { ran: true } }),
}))

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { loadEnvVars } from '../../../lib/env-loader'
import { deployCodeNodes, deployTestCodeBundle } from '../../../lib/code-node-deployer'
import { executeWorkflow, WorkflowLaneError, LaneRefusedNodeError } from '../../../engine/index'
import { executeNode } from '../../../engine/nodes/index'
import { makeSupabase } from './_supabase-mock'

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {}, APP_URL: 'https://app.test' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

const WRONG_LANE_MESSAGE = 'This workflow is stored as an ops workflow, and this server runs only money workflows. Nothing was run and no execution was recorded.'
const REFUSED_STEP_MESSAGE = 'This workflow has a step of type partner_bid, which ops workflows cannot run. Nothing was run and no execution was recorded.'

const definition = {
  nodes: [{ id: 'n1', namespace: 'n1', type: 'code', config: { script: 'return 1' } }],
  edges: [],
  trigger: { type: 'http_webhook', config: {} },
}

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

async function post(app: Awaited<ReturnType<typeof makeApp>>, path: string, body?: unknown): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, testEnv, mockCtx)
}

function withRows(workflow: Record<string, unknown>) {
  vi.mocked(createSupabaseClient).mockReturnValue(
    makeSupabase({
      users: { single: testUser },
      workflows: { single: workflow },
      workflow_executions: { single: { workflow_id: 'wf-1', trigger_payload: { lead: 'L-1' }, source: 'engine' } },
      execution_steps: { list: [] },
    }) as unknown as ReturnType<typeof createSupabaseClient>,
  )
}

let app: Awaited<ReturnType<typeof makeApp>>

beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload)
  vi.mocked(loadEnvVars).mockResolvedValue({})
  vi.mocked(executeNode).mockResolvedValue({ output: { ran: true } })
  app = await makeApp()
})

describe.each([
  ['test', '/workflows/wf-1/test', { payload: {} }],
  ['resume', '/executions/exec-1/resume', undefined],
  ['replay', '/executions/exec-1/replay', undefined],
] as const)('POST %s when the engine refuses the run for its lane', (_name, path, body) => {
  it('answers 421 with a sentence saying the workflow is in another lane', async () => {
    withRows({ id: 'wf-1', lane: 'money' })
    vi.mocked(executeWorkflow).mockRejectedValue(new WorkflowLaneError('wf-1', 'ops', 'money'))
    const res = await post(app, path, body)
    expect(res.status).toBe(421)
    expect(await res.json()).toEqual({ error: WRONG_LANE_MESSAGE })
  })

  it('answers 422 with a sentence naming the step the lane cannot run', async () => {
    withRows({ id: 'wf-1', lane: 'money' })
    vi.mocked(executeWorkflow).mockRejectedValue(new LaneRefusedNodeError('partner_bid', 'ops'))
    const res = await post(app, path, body)
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: REFUSED_STEP_MESSAGE })
  })

  it('still leaves any other engine error to the generic 500, telling the caller nothing internal', async () => {
    withRows({ id: 'wf-1', lane: 'money' })
    vi.mocked(executeWorkflow).mockRejectedValue(new Error('relation workflows does not exist'))
    const res = await post(app, path, body)
    // The root app's genericOnError writes the body in production; mounted alone
    // here the sub app answers with the framework's own 500.
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('relation workflows')
  })
})

describe('POST test refuses a workflow stored under another lane before deploying anything', () => {
  it('answers 421 and neither deploys a test bundle nor starts the engine', async () => {
    withRows({ id: 'wf-1', lane: 'ops' })
    const res = await post(app, '/workflows/wf-1/test', { payload: {}, definition })
    expect(res.status).toBe(421)
    expect(await res.json()).toEqual({ error: WRONG_LANE_MESSAGE })
    expect(deployTestCodeBundle).not.toHaveBeenCalled()
    expect(executeWorkflow).not.toHaveBeenCalled()
  })

  it('refuses a stored lane it does not know rather than running it', async () => {
    withRows({ id: 'wf-1', lane: 'sideways' })
    const res = await post(app, '/workflows/wf-1/test', { payload: {}, definition })
    expect(res.status).toBe(500)
    expect(deployTestCodeBundle).not.toHaveBeenCalled()
    expect(executeWorkflow).not.toHaveBeenCalled()
  })

  it('deploys and runs a money workflow as before (control)', async () => {
    withRows({ id: 'wf-1', lane: 'money' })
    vi.mocked(executeWorkflow).mockResolvedValue({ executionId: 'e', response: { ok: true }, status: 200, traceId: 't' })
    const res = await post(app, '/workflows/wf-1/test', { payload: {}, definition })
    expect(res.status).toBe(200)
    expect(deployTestCodeBundle).toHaveBeenCalledTimes(1)
    expect(executeWorkflow).toHaveBeenCalledTimes(1)
  })
})

describe('POST test-node refuses a workflow stored under another lane before deploying or running', () => {
  it('answers 421 and neither deploys code nor runs the node', async () => {
    withRows({ id: 'wf-1', lane: 'ops' })
    const res = await post(app, '/workflows/wf-1/test-node', { namespace: 'n1', definition })
    expect(res.status).toBe(421)
    expect(await res.json()).toEqual({ error: WRONG_LANE_MESSAGE })
    expect(deployCodeNodes).not.toHaveBeenCalled()
    expect(executeNode).not.toHaveBeenCalled()
  })

  it('refuses a stored lane it does not know rather than running the node', async () => {
    withRows({ id: 'wf-1', lane: 'sideways' })
    const res = await post(app, '/workflows/wf-1/test-node', { namespace: 'n1', definition })
    expect(res.status).toBe(500)
    expect(deployCodeNodes).not.toHaveBeenCalled()
    expect(executeNode).not.toHaveBeenCalled()
  })

  it('runs a money workflow node through the money lane executor (control)', async () => {
    withRows({ id: 'wf-1', lane: 'money' })
    const res = await post(app, '/workflows/wf-1/test-node', { namespace: 'n1', definition })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'completed', output: { ran: true } })
    expect(executeNode).toHaveBeenCalledTimes(1)
  })
})
