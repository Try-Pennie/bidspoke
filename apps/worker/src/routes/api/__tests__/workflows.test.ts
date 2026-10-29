/**
 * Workflow CRUD routes — PRD Section 1.3
 * Covers: PUT version snapshot + KV invalidation, PATCH is_active toggle,
 * DELETE, version restore, test runner endpoint.
 * Auth rejection is covered in workflows-auth.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sanitizeCodeNodeScripts } from '@bidspoke/script-hygiene'
// The live money workflows the money gate replays (#2338: their save must be unchanged).
import MONEY_MAIN_FLOW from '../../../../money-gate/fixtures/definitions/60e2e0bc-5aa2-47db-b333-3a8fe1c62e09.json'
import MONEY_RML_GIGFI from '../../../../money-gate/fixtures/definitions/6624acd0-bf61-4d21-85fc-4371ca7ed77d.json'
import MONEY_LEAD_ECONOMY from '../../../../money-gate/fixtures/definitions/89b1a6af-7e0f-43de-bc66-1e888184551f.json'
import MONEY_LIBERTY1_CLICK from '../../../../money-gate/fixtures/definitions/8a0f65aa-49a9-441c-a47e-b2a9a5fb2b08.json'
import MONEY_ENGINE from '../../../../money-gate/fixtures/definitions/da82a183-1a4a-417e-b0b8-5f3fe5e14840.json'
import MONEY_RML_LENDSWIFT from '../../../../money-gate/fixtures/definitions/e1b810da-16c0-49eb-bf12-ba1c9b67c914.json'
import MONEY_DELEGATE_GMAIL from '../../../../money-gate/fixtures/definitions/ee8ebc50-07dc-4670-89c7-d8ae47401558.json'
import { recordingContext } from '../../../test-setup/wait-until'
import { makeSupabase as makeSupabaseMock, type TableConfig } from './_supabase-mock'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../engine/definition-loader')
vi.mock('../../../lib/audit')
// executeWorkflow is replaced; the runtime helper stays real, so the route is
// seen passing a money runtime rather than an automocked undefined (#1707).
vi.mock('../../../engine/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../engine/index')>()),
  executeWorkflow: vi.fn(),
}))
vi.mock('../../../lib/github')
vi.mock('../../../lib/github-backup-alert')
vi.mock('../../../engine/nodes/index')
vi.mock('../../../lib/env-loader')
// The profile read is mocked; partnersPricedFor stays real, because the finder's
// decision (which partners a buyer_select workflow uses) is what is under test.
vi.mock('../../../lib/buyer-profile-loader', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/buyer-profile-loader')>('../../../lib/buyer-profile-loader')
  return { ...actual, loadBuyerProfiles: vi.fn() }
})

import { verifyJwt } from '../../../lib/jwt'
import { loadBuyerProfiles, type BuyerProfilesSnapshot, type LoadedBuyer } from '../../../lib/buyer-profile-loader'
import { createSupabaseClient } from '../../../lib/supabase'
import { refreshWorkflowCaches } from '../../../engine/definition-loader'
import { writeAuditLog } from '../../../lib/audit'
import { executeWorkflow } from '../../../engine/index'
import { executeNode } from '../../../engine/nodes/index'
import { loadEnvVars } from '../../../lib/env-loader'
import { pushWorkflowToGitHub } from '../../../lib/github'
import { recordBackupSuccess, recordBackupFailure } from '../../../lib/github-backup-alert'
import { uuidv7 } from '@bidspoke/uuidv7'
import api from '../index'
import { RELOAD_REQUIRED_WORKFLOW_MESSAGE } from '../workflows'

/** One call of write_workflow, as the route sent it (#1947). */
interface WriteArgs {
  p_op: string
  p_org: string
  p_id: string | null
  p_expected_version: number | null
  p_fields: Record<string, unknown>
  p_save_id: string | null
  p_actor: string
  p_actor_email: string
  p_actor_name: string
}
type RpcAnswer = { data: unknown; error: unknown }

/**
 * Every workflow write goes through the write_workflow function (#1947). The
 * route's own writeWorkflow is real here; the function is answered by `write`,
 * by default as written, from the call: the fields it was sent over the stored
 * row, the version one above the one it was made from. Every call is kept in
 * `writes`, which is what a test asserts a route wrote.
 */
function defaultWrite(args: WriteArgs): RpcAnswer {
  const f = args.p_fields
  const created = args.p_op === 'create' || args.p_op === 'duplicate'
  const workflow = {
    ...existingWorkflow,
    id: created ? 'wf-new' : args.p_id,
    name: f.name ?? existingWorkflow.name,
    definition: f.definition ?? existingWorkflow.definition,
    is_active: f.is_active ?? (args.p_op === 'patch' ? true : false),
    folder_id: f.folder_id ?? null,
    version: (args.p_expected_version ?? 0) + 1,
    updated_at: '2026-01-01T00:00:00Z',
  }
  return { data: { workflow, version_id: 'ver-new', version_number: 2, restored_from: args.p_op === 'restore' ? 1 : undefined }, error: null }
}

/**
 * The shared mock now covers what this file kept a local copy for: a handler for
 * non-auth rpcs, with jwtAuth's lookup served internally (#347).
 */
const makeSupabase = (
  tables: Record<string, TableConfig | TableConfig[]> = {},
  opts: { rpc?: (name: string, args: unknown) => Promise<RpcAnswer>; write?: (args: WriteArgs) => RpcAnswer } = {},
) => {
  const writes: WriteArgs[] = []
  const sb = makeSupabaseMock(tables, {
    rpc: (name, args) => {
      if (name === 'write_workflow') {
        writes.push(args as WriteArgs)
        return Promise.resolve((opts.write ?? defaultWrite)(args as WriteArgs))
      }
      if (opts.rpc) return opts.rpc(name, args)
      if (name === 'definition_connection_problems') return Promise.resolve({ data: [], error: null })
      return Promise.resolve({ data: null, error: null })
    },
  })
  return Object.assign(sb, { writes })
}

/** The write_workflow calls of one op. */
const writesOf = (sb: { writes: WriteArgs[] }, op: string) => sb.writes.filter((w) => w.p_op === op)

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ORG = 'org-abc'
/** A schedule trigger whose settings are whole, for tests about something else (an invalid one is refused at save, #1952). */
const OPS_SCHEDULE = { type: 'schedule', config: { cron: '0 13 * * *', timezone: 'America/New_York', overlap: 'skip', catch_up: 'none', jitter_max_seconds: 0 } }
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
// A stored row always carries its lane (NOT NULL, default money, #1707), and the
// test and test-node routes refuse a row without one (#1725).
const existingWorkflow = { id: 'wf-1', name: 'Lead Routing', organization_id: USER_ORG, definition: { nodes: [], edges: [] }, lane: 'money', version: 4 }
/** What a canvas save names since #1947: the version it was edited from and its press. */
const saveKeys = { expected_version: 4, save_id: '0b6f2a3e-8c1d-4e5f-9a7b-1c2d3e4f5a6b' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
// The keys the cache was asked to delete, read by the rename-apply tests (#1846).
const kvDeleted: string[] = []
const testEnv = {
  SUPABASE_JWKS_URL: 'https://fake.jwks',
  WORKFLOW_CACHE: { delete: async (k: string) => { kvDeleted.push(k) } },
  IDEMPOTENCY: {},
  APP_URL: 'https://app.test',
  GITHUB_TOKEN: 'gh-tok',
  GITHUB_REPO: 'Try-Pennie/backups',
} as unknown as Env

async function makeApp() {
  return api
}

/**
 * The client the route built for itself: refreshWorkflowCaches must read the
 * row back through the same client the route wrote it with (#1845).
 */
const routeClient = () => vi.mocked(createSupabaseClient).mock.results[0]?.value

const mockCtx = recordingContext()

function request(app: { request: Function }, method: string, path: string, opts: { body?: unknown } = {}) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }, testEnv, mockCtx)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PUT /workflows/:id', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    // Backup runs in waitUntil and chains .then/.catch — the auto-mock must return
    // a promise. Default to "not configured" (null) / no-op so unrelated tests are
    // unaffected; the backup-specific tests override these.
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
    vi.mocked(recordBackupSuccess).mockResolvedValue(undefined)
    vi.mocked(recordBackupFailure).mockResolvedValue(false)
    app = await makeApp()
  })

  it('returns 404 when workflow does not belong to the org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/workflows/wf-other', { body: { name: 'x' } })
    expect(res.status).toBe(404)
  })

  it('writes the snapshot and the row through write_workflow, from the version read, and returns the new version_id', async () => {
    const sb = makeSupabase(
      { users: { single: testUser }, workflows: { single: existingWorkflow } },
      { write: () => ({ data: { workflow: { ...existingWorkflow, name: 'Renamed', version: 5 }, version_id: 'ver-1', version_number: 2 }, error: null }) },
    )
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)

    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { name: 'Renamed' } })
    expect(res.status).toBe(200)
    const body = await res.json() as { version_id: string; version: number }
    expect(body.version_id).toBe('ver-1')
    expect(body.version).toBe(5)
    expect(sb.writes).toEqual([expect.objectContaining({ p_op: 'save', p_org: USER_ORG, p_id: 'wf-1', p_expected_version: 4, p_fields: { name: 'Renamed' }, p_save_id: null, p_actor: 'user-1' })])
  })

  // #2339: a person's own account may be used only by its owner, so a save stamps
  // who bound each app_action step, from the stored definition, never the client's.
  it('stamps who bound each app_action step: the stored binder for an unchanged connection, the saver for a new step, never a value the client sent', async () => {
    const DAN = '00000000-0000-4000-8000-0000000023d1'
    const conn = '00000000-0000-4000-8000-0000000023c1'
    const step = (id: string, boundBy?: string) => ({ id, namespace: id, type: 'app_action', config: { service: 'google', action: 'google.gmail-send-email', actionVersion: 1, connection: conn, ...(boundBy ? { boundBy } : {}) } })
    const stored = { ...existingWorkflow, definition: { trigger: OPS_SCHEDULE, nodes: [step('mail', DAN)], edges: [] } }
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: stored } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const definition = { trigger: OPS_SCHEDULE, nodes: [step('mail', 'user-1'), step('notify', DAN)], edges: [{ id: 'e', source: 'mail', target: 'notify' }] }
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition } })
    expect(res.status).toBe(200)
    const written = writesOf(sb, 'save')[0].p_fields.definition as { nodes: Array<{ id: string; config: { boundBy: string } }> }
    expect(written.nodes.map((n) => [n.id, n.config.boundBy])).toEqual([['mail', DAN], ['notify', 'user-1']])
  })

  it('rejects a cyclic definition with 400 before saving (#334)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const definition = {
      nodes: [{ id: 'a', namespace: 'validate', type: 'code', config: {} }, { id: 'b', namespace: 'enrich', type: 'code', config: {} }],
      edges: [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'a' }],
      trigger: { type: 'http_webhook', config: {} },
    }
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition } })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/loop/i)
    expect(body.error).toContain('validate')
  })

  // The relay port's write options (#2170) are refused by name at save, by the rule
  // the executor applies, so a definition PUT from a file cannot carry one the
  // step would refuse on every run.
  it('rejects a Salesforce step with a malformed write option with 400 naming the step and the option', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const definition = {
      nodes: [{ id: 'a', namespace: 'invalid_state_sf_post', type: 'salesforce', config: { operation: 'update', object: 'Submission__c', rename_fields: ['UUID'] } }],
      edges: [],
      trigger: { type: 'http_webhook', config: {} },
    }
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition } })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('invalid_state_sf_post: rename_fields must map each field name to a new field name')
  })

  // Node entries that are not objects saved before #2190, beside any valid step;
  // now the shape check refuses them by name before any other rule reads them.
  it('refuses a definition whose nodes hold non-object entries beside a valid Salesforce step, naming the entries (#2190)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
        workflow_versions: [{ single: { version_number: 1 } }, { insertResult: { id: 'ver-2', version_number: 2, workflow_id: 'wf-1' } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const definition = {
      nodes: [5, 'x', { id: 'a', namespace: 'post', type: 'salesforce', config: { operation: 'update', omit_fields: ['submissionId'] } }],
      edges: [],
      trigger: { type: 'http_webhook', config: {} },
    }
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition } })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; reason: string }
    expect(body.reason).toBe('definition_malformed')
    expect(body.error).toContain('step 1')
    expect(body.error).toContain('step 2')
  })

  // #2589: a lead validation step is held at save to what its executor can run,
  // judged where it sits: every reference runs before it, and a Constants key it
  // names is one its Constants step holds. The rules themselves are tested in
  // packages/workflow-definition; these prove the route asks them.
  describe('lead validation steps (#2589)', () => {
    const validationDefinition = (validationConfig: Record<string, unknown>) => ({
      nodes: [
        { id: 'c', namespace: 'constants', type: 'constants', config: { data: { states: ['TX'], maximumLoanAmount: 50000 } } },
        { id: 'v', namespace: 'validate_bidding_and_state', type: 'lead_validation', config: validationConfig },
      ],
      edges: [{ id: 'e0', source: 'trigger', target: 'c' }, { id: 'e1', source: 'c', target: 'v' }],
      trigger: { type: 'http_webhook', config: {} },
    })
    const goodConfig = (conditionValue = 'steps.constants.output.states', reason = 'ineligible state') => ({
      lead_id_field: 'trigger.payload.leadUuid',
      checks: [{
        id: 'state',
        label: 'State',
        condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: 'trigger.payload.state', operator: 'in_array', value: conditionValue }] }] },
        reason,
        on_missing: 'reject',
      }],
    })
    // A live workflow: a half built step blocks only a live save (#2590).
    const liveWorkflow = { ...existingWorkflow, is_active: true }
    const refused = async (validationConfig: Record<string, unknown>) => {
      vi.mocked(createSupabaseClient).mockReturnValue(
        makeSupabase({ users: { single: testUser }, workflows: { single: liveWorkflow } }) as unknown as ReturnType<typeof createSupabaseClient>
      )
      const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: validationDefinition(validationConfig) } })
      return { status: res.status, error: (await res.json() as { error?: string }).error }
    }
    const savingSb = (workflow: Record<string, unknown>) => makeSupabase({
      users: { single: testUser },
      workflows: [{ single: workflow }, { single: workflow }],
      workflow_versions: [{ single: { version_number: 1 } }, { insertResult: { id: 'ver-2', version_number: 2, workflow_id: 'wf-1' } }],
    })

    // #2590, Dan's decision: like every other unconfigured step, a half built
    // check blocks only a live workflow, so a switched off draft can be saved
    // while it is being built.
    it('saves a half built step on a switched off workflow', async () => {
      const sb = savingSb(existingWorkflow)
      vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: validationDefinition({ lead_id_field: '', checks: [] }) } })
      expect(res.status).toBe(200)
    })

    // #2590, Dan's decision: a rejection inside a parallel block cannot answer
    // the lead, so the placement is refused at every save, live or not.
    it('refuses a step inside a parallel block, even on a switched off workflow', async () => {
      vi.mocked(createSupabaseClient).mockReturnValue(
        makeSupabase({ users: { single: testUser }, workflows: { single: existingWorkflow } }) as unknown as ReturnType<typeof createSupabaseClient>
      )
      const definition = {
        nodes: [
          { id: 'p', namespace: 'fan_out', type: 'parallel', config: {} },
          { id: 'v', namespace: 'validate_bidding_and_state', type: 'lead_validation', config: goodConfig() },
          { id: 'end', namespace: 'join', type: 'parallel_end', config: {} },
        ],
        edges: [
          { id: 'e0', source: 'trigger', target: 'p' },
          { id: 'e1', source: 'p', target: 'v', source_handle: 'child-0' },
          { id: 'e2', source: 'v', target: 'end' },
        ],
        trigger: { type: 'http_webhook', config: {} },
      }
      const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition } })
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toBe(
        'validate_bidding_and_state: A lead validation step cannot run inside a parallel block: a lead it rejects there cannot be answered. Move it before the parallel block.',
      )
    })

    it('refuses a step with no checks, naming it', async () => {
      expect(await refused({ lead_id_field: 'trigger.payload.leadUuid', checks: [] })).toEqual({ status: 400, error: 'validate_bidding_and_state: No checks set' })
    })

    it('refuses a reason outside the one list', async () => {
      expect(await refused(goodConfig(undefined, 'out of area'))).toEqual({ status: 400, error: 'validate_bidding_and_state: Check "State": "out of area" is not a rejection reason Bidspoke knows' })
    })

    it('refuses a Constants key the Constants step does not hold', async () => {
      expect(await refused(goodConfig('steps.constants.output.stateList'))).toEqual({
        status: 400,
        error: 'validate_bidding_and_state: Check "State": steps.constants.output.stateList names stateList, which the constants step does not hold',
      })
    })

    it('refuses a step that does not run before it', async () => {
      expect(await refused(goodConfig('steps.later.output.states'))).toEqual({
        status: 400,
        error: 'validate_bidding_and_state: Check "State": steps.later.output.states reads later, which does not run before this step',
      })
    })

    it('saves a step whose every reference is sound', async () => {
      vi.mocked(createSupabaseClient).mockReturnValue(savingSb(liveWorkflow) as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: validationDefinition(goodConfig()) } })
      expect(res.status).toBe(200)
    })

    // Switching on and restoring onto a live workflow make a definition live
    // without a save, so they ask the live rule too.
    it('refuses to switch on a workflow whose stored step is half built, and switches nothing', async () => {
      const sb = makeSupabase({
        users: { single: testUser },
        workflows: [{ single: { ...existingWorkflow, is_active: false, definition: validationDefinition({ lead_id_field: 'trigger.payload.leadUuid', checks: [] }) } }],
      })
      vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toBe('validate_bidding_and_state: No checks set')
      expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
    })

    it('refuses to restore a half built step onto a live workflow', async () => {
      vi.mocked(createSupabaseClient).mockReturnValue(
        makeSupabase({
          users: { single: testUser },
          workflows: [{ single: liveWorkflow }],
          workflow_versions: [{ single: { id: 'ver-1', definition: validationDefinition({ lead_id_field: '', checks: [goodConfig().checks[0]] }), version_number: 1 } }],
        }) as unknown as ReturnType<typeof createSupabaseClient>
      )
      const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toBe('validate_bidding_and_state: No lead id field set')
      expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
    })
  })

  // #2338, plan 3.3: an App Action step is incomplete until what it runs, its
  // connection and its required fields are set, and a workflow holding one
  // cannot be switched on. The rule is validateDefinition's; these prove each
  // route that makes a definition live asks it, and refuses writing nothing.
  describe('unfinished App Action steps (#2338)', () => {
    const CONN = '33333333-3333-4333-8333-333333333333'
    const appDefinition = (config: Record<string, unknown>) => ({
      nodes: [{ id: 'post', namespace: 'post', type: 'app_action', config }],
      edges: [{ id: 'e0', source: 'trigger', target: 'post' }],
      trigger: OPS_SCHEDULE,
    })
    const unfinished = appDefinition({ service: 'slack', action: 'slack.send-message', actionVersion: 1, args: { channel: 'C0OPS', text: 'hi' } })
    const opsWorkflow = { ...existingWorkflow, lane: 'ops' }
    const sentence = 'Nothing was saved. Step post is not finished: No connection chosen. A workflow with an unfinished step cannot be switched on.'

    it('refuses the save of a switched on workflow holding one, naming the step and what it lacks', async () => {
      vi.mocked(createSupabaseClient).mockReturnValue(
        makeSupabase({ users: { single: testUser }, workflows: { single: { ...opsWorkflow, is_active: true } } }) as unknown as ReturnType<typeof createSupabaseClient>
      )
      const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: unfinished } })
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ error: 'step_unfinished', message: sentence, steps: [{ nodeId: 'post', namespace: 'post' }] })
      expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
    })

    it('refuses to switch on a workflow whose stored step is unfinished, and switches nothing', async () => {
      vi.mocked(createSupabaseClient).mockReturnValue(
        makeSupabase({ users: { single: testUser }, workflows: [{ single: { ...opsWorkflow, is_active: false, definition: unfinished, definition_schema_version: 1 } }] }) as unknown as ReturnType<typeof createSupabaseClient>
      )
      const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ error: 'step_unfinished', message: sentence })
      expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
    })

    it('refuses to switch on a definition stamped with a version this server cannot judge, never reading it as finished', async () => {
      vi.mocked(createSupabaseClient).mockReturnValue(
        makeSupabase({ users: { single: testUser }, workflows: [{ single: { ...opsWorkflow, is_active: false, definition: appDefinition({ service: 'slack', action: 'slack.send-message', actionVersion: 1, connection: CONN, args: { channel: 'C0OPS', text: 'hi' } }), definition_schema_version: 99 } }] }) as unknown as ReturnType<typeof createSupabaseClient>
      )
      const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ error: 'step_unjudged' })
    })

    it('refuses to restore an unfinished step onto a switched on workflow', async () => {
      vi.mocked(createSupabaseClient).mockReturnValue(
        makeSupabase({
          users: { single: testUser },
          workflows: [{ single: { ...opsWorkflow, is_active: true } }],
          workflow_versions: [{ single: { id: 'ver-1', definition: unfinished, version_number: 1 } }],
        }) as unknown as ReturnType<typeof createSupabaseClient>
      )
      const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ error: 'step_unfinished', message: sentence })
      expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
    })
  })

  // write_workflow numbers the snapshot under the row lock now (#1947), so the
  // version-number lookup #303 guarded is gone; a database error from the write
  // itself is a 500, with nothing audited or refreshed.
  it('answers 500 when write_workflow fails with a database error, and audits nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase(
        { users: { single: testUser }, workflows: { single: existingWorkflow } },
        { write: () => ({ data: null, error: { code: '57P01', message: 'db connection lost' } }) },
      ) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { name: 'Renamed' } })
    expect(res.status).toBe(500)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
  })

  it('returns 5xx (not a false 404) when the ownership fetch hits a real DB error (#320)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { singleError: { code: '57014', message: 'canceling statement due to statement timeout' } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { name: 'Renamed' } })
    expect(res.status).toBe(500)
  })


  it('calls refreshWorkflowCaches with the workflow id', async () => {
    const newVersion = { id: 'ver-2', version_number: 2, workflow_id: 'wf-1' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
        workflow_versions: [{ single: { version_number: 1 } }, { insertResult: newVersion }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    // A definition that actually differs from existingWorkflow's ({ nodes: [] }),
    // so the save is real and exercises the version/cache/audit/backup paths
    // rather than short-circuiting as a #569 no-op.
    await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: { nodes: [{ id: 'a', type: 'code', namespace: 'a', config: {} }], edges: [] } } })
    expect(vi.mocked(refreshWorkflowCaches)).toHaveBeenCalledWith('wf-1', testEnv.WORKFLOW_CACHE, routeClient())
  })

  // The save has committed by the time the caches are refreshed, so a KV failure
  // there must not skip the audit of a change that happened, and the answer says
  // what was saved and how to clear the copy (#1845).
  it('still deploys and audits a committed save when the cache refresh fails, and answers it as saved with a warning', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(refreshWorkflowCaches).mockRejectedValueOnce(new Error('kv unavailable'))
    const newVersion = { id: 'ver-2', version_number: 2, workflow_id: 'wf-1' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
        workflow_versions: [{ single: { version_number: 1 } }, { insertResult: newVersion }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: { nodes: [{ id: 'a', type: 'code', namespace: 'a', config: {} }], edges: [] } } })
    // The save landed, so it is answered as the success it was, with the warning beside it.
    expect(res.status).toBe(200)
    expect(((await res.json()) as { stored_copy_warning?: string }).stored_copy_warning).toMatch(/saved.*repaired automatically/i)
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalled()
  })

  // Drain the promises handed to ctx.waitUntil so the backup .then/.catch settles.
  const drainWaitUntil = () =>
    Promise.all(mockCtx.waitUntil.mock.calls.map((call: unknown[]) => call[0]))

  it('records a successful backup (clears the failure streak) when the push returns a commit sha', async () => {
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue('commit-sha-123')
    const newVersion = { id: 'ver-bk1', version_number: 2, workflow_id: 'wf-1' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
        workflow_versions: [{ single: { version_number: 1 } }, { insertResult: newVersion }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    // A definition that actually differs from existingWorkflow's ({ nodes: [] }),
    // so the save is real and exercises the version/cache/audit/backup paths
    // rather than short-circuiting as a #569 no-op.
    await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: { nodes: [{ id: 'a', type: 'code', namespace: 'a', config: {} }], edges: [] } } })
    await drainWaitUntil()
    expect(vi.mocked(recordBackupSuccess)).toHaveBeenCalled()
    expect(vi.mocked(recordBackupFailure)).not.toHaveBeenCalled()
  })

  // The commit-sha stamp runs inside waitUntil, after the save has already been
  // answered, and used to discard both its error and its rowcount. A version row
  // left with no commit_sha then looked like a healthy backup (#588).
  it('logs when the commit-sha stamp matches no row, and still clears the backup streak', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue('commit-sha-123')
    const newVersion = { id: 'ver-bk1', version_number: 2, workflow_id: 'wf-1' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
        workflow_versions: { list: [] },     // the commit_sha UPDATE touches nothing
      }, { write: () => ({ data: { workflow: existingWorkflow, version_id: newVersion.id, version_number: newVersion.version_number }, error: null }) }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: { nodes: [{ id: 'a', type: 'code', namespace: 'a', config: {} }], edges: [] } } })
    await drainWaitUntil()

    // One structured zero_row_write line, emitted by requireRowsAffected rather
    // than hand-rolled at the call site (#590). The target names the write.
    const logged = errSpy.mock.calls.map((call) => String(call[0]))
    const miss = logged.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(miss).toContainEqual(expect.objectContaining({
      event: 'zero_row_write',
      target: 'workflow_versions.commit_sha',
      version_id: 'ver-bk1',
    }))
    // The GitHub push itself succeeded, so the failure streak must still reset.
    // Only the bookkeeping is broken, and only the bookkeeping is reported.
    expect(vi.mocked(recordBackupSuccess)).toHaveBeenCalled()
    expect(vi.mocked(recordBackupFailure)).not.toHaveBeenCalled()
  })

  it('stays quiet when the commit-sha stamp lands on its version row', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue('commit-sha-123')
    const newVersion = { id: 'ver-bk1', version_number: 2, workflow_id: 'wf-1' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
        workflow_versions: { list: [{ id: 'ver-bk1' }] },
      }, { write: () => ({ data: { workflow: existingWorkflow, version_id: newVersion.id, version_number: newVersion.version_number }, error: null }) }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: { nodes: [{ id: 'a', type: 'code', namespace: 'a', config: {} }], edges: [] } } })
    await drainWaitUntil()

    const logged = errSpy.mock.calls.map((call) => String(call[0]))
    expect(logged.some((line) => line.includes('zero_row_write'))).toBe(false)
    expect(vi.mocked(recordBackupSuccess)).toHaveBeenCalled()
  })

  it('reports the commit-sha stamp as unset, and stamps nothing, when the write named no version', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue('commit-sha-123')
    const sb = makeSupabase(
      { users: { single: testUser }, workflows: { single: existingWorkflow } },
      { write: () => ({ data: { workflow: existingWorkflow }, error: null }) },
    )
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: { nodes: [{ id: 'a', type: 'code', namespace: 'a', config: {} }], edges: [] } } })
    await drainWaitUntil()
    expect((sb.calls.workflow_versions ?? []).filter(([m]) => m === 'update')).toEqual([])
    const logged = errSpy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
    expect(logged).toContainEqual(expect.objectContaining({ event: 'workflow_version_commit_sha_unset', workflow_id: 'wf-1', version_id: null }))
    expect(vi.mocked(recordBackupSuccess)).toHaveBeenCalled()
  })

  // A write that names no version number has no number to label the backup by.
  // It was labelled v0, a version no workflow ever has (#1947 review).
  it('hands the backup no version number, never 0, when the write named none', async () => {
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase(
      { users: { single: testUser }, workflows: { single: existingWorkflow } },
      { write: () => ({ data: { workflow: existingWorkflow }, error: null }) },
    ) as unknown as ReturnType<typeof createSupabaseClient>)
    await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: { nodes: [{ id: 'a', type: 'code', namespace: 'a', config: {} }], edges: [] } } })
    await drainWaitUntil()
    expect(vi.mocked(pushWorkflowToGitHub).mock.calls[0]?.[5]).toBeNull()
  })

  it('hands the backup the version number the write named', async () => {
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase(
      { users: { single: testUser }, workflows: { single: existingWorkflow } },
      { write: () => ({ data: { workflow: existingWorkflow, version_id: 'ver-7', version_number: 7 }, error: null }) },
    ) as unknown as ReturnType<typeof createSupabaseClient>)
    await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: { nodes: [{ id: 'a', type: 'code', namespace: 'a', config: {} }], edges: [] } } })
    await drainWaitUntil()
    expect(vi.mocked(pushWorkflowToGitHub).mock.calls[0]?.[5]).toBe(7)
  })

  it('records a backup failure (for alerting) when the push throws', async () => {
    vi.mocked(pushWorkflowToGitHub).mockRejectedValue(new Error('GitHub push failed (401): Bad credentials'))
    vi.mocked(recordBackupFailure).mockResolvedValue(false)
    const newVersion = { id: 'ver-bk2', version_number: 2, workflow_id: 'wf-1' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
        workflow_versions: [{ single: { version_number: 1 } }, { insertResult: newVersion }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    // A definition that actually differs from existingWorkflow's ({ nodes: [] }),
    // so the save is real and exercises the version/cache/audit/backup paths
    // rather than short-circuiting as a #569 no-op.
    await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: { nodes: [{ id: 'a', type: 'code', namespace: 'a', config: {} }], edges: [] } } })
    await drainWaitUntil()
    expect(vi.mocked(recordBackupFailure)).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 'wf-1' }))
    expect(vi.mocked(recordBackupSuccess)).not.toHaveBeenCalled()
  })

  it('does not record/alert a backup failure when LOCAL_DEV is set, even for a normally-named workflow (local wrangler dev shares the real org Slack connection)', async () => {
    vi.mocked(pushWorkflowToGitHub).mockRejectedValue(new Error('GitHub backup misconfigured: GITHUB_TOKEN is not set (GITHUB_REPO is configured)'))
    const newVersion = { id: 'ver-bk3', version_number: 2, workflow_id: 'wf-1' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
        workflow_versions: [{ single: { version_number: 1 } }, { insertResult: newVersion }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const localEnv = { ...testEnv, LOCAL_DEV: 'true' } as unknown as Env
    await app.request('/workflows/wf-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: JSON.stringify({ ...saveKeys, definition: { nodes: [], edges: [] } }),
    }, localEnv, mockCtx)
    await drainWaitUntil()
    expect(vi.mocked(recordBackupFailure)).not.toHaveBeenCalled()
    expect(vi.mocked(recordBackupSuccess)).not.toHaveBeenCalled()
  })

  it('writes an audit log entry', async () => {
    const newVersion = { id: 'ver-3', version_number: 2, workflow_id: 'wf-1' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
        workflow_versions: [{ single: { version_number: 1 } }, { insertResult: newVersion }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    // A definition that actually differs from existingWorkflow's ({ nodes: [] }),
    // so the save is real and exercises the version/cache/audit/backup paths
    // rather than short-circuiting as a #569 no-op.
    await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: { nodes: [{ id: 'a', type: 'code', namespace: 'a', config: {} }], edges: [] } } })
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.anything(), USER_ORG, 'workflow', 'wf-1', 'updated', 'user-1', expect.anything()
    )
  })

  // #569: a save whose definition (and name/slack) is byte-for-byte the same as
  // what's stored used to still create a redundant version and return a plain
  // 200 (indistinguishable from a real save). When a client edit silently fails
  // to reach the payload, that false "Saved" is the exact data-safety bug. The
  // server now reports no_changes and skips the snapshot so the UI can flag it.
  it('returns no_changes and creates no version when definition, name and slack are unchanged', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/workflows/wf-1', {
      body: { ...saveKeys, name: 'Lead Routing', definition: { nodes: [], edges: [] } },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { no_changes?: boolean; version_id?: string }
    expect(body.no_changes).toBe(true)
    expect(body.version_id).toBeUndefined()
    // No snapshot and no audit entry for a no-op.
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  // #1845: a save whose stored copy could not be refreshed tells the person to
  // save again, and that second save is unchanged. It must still refresh the
  // copies, or the remedy the warning names does nothing.
  it('refreshes the stored copies on an unchanged save, so saving again clears a stale one', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/workflows/wf-1', {
      body: { ...saveKeys, name: 'Lead Routing', definition: { nodes: [], edges: [] } },
    })
    expect(((await res.json()) as { no_changes?: boolean }).no_changes).toBe(true)
    expect(vi.mocked(refreshWorkflowCaches)).toHaveBeenCalledWith('wf-1', testEnv.WORKFLOW_CACHE, routeClient())
  })

  it('warns on an unchanged save whose stored copies still cannot be refreshed', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(refreshWorkflowCaches).mockRejectedValueOnce(new Error('kv unavailable'))
    const res = await request(app, 'PUT', '/workflows/wf-1', {
      body: { ...saveKeys, name: 'Lead Routing', definition: { nodes: [], edges: [] } },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { no_changes?: boolean; stored_copy_warning?: string }
    expect(body.no_changes).toBe(true)
    expect(body.stored_copy_warning).toMatch(/repaired automatically/i)
  })

  it('treats a key-reordered but structurally identical definition as no_changes (jsonb round-trip)', async () => {
    const stored = {
      ...existingWorkflow,
      definition: { nodes: [], edges: [], trigger: { type: 'http_webhook', config: {} } },
    }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: stored },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    // Same content, keys in a different order (as jsonb would return them).
    const res = await request(app, 'PUT', '/workflows/wf-1', {
      body: { ...saveKeys, name: 'Lead Routing', definition: { trigger: { config: {}, type: 'http_webhook' }, edges: [], nodes: [] } },
    })
    const body = await res.json() as { no_changes?: boolean }
    expect(body.no_changes).toBe(true)
  })

  it('saves and creates a version when the definition content actually changed', async () => {
    const newVersion = { id: 'ver-chg', version_number: 2, workflow_id: 'wf-1' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
        workflow_versions: [{ single: { version_number: 1 } }, { insertResult: newVersion }],
      }, { write: () => ({ data: { workflow: existingWorkflow, version_id: newVersion.id, version_number: 2 }, error: null }) }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/workflows/wf-1', {
      body: { ...saveKeys, name: 'Lead Routing', definition: { nodes: [{ id: 'a', type: 'code', namespace: 'a', config: {} }], edges: [] } },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { no_changes?: boolean; version_id?: string }
    expect(body.no_changes).toBeFalsy()
    expect(body.version_id).toBe('ver-chg')
    expect(vi.mocked(refreshWorkflowCaches)).toHaveBeenCalledWith('wf-1', testEnv.WORKFLOW_CACHE, routeClient())
  })
})

describe('POST /workflows/:id/duplicate', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 when the source workflow is not in the org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-other/duplicate')
    expect(res.status).toBe(404)
  })

  // The clone and its whole history land in one write_workflow call (#1947):
  // the copy of every version, the first version of a source never saved, and
  // the lane and stamp it keeps are proven against Postgres in
  // supabase/tests/write_workflow.test.sql (F). What the route sends is here.
  it('clones through write_workflow, from the source, switched off, and audit-logs the source', async () => {
    const source = { name: 'Lead Routing', description: null, definition: { nodes: [], edges: [] }, folder_id: null, is_active: true, lane: 'money', version: 3 }
    const clone = { id: 'wf-copy', name: 'Lead Routing (copy)', organization_id: USER_ORG, is_active: false }
    const sb = makeSupabase(
      { users: { single: testUser }, workflows: { single: source } },
      { write: () => ({ data: { workflow: clone, versions_copied: 2 }, error: null }) },
    )
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; name: string; history_copied: boolean }
    expect(body).toMatchObject({ id: 'wf-copy', name: 'Lead Routing (copy)', history_copied: true })
    expect(sb.writes).toEqual([expect.objectContaining({ p_op: 'duplicate', p_id: 'wf-1', p_expected_version: 3, p_fields: { name: 'Lead Routing (copy)', definition: source.definition } })])
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.anything(), USER_ORG, 'workflow', 'wf-copy', 'created', 'user-1', { duplicated_from: 'wf-1' }
    )
  })

  // Before #1947 the clone was written first and its history after, so a failed
  // history copy left a copy with no saved versions (answered history_copied
  // false). Both are one transaction now: a failure writes neither.
  it('answers a failed copy as an error and audits nothing, since the clone and its history land together or not at all', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const source = { name: 'Real', description: null, definition: { nodes: [], edges: [] }, folder_id: null, is_active: false, lane: 'money' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase(
        { users: { single: testUser }, workflows: { single: source } },
        { write: () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }) },
      ) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(500)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('copies from the source version it read, and answers a save landing in between with 409, copying nothing', async () => {
    const source = { name: 'Lead Routing', description: null, definition: { nodes: [], edges: [] }, folder_id: null, is_active: false, lane: 'money', version: 6 }
    const sb = makeSupabase(
      { users: { single: testUser }, workflows: { single: source } },
      { write: () => ({ data: null, error: { code: 'BP409', message: 'stale_version', details: JSON.stringify({ current: { ...source, version: 7 }, last_save_id: null, changed_by_name: 'Bob', changed_at: '2026-10-23T14:00:00Z' }) } }) },
    )
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'stale_version', error: expect.stringMatching(/^Not duplicated\./) })
    expect(sb.writes).toEqual([expect.objectContaining({ p_op: 'duplicate', p_expected_version: 6 })])
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('answers 404 when the source was deleted between the read and the copy', async () => {
    const source = { name: 'Gone', description: null, definition: { nodes: [], edges: [] }, folder_id: null, is_active: false, lane: 'money' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase(
        { users: { single: testUser }, workflows: { single: source } },
        { write: () => ({ data: null, error: { code: 'P0002', message: 'workflow_not_found' } }) },
      ) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(404)
  })

  it('succeeds when the source has code nodes (deploy path runs, no CF creds = no-op)', async () => {
    const source = {
      name: 'Coded',
      description: null,
      definition: { nodes: [{ id: 'n1', type: 'code', namespace: 'enrich', config: { script: 'return {}' } }], edges: [] },
      folder_id: null,
      is_active: true,
      lane: 'money',
    }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase(
        { users: { single: testUser }, workflows: { single: source } },
        { write: () => ({ data: { workflow: { id: 'wf-copy3', name: 'Coded (copy)', organization_id: USER_ORG } }, error: null }) },
      ) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string }
    expect(body.id).toBe('wf-copy3')
  })
})

describe('PATCH /workflows/:id', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 when workflow does not exist', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PATCH', '/workflows/wf-missing', { body: { is_active: false } })
    expect(res.status).toBe(404)
  })

  it('returns 200 with updated fields', async () => {
    const updated = { id: 'wf-1', name: 'Lead Routing', is_active: false, updated_at: '2026-01-01' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [
          { single: existingWorkflow },  // ownership check
          { single: updated },           // update result
        ],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: false } })
    expect(res.status).toBe(200)
    const body = await res.json() as { is_active: boolean }
    expect(body.is_active).toBe(false)
  })

  it('calls refreshWorkflowCaches', async () => {
    const updated = { id: 'wf-1', name: 'Lead Routing', is_active: true, updated_at: '2026-01-01' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: updated }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
    expect(vi.mocked(refreshWorkflowCaches)).toHaveBeenCalledWith('wf-1', testEnv.WORKFLOW_CACHE, routeClient())
  })

  it('still audits a committed switch off when the cache refresh fails (#1845)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(refreshWorkflowCaches).mockRejectedValueOnce(new Error('kv unavailable'))
    const updated = { id: 'wf-1', name: 'Lead Routing', is_active: false, updated_at: '2026-01-01' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: updated }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: false } })
    // The save landed, so it is answered as the success it was, with the warning beside it.
    expect(res.status).toBe(200)
    expect(((await res.json()) as { stored_copy_warning?: string }).stored_copy_warning).toMatch(/saved.*repaired automatically/i)
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledTimes(1)
  })
})

describe('DELETE /workflows/:id', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  // `list` is what a write's `.select('id')` resolves to in this mock, i.e. the
  // rows the soft-delete UPDATE actually touched.
  const softDeleteHit = { users: { single: testUser }, workflows: { list: [{ id: 'wf-1' }] } }

  it('returns 200 ok', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase(softDeleteHit) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/workflows/wf-1')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('calls refreshWorkflowCaches', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase(softDeleteHit) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'DELETE', '/workflows/wf-1')
    expect(vi.mocked(refreshWorkflowCaches)).toHaveBeenCalledWith('wf-1', testEnv.WORKFLOW_CACHE, routeClient())
  })

  it('still audits a committed delete when the cache refresh fails, and answers it with a warning (#1845)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(refreshWorkflowCaches).mockRejectedValueOnce(new Error('kv unavailable'))
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase(softDeleteHit) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/workflows/wf-1')
    // The save landed, so it is answered as the success it was, with the warning beside it.
    expect(res.status).toBe(200)
    expect(((await res.json()) as { stored_copy_warning?: string }).stored_copy_warning).toMatch(/saved.*repaired automatically/i)
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledTimes(1)
  })

  it('writes an audit log entry', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase(softDeleteHit) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'DELETE', '/workflows/wf-1')
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.anything(), USER_ORG, 'workflow', 'wf-1', 'deleted', 'user-1'
    )
  })

  // This handler has no ownership lookup: the soft-delete UPDATE is the only
  // guard. A workflow that never existed, sits in another org, or was already
  // soft-deleted all match zero rows, and all used to answer 200 {ok:true}
  // while writing an audit row claiming a deletion (#588).
  it('returns 404 and writes nothing when the soft delete matches no row', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }, { write: () => ({ data: null, error: { code: 'P0002', message: 'workflow_not_found' } }) }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/workflows/wf-gone')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Workflow not found' })
    expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})

describe('POST /workflows/:id/versions/:version_id/restore', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
    vi.mocked(recordBackupSuccess).mockResolvedValue(undefined)
    vi.mocked(recordBackupFailure).mockResolvedValue(false)
    app = await makeApp()
  })

  // #2868: a restore writes a new version as a save does, so it is backed up as
  // a save is. Until then the backup held the definition the restore replaced
  // until someone next saved the workflow on the canvas.
  const restoredDefinition = { nodes: [{ id: 'old', type: 'code', namespace: 'old', config: {} }], edges: [] }
  const restoreClient = () => makeSupabase(
    {
      users: { single: testUser },
      workflows: { single: existingWorkflow },
      workflow_versions: [{ single: { id: 'ver-1', definition: restoredDefinition, version_number: 1 } }, { list: [{ id: 'ver-4' }] }],
    },
    { write: () => ({ data: { workflow: { ...existingWorkflow, definition: restoredDefinition, version: 5 }, version_id: 'ver-4', version_number: 4, restored_from: 1 }, error: null }) },
  )

  it('pushes the restored definition to the GitHub backup and stamps the commit on the restored version row (#2868)', async () => {
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue('commit-restore-1')
    const sb = restoreClient()
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(res.status).toBe(200)
    await mockCtx.settle()
    expect(vi.mocked(pushWorkflowToGitHub)).toHaveBeenCalledWith('gh-tok', 'Try-Pennie/backups', 'wf-1', 'Lead Routing', restoredDefinition, 4, expect.any(String))
    expect((sb.calls.workflow_versions ?? []).filter(([m]) => m === 'update')).toEqual([['update', [{ commit_sha: 'commit-restore-1' }]]])
    expect(vi.mocked(recordBackupSuccess)).toHaveBeenCalled()
  })

  it('answers a restore whose backup push fails as restored, and alerts the failure as a save does (#2868)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(pushWorkflowToGitHub).mockRejectedValue(new Error('GitHub push failed (401): Bad credentials'))
    vi.mocked(createSupabaseClient).mockReturnValue(restoreClient() as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, version_number: 4 })
    await mockCtx.settle()
    expect(vi.mocked(recordBackupFailure)).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 'wf-1', workflowName: 'Lead Routing' }))
    expect(vi.mocked(recordBackupSuccess)).not.toHaveBeenCalled()
  })

  it('returns 404 when version does not exist', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },  // ownership passes — exercise the version lookup
        workflow_versions: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-ghost/restore')
    expect(res.status).toBe(404)
  })

  it('returns 404 and writes nothing when the workflow belongs to another org', async () => {
    // Ownership lookup is org-scoped — a workflow in another org yields no row,
    // so the handler must bail before touching versions, the definition, or the
    // cache. (Service-role key bypasses RLS, so this check is the only guard.)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null },                 // cross-org: ownership fails
        workflow_versions: { single: { id: 'ver-1', definition: { nodes: [] }, version_number: 1 } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-other/versions/ver-1/restore')
    expect(res.status).toBe(404)
    // No definition overwrite, no version-history insert, no cache bust, no audit.
    expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 200 with the new version number, written through write_workflow from the version read', async () => {
    const oldVersion = { id: 'ver-1', definition: { nodes: [], edges: [] }, version_number: 1 }
    const sb = makeSupabase(
      { users: { single: testUser }, workflow_versions: { single: oldVersion }, workflows: { single: existingWorkflow } },
      { write: () => ({ data: { workflow: { ...existingWorkflow, version: 5 }, version_id: 'ver-4', version_number: 4, restored_from: 1 }, error: null }) },
    )
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, version_number: 4, version: 5 })
    expect(sb.writes).toEqual([expect.objectContaining({ p_op: 'restore', p_id: 'wf-1', p_expected_version: 4, p_fields: expect.objectContaining({ version_id: 'ver-1', definition: oldVersion.definition }) })])
  })

  it.each([['no body', undefined], ['a body of null', null], ['a body that is a list', [1]]])('a restore sent %s is made from the version read, never a 500', async (_, body) => {
    const sb = makeSupabase({ users: { single: testUser }, workflow_versions: { single: { id: 'ver-1', definition: { nodes: [], edges: [] }, version_number: 1 } }, workflows: { single: existingWorkflow } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await app.request('/workflows/wf-1/versions/ver-1/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, testEnv, mockCtx)
    expect(res.status).toBe(200)
    expect(sb.writes[0].p_expected_version).toBe(4)
  })

  it('a restore naming the version its page saw is made from that version', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflow_versions: { single: { id: 'ver-1', definition: { nodes: [], edges: [] }, version_number: 1 } }, workflows: { single: existingWorkflow } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore', { body: { expected_version: 2 } })
    expect(res.status).toBe(200)
    expect(sb.writes[0].p_expected_version).toBe(2)
  })

  // The snapshot and the definition are one transaction since #1947, so history
  // and definition cannot diverge (#588); a workflow that vanished between the
  // read and the write is a 404 with nothing written, audited or refreshed.
  it('returns 404 when the workflow vanished before the write, and nothing is audited or refreshed', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase(
        { users: { single: testUser }, workflow_versions: { single: { id: 'ver-1', definition: { nodes: [], edges: [] }, version_number: 1 } }, workflows: { single: existingWorkflow } },
        { write: () => ({ data: null, error: { code: 'P0002', message: 'workflow_not_found' } }) },
      ) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(res.status).toBe(404)
    expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('answers a restore that lost the race to a save with 409 and the current row, writing nothing', async () => {
    const current = { ...existingWorkflow, version: 6 }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase(
        { users: { single: testUser }, workflow_versions: { single: { id: 'ver-1', definition: { nodes: [], edges: [] }, version_number: 1 } }, workflows: { single: existingWorkflow } },
        { write: () => ({ data: null, error: { code: 'BP409', message: 'stale_version', details: JSON.stringify({ current, last_save_id: null, changed_by_name: 'Bob', changed_at: '2026-10-23T14:00:00Z' }) } }) },
      ) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'stale_version', current: { version: 6 }, changed_by_name: 'Bob', error: expect.stringMatching(/^Not restored\./) })
    expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 5xx (not a false 404) when the target-version lookup hits a real DB error (#320)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },
        workflow_versions: { singleError: { code: '57014', message: 'canceling statement due to statement timeout' } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(res.status).toBe(500)
  })

  it('invalidates the workflow cache after restore', async () => {
    const oldVersion = { id: 'ver-1', definition: { nodes: [] }, version_number: 1 }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_versions: [
          { single: oldVersion },
          { single: { version_number: 3 } },
          { insertResult: { id: 'ver-4', version_number: 4 } },
        ],
        workflows: [{ single: existingWorkflow }, { list: [{ id: 'wf-1' }] }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(vi.mocked(refreshWorkflowCaches)).toHaveBeenCalledWith('wf-1', testEnv.WORKFLOW_CACHE, routeClient())
  })

  it('still audits a committed restore when the cache refresh fails (#1845)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(refreshWorkflowCaches).mockRejectedValueOnce(new Error('kv unavailable'))
    const oldVersion = { id: 'ver-1', definition: { nodes: [] }, version_number: 1 }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_versions: [
          { single: oldVersion },
          { single: { version_number: 3 } },
          { insertResult: { id: 'ver-4', version_number: 4 } },
        ],
        workflows: [{ single: existingWorkflow }, { list: [{ id: 'wf-1' }] }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    // The save landed, so it is answered as the success it was, with the warning beside it.
    expect(res.status).toBe(200)
    expect(((await res.json()) as { stored_copy_warning?: string }).stored_copy_warning).toMatch(/saved.*repaired automatically/i)
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledTimes(1)
  })
})

// #596: the workflow read and the restore ownership lookup used the bare
// `if (error) return 404` form. A real DB error on either must surface as a
// retryable 5xx, not a false 404 that says the workflow is gone during a blip.
describe('workflow reads: DB error => 5xx not 404 (#596)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const DB_ERROR = { code: '57014', message: 'canceling statement due to statement timeout' }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    app = await makeApp()
  })

  it('GET /:id returns 5xx when the workflow read errors (not 404)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { singleError: DB_ERROR },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/workflows/wf-1')
    expect(res.status).toBe(500)
  })

  it('POST /:id/versions/:version_id/restore returns 5xx when the ownership lookup errors (not 404)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { singleError: DB_ERROR },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(res.status).toBe(500)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  // Each remaining fixed handler: a DB error on its ownership lookup is a 5xx,
  // never a false 404. Injecting singleError on the first workflows read (the
  // ownership check) is exactly what the old bare `if (error) return 404` turned
  // into a 404.
  function withOwnershipError() {
    return makeSupabase({
      users: { single: testUser },
      workflows: { singleError: DB_ERROR },
    }) as unknown as ReturnType<typeof createSupabaseClient>
  }

  it('PATCH /:id returns 5xx when the ownership lookup errors (not 404)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(withOwnershipError())
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
    expect(res.status).toBe(500)
  })

  it('GET /:id/versions returns every version when the history runs past one 1,000 row page', async () => {
    const row = (n: number) => ({ id: `v${n}`, version_number: n })
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: { id: 'wf-1' } },
        workflow_versions: [
          { list: Array.from({ length: 1000 }, (_, i) => row(1003 - i)) },
          { list: [row(3), row(2), row(1)] },
        ],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/workflows/wf-1/versions')
    expect(res.status).toBe(200)
    const body = await res.json() as Array<{ version_number: number }>
    expect(body).toHaveLength(1003)
    expect(body[body.length - 1].version_number).toBe(1)
  })

  it('GET /:id/versions returns 5xx when the version read errors, never a short list', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: { id: 'wf-1' } },
        workflow_versions: { listError: { message: 'statement timeout' } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/workflows/wf-1/versions')
    expect(res.status).toBe(500)
  })

  it('GET /:id/versions returns 5xx when the ownership lookup errors (not 404)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(withOwnershipError())
    const res = await request(app, 'GET', '/workflows/wf-1/versions')
    expect(res.status).toBe(500)
  })

  it('GET /:id/versions/:version_id returns 5xx when the ownership lookup errors (not 404)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(withOwnershipError())
    const res = await request(app, 'GET', '/workflows/wf-1/versions/ver-1')
    expect(res.status).toBe(500)
  })

  it('POST /:id/test returns 5xx when the ownership lookup errors (not 404)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(withOwnershipError())
    const res = await request(app, 'POST', '/workflows/wf-1/test', { body: { payload: {} } })
    expect(res.status).toBe(500)
  })

  it('POST /:id/test-node returns 5xx when the ownership lookup errors (not 404)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(withOwnershipError())
    const res = await request(app, 'POST', '/workflows/wf-1/test-node', { body: { namespace: 'n' } })
    expect(res.status).toBe(500)
  })

  it('GET /:id/rename-impact names a workflow whose buyer_select node sells to the partner, through the enabled profiles priced for its population (#1411)', async () => {
    // buyer_select names no partner in its config. The decision recorded on the
    // plan: a workflow containing one uses every partner holding an enabled
    // profile priced for that node's population, so a formula rewrite on Tripoint
    // names the Engine workflow and is refused by default.
    const profile = (partnerId: string, population: string): LoadedBuyer => ({
      partner: { id: partnerId, slug: partnerId, name: partnerId, is_active: true, api_endpoint: null, cf_secret_key: null, outbound_field_mapping: null, extra_extraction: null, accept_signals: [], response_classification: null, click_url: null, external_routing_code: null, duplicate_signals: [], circuit_enabled: false, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 30 },
      profile: { partnerId, soldOn: 'offer', isEnabled: true, priority: 1, allowedStates: ['TX'], debtMin: null, debtMax: null, loanAmountMin: null, hourlyLeadCap: null, dailyLeadCap: null, hourlySpendCapCents: null, dailySpendCapCents: null, windows: [], blackoutDates: [], tiers: [{ population, debtFrom: 0, debtTo: null, multiplier: 0.001 }] },
      version: 1,
      updated_at: '2027-01-01T00:00:00.000Z',
    })
    const snapshot: BuyerProfilesSnapshot = { org_id: USER_ORG, loaded_at: '2027-01-01T00:00:00.000Z', content_hash: 'test', served_from: 'database', buyers: [profile('p-tripoint', 'engine'), profile('p-liberty', 'main_flow')] }
    vi.mocked(loadBuyerProfiles).mockResolvedValue(snapshot)

    const partners = [
      { id: 'p-tripoint', name: 'Tripoint', slug: 'tripoint', bid_formula: 'steps.trades.output.debt * 0.0012', bid_resolver_config: null },
      { id: 'p-liberty', name: 'Liberty', slug: 'liberty', bid_formula: 'steps.trades.output.debt * 0.001', bid_resolver_config: null },
    ]
    const engineWorkflow = { id: 'wf-engine', name: 'Engine Bidding', is_active: true, organization_id: USER_ORG, deleted_at: null, definition: { nodes: [{ id: 'bs', namespace: 'sell_off', type: 'buyer_select', config: { population: 'engine', mode: 'live' } }] } }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { list: [engineWorkflow] }],
        partner_configs: { list: partners },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )

    const res = await request(app, 'GET', '/workflows/wf-1/rename-impact?old=trades&new=prospect_trades')
    expect(res.status).toBe(200)
    const body = await res.json() as { partner_formulas: Array<{ partner_slug: string; shared_with_workflows: Array<{ id: string }>; can_rewrite: boolean }> }
    const bySlug = Object.fromEntries(body.partner_formulas.map((p) => [p.partner_slug, p]))
    expect(bySlug.tripoint.shared_with_workflows.map((w) => w.id)).toEqual(['wf-engine'])
    expect(bySlug.tripoint.can_rewrite).toBe(false)
    // Liberty is priced for main_flow only, so the Engine node does not use it.
    expect(bySlug.liberty.shared_with_workflows).toEqual([])
    expect(bySlug.liberty.can_rewrite).toBe(true)
  })

  it('GET /:id/rename-impact returns 5xx when the ownership lookup errors (not 404)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(withOwnershipError())
    const res = await request(app, 'GET', '/workflows/wf-1/rename-impact?old=foo&new=bar')
    expect(res.status).toBe(500)
  })

  it('POST /:id/rename-apply returns 5xx when the ownership lookup errors (not 404)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(withOwnershipError())
    const res = await request(app, 'POST', '/workflows/wf-1/rename-apply', {
      body: { old: 'foo', new: 'bar', partner_ids: ['p-1'] },
    })
    expect(res.status).toBe(500)
  })
})

// The #588 zero row rename tests that used to sit here (a partner deleted between
// the candidate SELECT and the UPDATE was counted and audited as renamed) moved to
// the rename-apply describe at the end of this file when the rewrite moved into
// the database function (#1409). The decision they defended stands: an untouched
// partner is not counted and the zero row write is logged, a landed one is counted,
// and a real database error is a 500.

describe('POST /workflows/:id/test', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 when workflow does not belong to org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-ghost/test', { body: { payload: {} } })
    expect(res.status).toBe(404)
  })

  it('calls executeWorkflow with isTest: true', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(executeWorkflow).mockResolvedValue({
      response: { ok: true },
      status: 200,
      executionId: 'exec-test', traceId: 'trace-test',
      idempotentReplay: false,
    })

    const testPayload = { lead_id: 'L42' }
    await request(app, 'POST', '/workflows/wf-1/test', { body: { payload: testPayload } })

    expect(vi.mocked(executeWorkflow)).toHaveBeenCalledWith(
      expect.objectContaining({ isTest: true, workflowId: 'wf-1', payload: testPayload }),
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  /**
   * The only way a non-v7 execution id can reach the archive (#869, Phase A1).
   *
   * The engine mints its own id, so live runs are v7 by construction. The canvas
   * test runner is different: it needs the id BEFORE the run so it can open its
   * realtime channel filter on it, so it mints one in the browser and posts it
   * here, and this route passed `body.execution_id` straight into the engine
   * without looking at it. That makes the every-id-is-v7 invariant a rule living
   * in a prompt (L27) rather than something the code enforces.
   *
   * It REFUSES rather than quietly minting its own replacement. Substituting one
   * would leave the browser listening on a channel for an id that no longer
   * exists, so the panel would sit empty with the run succeeding invisibly, which
   * is a silent failure where a refusal is a legible one (L10, L11). The refusal
   * is validated against the READER's own predicate, so the route accepts exactly
   * what `utcDayFromUuidV7` can consume and nothing wider (L150).
   */
  const withWorkflow = () =>
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )

  it('accepts a v7 execution id and passes it through unchanged', async () => {
    withWorkflow()
    vi.mocked(executeWorkflow).mockResolvedValue({
      response: { ok: true }, status: 200,
      executionId: 'exec-test', traceId: 'trace-test', idempotentReplay: false,
    })

    const id = uuidv7()
    const res = await request(app, 'POST', '/workflows/wf-1/test', {
      body: { payload: {}, execution_id: id },
    })

    expect(res.status).toBe(200)
    expect(vi.mocked(executeWorkflow)).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: id }),
      expect.anything(), expect.anything(), expect.anything()
    )
  })

  it('rejects a v4 execution id, which is what a stale browser tab still mints', async () => {
    withWorkflow()
    const res = await request(app, 'POST', '/workflows/wf-1/test', {
      body: { payload: {}, execution_id: '9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b' },
    })

    expect(res.status).toBe(400)
    // The message has to tell the person what to DO, and the action that clears
    // this state is a reload, because the id is minted by the page's own bundle
    // (L111).
    expect(((await res.json()) as { error: string }).error).toMatch(/reload/i)
  })

  it('does not run the workflow at all when it rejects the id', async () => {
    // A refusal that still executed would leave a real execution behind under an
    // id the archive cannot place, which is the exact row this guard exists to
    // prevent.
    withWorkflow()
    await request(app, 'POST', '/workflows/wf-1/test', {
      body: { payload: {}, execution_id: 'not-a-uuid' },
    })
    expect(vi.mocked(executeWorkflow)).not.toHaveBeenCalled()
  })

  it('still runs when no execution id is supplied, letting the engine mint one', async () => {
    // The webhook and replay paths send no id. Rejecting an ABSENT id would break
    // every caller that correctly leaves it to the engine.
    withWorkflow()
    vi.mocked(executeWorkflow).mockResolvedValue({
      response: { ok: true }, status: 200,
      executionId: 'exec-test', traceId: 'trace-test', idempotentReplay: false,
    })
    const res = await request(app, 'POST', '/workflows/wf-1/test', { body: { payload: {} } })
    expect(res.status).toBe(200)
    expect(vi.mocked(executeWorkflow)).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: undefined }),
      expect.anything(), expect.anything(), expect.anything()
    )
  })

  it('sets X-Trace-Id on the response', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(executeWorkflow).mockResolvedValue({
      response: { ok: true },
      status: 200,
      executionId: 'exec-test', traceId: 'trace-xyz',
      idempotentReplay: false,
    })

    const res = await request(app, 'POST', '/workflows/wf-1/test', { body: { payload: {} } })
    expect(res.headers.get('X-Trace-Id')).toBe('trace-xyz')
  })
})

describe('POST /workflows/:id/test-node', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(loadEnvVars).mockResolvedValue({})
    vi.mocked(executeNode).mockResolvedValue({ output: { ok: true } } as unknown as Awaited<ReturnType<typeof executeNode>>)
    app = await makeApp()
  })

  // Regression: the resume-from-execution branch must scope the execution lookup
  // to the (already org-verified) workflow via workflow_id. It previously filtered
  // by organization_id — a column that doesn't exist on workflow_executions — so
  // with the service-role client the query errored at runtime and this path always
  // 404'd. Typing the Supabase client now blocks the bad column at compile time;
  // this locks in the correct scoping at runtime.
  it('scopes the resume-from-execution lookup by workflow_id, not organization_id', async () => {
    const supa = makeSupabase({
      users: { single: testUser },
      workflows: { single: existingWorkflow },
      workflow_executions: { single: { trigger_payload: { lead: 'L1' }, trace_id: 'tr-old', source: 'webhook' } },
      execution_steps: { list: [] },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(supa as unknown as ReturnType<typeof createSupabaseClient>)

    const definition = {
      nodes: [{ id: 'n1', namespace: 'n1', type: 'exit', config: {} }],
      edges: [],
      trigger: { type: 'http_webhook', config: {} },
    }
    const res = await request(app, 'POST', '/workflows/wf-1/test-node', {
      body: { namespace: 'n1', definition, execution_id: 'exec-99' },
    })

    expect(res.status).toBe(200)
    const execFilters = supa.eqCalls['workflow_executions'] ?? []
    expect(execFilters).toContainEqual(['workflow_id', 'wf-1'])
    expect(execFilters.some(([col]) => col === 'organization_id')).toBe(false)
  })

  // branch_end has no config of its own. It passes through whatever ran before
  // it. The engine hands it the walk's chain output; this route has no walk, so
  // it must hand over the last step of the reconstructed context instead, or a
  // re-run of a branch_end silently yields null (#489).
  it('passes the last reconstructed step output to a branch_end node', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )

    const definition = {
      nodes: [{ id: 'be', namespace: 'converge', type: 'branch_end', config: {} }],
      edges: [],
      trigger: { type: 'http_webhook', config: {} },
    }
    const res = await request(app, 'POST', '/workflows/wf-1/test-node', {
      body: {
        namespace: 'converge',
        definition,
        steps: {
          enrich: { output: { from: 'enrich' }, status: 'completed' },
        },
      },
    })

    expect(res.status).toBe(200)
    expect(vi.mocked(executeNode)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'branch_end' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
      { from: 'enrich' }
    )
  })

  // #1681: re-running one node must see the same env as the workflow's run does,
  // its own workflow scoped values included, so it loads them for THIS workflow
  // and hands them to the node.
  it("loads the env for the workflow under test and hands it to the node", async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(loadEnvVars).mockResolvedValue({ PARTNER_URL: 'https://wf-1.example' })

    const definition = {
      nodes: [{ id: 'n1', namespace: 'n1', type: 'exit', config: {} }],
      edges: [],
      trigger: { type: 'http_webhook', config: {} },
    }
    const res = await request(app, 'POST', '/workflows/wf-1/test-node', { body: { namespace: 'n1', definition } })

    expect(res.status).toBe(200)
    expect(vi.mocked(loadEnvVars).mock.calls[0][4]).toEqual({ workflowId: 'wf-1' })
    const ctx = vi.mocked(executeNode).mock.calls[0][1]
    expect(ctx.env).toEqual({ PARTNER_URL: 'https://wf-1.example' })
  })
})

describe('GET /workflows/:id/timeout-suggestions', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  const wfRow = {
    id: 'wf-1',
    updated_at: '2026-06-11T00:00:00Z',
    definition: {
      nodes: [
        { id: 'equifax', namespace: 'equifax', type: 'code', config: { timeout_ms: 4000 } },
        { id: 'thin', namespace: 'thin', type: 'code', config: { timeout_ms: 1000 } },
      ],
    },
  }

  function kvEnv(kv: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> }) {
    return { ...testEnv, WORKFLOW_CACHE: kv } as unknown as Env
  }

  function requestWithEnv(env: Env) {
    return app.request('/workflows/wf-1/timeout-suggestions', {
      method: 'GET',
      headers: { Authorization: 'Bearer tok' },
    }, env, mockCtx)
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  it('returns 404 when the workflow does not belong to the org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, workflows: { single: null } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const kv = { get: vi.fn().mockResolvedValue(null), put: vi.fn() }
    const res = await requestWithEnv(kvEnv(kv))
    expect(res.status).toBe(404)
  })

  it('returns per-node suggestions from the grouped RPC and caches the payload', async () => {
    // equifax clears SAMPLE_CONFIDENT in the first (2h) window and must lock
    // there: the wider windows return different stats for it, which a correct
    // implementation ignores.
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: [
          { step_namespace: 'equifax', p50: 438, p99: 5000, max_ms: 11000, sample_size: 1996 },
          { step_namespace: 'thin', p50: 50, p99: 100, max_ms: 200, sample_size: 3 },
        ],
        error: null,
      })
      .mockResolvedValue({
        data: [
          { step_namespace: 'equifax', p50: 900, p99: 9000, max_ms: 20000, sample_size: 5000 },
          { step_namespace: 'thin', p50: 50, p99: 100, max_ms: 200, sample_size: 3 },
        ],
        error: null,
      })
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: { single: wfRow },
    }, { rpc }) as unknown as ReturnType<typeof createSupabaseClient>
    vi.mocked(createSupabaseClient).mockReturnValue(sb)

    const kv = { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) }
    const res = await requestWithEnv(kvEnv(kv))
    expect(res.status).toBe(200)
    const body = await res.json() as { window_days: number; nodes: Array<Record<string, unknown>> }

    // equifax has a real sample: default retries (2) -> suggested = p99 * 1.5,
    // computed from the FIRST window's stats (locked, despite the wider windows
    // reporting p99 9000 for it).
    expect(body.nodes).toHaveLength(1)
    expect(body.nodes[0]).toMatchObject({
      node_id: 'equifax',
      namespace: 'equifax',
      configured_ms: 4000,
      retries: 2,
      suggested_ms: 7500,
      p50: 438,
      p99: 5000,
      sample_size: 1996,
      window_days: 2 / 24,
    })
    // 'thin' never reached a confident sample, so the route widened through all
    // three windows before giving up on it.
    expect(rpc).toHaveBeenCalledTimes(3)
    expect(body.window_days).toBe(7)
    expect(kv.put).toHaveBeenCalledWith(
      'timeout-suggestions:v3:wf-1:2026-06-11T00:00:00Z',
      expect.any(String),
      { expirationTtl: 1800 }
    )
  })

  it('serves the KV-cached payload without hitting the RPC', async () => {
    const rpc = vi.fn()
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: { single: wfRow },
    }, { rpc }) as unknown as ReturnType<typeof createSupabaseClient>
    vi.mocked(createSupabaseClient).mockReturnValue(sb)

    const cached = { window_days: 1, nodes: [] }
    const kv = { get: vi.fn().mockResolvedValue(JSON.stringify(cached)), put: vi.fn() }
    const res = await requestWithEnv(kvEnv(kv))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cached)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('degrades to an empty node list when the RPC errors (statement timeout)', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'statement timeout' } })
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: { single: wfRow },
    }, { rpc }) as unknown as ReturnType<typeof createSupabaseClient>
    vi.mocked(createSupabaseClient).mockReturnValue(sb)

    const kv = { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) }
    const res = await requestWithEnv(kvEnv(kv))
    expect(res.status).toBe(200)
    const body = await res.json() as { nodes: unknown[] }
    expect(body.nodes).toEqual([])
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})

describe('POST /workflows/:id/test-node', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  const nodeBody = {
    namespace: 'n1',
    definition: { trigger: { id: 't', type: 'trigger', config: {} }, nodes: [{ id: 'n1', namespace: 'n1', type: 'filter', config: {} }], edges: [] },
    trigger_payload: {},
  }

  it('returns 404 when the workflow belongs to another org (before any deploy/execute)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null },  // cross-org: ownership fails
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-other/test-node', { body: nodeBody })
    expect(res.status).toBe(404)
  })

  it('passes ownership for the caller’s own workflow (reaches the handler body)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    // Omit `definition` so the handler answers 400 — proves it got PAST the
    // ownership check (404) into its own validation, without exercising the
    // code-deploy / executeNode path.
    const res = await request(app, 'POST', '/workflows/wf-1/test-node', { body: { namespace: 'n1' } })
    expect(res.status).toBe(400)
  })
})

// #595: these three handlers end their write in .update().select().single().
// PostgREST answers a zero-row match there with PGRST116, which the old
// `if (error) return dbError(c, error)` turned into a 500. It must read as a 404,
// while a genuine DB error must still surface as a retryable 500. In this local
// mock a write's terminal .single() resolves from the from()-call's `single`
// config, `updateError` models a real DB failure, and `single: null` a zero-row
// match.
describe('PATCH /workflows/:id/test-payloads: zero-row 404 vs real DB error (#595)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  const payloadBody = { test_payloads: [{ name: 'lead', payload: { lead_id: 'L1' } }] }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  it('returns 404 (not 500) when the update matches zero rows', async () => {
    // This handler has no prior ownership read, so the write is the only guard:
    // a zero-row match must read as not-found, not a 500 reachable by any caller.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PATCH', '/workflows/wf-gone/test-payloads', { body: payloadBody })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Workflow not found' })
  })

  it('returns 500 (not a false 404) when the update hits a real DB error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { updateError: { code: '42P01', message: 'relation missing' } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PATCH', '/workflows/wf-1/test-payloads', { body: payloadBody })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal error' })
  })

  it('returns 200 with the saved payloads on the happy path', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: { test_payloads: payloadBody.test_payloads } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PATCH', '/workflows/wf-1/test-payloads', { body: payloadBody })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ test_payloads: payloadBody.test_payloads })
    // The write moved the row's stamp, so the last-good copy follows it (#1845).
    expect(vi.mocked(refreshWorkflowCaches)).toHaveBeenCalledWith('wf-1', testEnv.WORKFLOW_CACHE, routeClient())
  })

  // Test payloads change nothing a live lead runs: a copy left holding the old
  // payloads serves the same definition, so warning the person would be untrue.
  // The failed refresh is logged, and the answer is the plain success.
  it('answers saved payloads as saved, with no warning and a logged failure, when the cache refresh fails (#1845)', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(refreshWorkflowCaches).mockRejectedValueOnce(new Error('kv unavailable'))
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: { test_payloads: payloadBody.test_payloads } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PATCH', '/workflows/wf-1/test-payloads', { body: payloadBody })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ test_payloads: payloadBody.test_payloads })
    expect(logged.mock.calls.flat().join(' ')).toMatch(/workflow wf-1 caches could not be refreshed/)
  })
})

// #595: a write that matched no row must read as not found, a real database
// error as a 500, and neither may audit or refresh anything. Since #1947 both
// arrive as write_workflow's own answers (workflow_not_found, or an error).
describe('PUT and PATCH: a write that found no workflow is a 404, a database error a 500 (#595, #1947)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
    app = await makeApp()
  })

  const notFound = () => ({ data: null, error: { code: 'P0002', message: 'workflow_not_found' } })
  const broken = () => ({ data: null, error: { code: '42P01', message: 'relation missing' } })

  it.each([
    ['PUT', { name: 'Renamed' }],
    ['PATCH', { is_active: false }],
  ])('%s returns 404 (not 500), skips audit and cache when write_workflow finds no workflow', async (method, body) => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, workflows: { single: existingWorkflow } }, { write: notFound }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, method, '/workflows/wf-1', { body })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Workflow not found' })
    expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it.each([
    ['PUT', { name: 'Renamed' }],
    ['PATCH', { is_active: false }],
  ])('%s returns 500 (not a false 404) when write_workflow hits a real database error', async (method, body) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, workflows: { single: existingWorkflow } }, { write: broken }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, method, '/workflows/wf-1', { body })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal error' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('PUT returns 200 with the written workflow on the happy path', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase(
        { users: { single: testUser }, workflows: { single: existingWorkflow } },
        { write: () => ({ data: { workflow: { ...existingWorkflow, name: 'Renamed', version: 5 }, version_id: 'ver-1', version_number: 2 }, error: null }) },
      ) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { name: 'Renamed' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ version_id: 'ver-1', name: 'Renamed', version: 5 })
  })

  it('PATCH returns 200 with the written fields on the happy path', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, workflows: { single: existingWorkflow } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: false } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 'wf-1', is_active: false })
  })
})

// ── #1117: code node scripts are stripped of trailing whitespace on every write path ──
//
// Pasted scripts arrive padded to a column with trailing spaces, the wrapping editor drew
// each padded line as a blank row, and nothing trimmed them on save, so once pasted they
// were permanent. The canvas strips on its own save path; the worker strips again on every
// path that writes a definition, so restores, API writes and any future importer share the
// rule. A line inside a template literal is VALUE, not noise, and must survive.
describe('code node script hygiene on every definition write (#1117)', () => {
  const padded = 'const a = 1;    \nconst body = `keep   \n`;   \nreturn body;   '
  const clean = 'const a = 1;\nconst body = `keep   \n`;\nreturn body;'
  const paddedDefinition = { nodes: [{ id: 'c1', type: 'code', namespace: 'c1', config: { script: padded } }], edges: [] }
  let app: Awaited<ReturnType<typeof makeApp>>

  // One write_workflow call writes the snapshot and the row from the same definition (#1947).
  const scriptsWritten = (sb: ReturnType<typeof makeSupabase>, op: string) =>
    writesOf(sb, op).map((w) => ((w.p_fields.definition as { nodes?: Array<{ config?: { script?: string } }> } | undefined)?.nodes ?? []).map((n) => n.config?.script))

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
    app = await makeApp()
  })

  it('PUT strips the script in both the version snapshot and the live definition', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
      workflow_versions: [{ single: { version_number: 1 } }, { insertResult: { id: 'ver-2', version_number: 2, workflow_id: 'wf-1' } }],
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: paddedDefinition } })
    expect(res.status).toBe(200)
    expect(scriptsWritten(sb, 'save')).toEqual([[clean]])
  })

  it('POST strips the script of a newly created workflow', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: { insertResult: { id: 'wf-new', name: 'New', definition: paddedDefinition } },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New', definition: paddedDefinition } })
    expect(res.status).toBe(201)
    expect(scriptsWritten(sb, 'create')).toEqual([[clean]])
  })

  it('restore strips the script of the version being restored', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflow_versions: { single: { id: 'ver-1', definition: paddedDefinition, version_number: 1 } },
      workflows: { single: existingWorkflow },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(res.status).toBe(200)
    expect(scriptsWritten(sb, 'restore')).toEqual([[clean]])
  })

  it('duplicate strips the script of the clone', async () => {
    const source = { name: 'Lead Routing', description: null, definition: paddedDefinition, folder_id: null, is_active: true, lane: 'money' }
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: source } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(201)
    expect(scriptsWritten(sb, 'duplicate')).toEqual([[clean]])
  })
})

// New and duplicated workflows start switched off (#1706). A workflow written by
// the Pipedream converter or an API caller must not take traffic before a person
// has looked at it and switched it on through PATCH, which keeps its safeguards.
describe('new and duplicated workflows start inactive (#1706)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  // write_workflow creates every workflow switched off and refuses an is_active
  // field on create or duplicate (supabase/tests/write_workflow.test.sql A, F),
  // so each create or duplicate the route sends must carry none: true per write.
  const switchedOffCreates = (sb: ReturnType<typeof makeSupabase>) =>
    sb.writes.filter((w) => w.p_op === 'create' || w.p_op === 'duplicate').map((w) => !Object.hasOwn(w.p_fields, 'is_active'))

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  // Create stored a definition whose nodes held entries that were not objects
  // until #2190; it now refuses one by name and creates nothing, switched off or not.
  it('POST refuses a definition whose nodes hold entries that are not objects, and creates nothing (#2190)', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: { insertResult: { id: 'wf-new', name: 'New', is_active: false } },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const definition = { nodes: [null, 5, 'x'], edges: [], trigger: { type: 'http_webhook', config: {} } }
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New', definition } })
    expect(res.status).toBe(400)
    expect(switchedOffCreates(sb)).toEqual([])
  })

  it('POST creates the workflow with is_active false', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: { insertResult: { id: 'wf-new', name: 'New', is_active: false } },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New' } })
    expect(res.status).toBe(201)
    expect(switchedOffCreates(sb)).toEqual([true])
  })

  // A definition can enter by create as well as by save, so create holds it to the
  // same Salesforce write option rule (#2170), and inserts nothing when it fails.
  it('POST refuses a definition carrying a malformed Salesforce write option, naming the step, and inserts nothing', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: { insertResult: { id: 'wf-new', name: 'New', is_active: false } },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const definition = {
      nodes: [{ id: 'a', namespace: 'inquiry_apex', type: 'salesforce', config: { operation: 'apex', apex_path: '/x', omit_fields: ['a'] } }],
      edges: [],
      trigger: { type: 'http_webhook', config: {} },
    }
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New', definition } })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('inquiry_apex: omit_fields applies only to create, update and upsert')
    expect(switchedOffCreates(sb)).toEqual([])
  })

  // #2590: a created workflow is switched off, so a half built lead validation
  // step is saved, as it would be on a switched off workflow's save.
  it('POST creates a workflow holding a half built lead validation step, switched off', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: { insertResult: { id: 'wf-new', name: 'New', is_active: false } },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const definition = {
      nodes: [{ id: 'v', namespace: 'validate', type: 'lead_validation', config: { lead_id_field: '', checks: [] } }],
      edges: [{ id: 'e0', source: 'trigger', target: 'v' }],
      trigger: { type: 'http_webhook', config: {} },
    }
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New', definition } })
    expect(res.status).toBe(201)
    expect(switchedOffCreates(sb)).toEqual([true])
  })

  // #2590: the placement rule holds at create too, and nothing is inserted.
  it('POST refuses a lead validation step inside a parallel block, and inserts nothing', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: { insertResult: { id: 'wf-new', name: 'New', is_active: false } },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const definition = {
      nodes: [
        { id: 'p', namespace: 'fan_out', type: 'parallel', config: {} },
        { id: 'v', namespace: 'validate', type: 'lead_validation', config: {} },
        { id: 'end', namespace: 'join', type: 'parallel_end', config: {} },
      ],
      edges: [{ id: 'e1', source: 'p', target: 'v', source_handle: 'child-0' }, { id: 'e2', source: 'v', target: 'end' }],
      trigger: { type: 'http_webhook', config: {} },
    }
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New', definition } })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toMatch(/^validate: A lead validation step cannot run inside a parallel block/)
    expect(switchedOffCreates(sb)).toEqual([])
  })

  it('POST ignores an is_active true sent in the body', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: { insertResult: { id: 'wf-new', name: 'New', is_active: false } },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New', is_active: true } })
    expect(res.status).toBe(201)
    expect(switchedOffCreates(sb)).toEqual([true])
  })

  it('duplicating an ACTIVE workflow creates an inactive copy', async () => {
    const source = { name: 'Live Flow', description: null, definition: { nodes: [], edges: [] }, folder_id: null, is_active: true, lane: 'money' }
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: source } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(201)
    expect(switchedOffCreates(sb)).toEqual([true])
  })
})

// The step id rename rewrites partner formulas through rename_partner_step_namespace
// (#1409), so the actor, reason and workflow ride on the audit row the table trigger
// writes. The route writes no audit row of its own any more.
describe('POST /workflows/:id/rename-apply rewrites partner formulas through the database function', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const partners = [
    { id: 'p-1', name: 'Tripoint', slug: 'tripoint', bid_formula: 'steps.old_ns.output.debt * 0.001', bid_resolver_config: { formula: 'steps.old_ns.output.debt * 2' } },
    { id: 'p-2', name: 'AmOne', slug: 'amone', bid_formula: 'steps.other.output.x', bid_resolver_config: null },
  ]

  beforeEach(async () => {
    vi.clearAllMocks()
    kvDeleted.length = 0
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  // #1846: a rewritten formula makes the partner's stored copy (the one the
  // Partner Bid node bids from in a database outage) describe a formula that no
  // longer exists, so each partner the function touched has its copy retired.
  it('retires the stored copy of each partner it rewrote, and of no other', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 1, error: null })
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, workflows: { single: existingWorkflow }, partner_configs: { list: partners } }, { rpc }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/rename-apply', { body: { old: 'old_ns', new: 'new_ns', partner_ids: ['p-1', 'p-2'] } })
    expect(res.status).toBe(200)
    expect(kvDeleted).toEqual(['partner-lastgood:p-1'])
  })

  // One partner's copy that cannot be retired must not stop the others being
  // rewritten, or the rename is left half applied with no way to tell which (#1846).
  it('rewrites every partner when one copy cannot be retired, and answers with a warning naming that partner', async () => {
    const both = [partners[0], { ...partners[0], id: 'p-3', name: 'Dot818', slug: 'dot818' }]
    const rpc = vi.fn().mockResolvedValue({ data: 1, error: null })
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, workflows: { single: existingWorkflow }, partner_configs: { list: both } }, { rpc }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const cache = testEnv.WORKFLOW_CACHE as unknown as { delete: (k: string) => Promise<void> }
    const realDelete = cache.delete
    cache.delete = async (k: string) => { if (k === 'partner-lastgood:p-1') throw new Error('kv unavailable'); kvDeleted.push(k) }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await request(app, 'POST', '/workflows/wf-1/rename-apply', { body: { old: 'old_ns', new: 'new_ns', partner_ids: ['p-1', 'p-3'] } })
      expect(rpc).toHaveBeenCalledTimes(2)
      expect(kvDeleted).toEqual(['partner-lastgood:p-3'])
      expect(res.status).toBe(200)
      const body = (await res.json()) as { updated: number; copies_not_cleared: string[]; stored_copy_warning?: string }
      expect(body.updated).toBe(2)
      expect(body.copies_not_cleared).toEqual(['p-1'])
      expect(body.stored_copy_warning).toMatch(/repaired automatically/i)
    } finally {
      cache.delete = realDelete
    }
  })

  it('calls the function once per partner whose formulas reference the old namespace, with both rewritten columns and the context', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 1, error: null })
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, workflows: { single: existingWorkflow }, partner_configs: { list: partners } }, { rpc }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/rename-apply', { body: { old: 'old_ns', new: 'new_ns', partner_ids: ['p-1', 'p-2'] } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ updated: 1 })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('rename_partner_step_namespace', {
      p_org: USER_ORG,
      p_partner: 'p-1',
      p_columns: { bid_formula: 'steps.new_ns.output.debt * 0.001', bid_resolver_config: { formula: 'steps.new_ns.output.debt * 2' } },
      p_actor: 'user-1',
      p_actor_email: 'dan@pennie.com',
      p_context: { reason: 'step_id_renamed', workflow_id: 'wf-1', old_namespace: 'old_ns', new_namespace: 'new_ns' },
    })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('does not count a partner the function reports as untouched (it vanished between the read and the write, #588), and logs the zero row write', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rpc = vi.fn().mockResolvedValue({ data: 0, error: null })
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, workflows: { single: existingWorkflow }, partner_configs: { list: [partners[0]] } }, { rpc }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/rename-apply', { body: { old: 'old_ns', new: 'new_ns', partner_ids: ['p-1'] } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ updated: 0 })
    expect(kvDeleted).toEqual([])
    const warned = warnSpy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
    expect(warned).toContainEqual(expect.objectContaining({
      event: 'zero_row_write',
      target: 'partner_configs.step_id_rename',
      partner_id: 'p-1',
    }))
  })

  // A real database error is not a vanished partner: it must abort with a 500,
  // never be swallowed as a skip.
  it('surfaces a real database error from the function as a 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, workflows: { single: existingWorkflow }, partner_configs: { list: [partners[0]] } }, { rpc }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/rename-apply', { body: { old: 'old_ns', new: 'new_ns', partner_ids: ['p-1'] } })
    expect(res.status).toBe(500)
  })
})

// #2149: the workflow side of the pair. On 2026-10-13 Tripoint's profile gained
// a 2,000 minimum loan amount while the live Engine buyer_select step had no
// loan amount template; a canvas edit dropping the template reaches the same
// state from this side, so a save that would make a live buyer step unable to
// read an enabled profile's rule is refused, naming the buyer and the rule.
describe('a live buyer step that cannot read a buyer profile rule (#2149)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const tripoint: LoadedBuyer = {
    partner: { id: 'p-tripoint', slug: 'tripoint', name: 'Tripoint', is_active: true, api_endpoint: null, cf_secret_key: null, outbound_field_mapping: null, extra_extraction: null, accept_signals: [], response_classification: null, click_url: null, external_routing_code: null, duplicate_signals: [], circuit_enabled: false, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 30 },
    profile: { partnerId: 'p-tripoint', soldOn: 'offer', isEnabled: true, priority: 1, allowedStates: ['TX'], debtMin: null, debtMax: null, loanAmountMin: 2000, hourlyLeadCap: null, dailyLeadCap: null, hourlySpendCapCents: null, dailySpendCapCents: null, windows: [], blackoutDates: [], tiers: [{ population: 'engine', debtFrom: 0, debtTo: null, multiplier: 0.001 }] },
    version: 1,
    updated_at: '2026-10-13T15:30:00.000Z',
  }
  const select = (extra: Record<string, unknown> = {}) => ({ nodes: [{ id: 'bs', namespace: 'buyer_select', type: 'buyer_select', config: { mode: 'live', population: 'engine', state: '{{s}}', debt: '{{d}}', ...extra } }], edges: [] })
  const noLoan = select()
  const withLoan = select({ loan_amount: '{{trigger.payload.loanInformation.loanAmount}}' })
  const live = (definition: unknown, isActive = true) => ({ ...existingWorkflow, name: 'Engine Bidding Workflow', is_active: isActive, definition })

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
    vi.mocked(loadBuyerProfiles).mockResolvedValue({ org_id: USER_ORG, loaded_at: '2026-10-18T00:00:00.000Z', content_hash: 'h', served_from: 'database', buyers: [tripoint] })
    app = await makeApp()
  })

  const client = (tables: Record<string, TableConfig | TableConfig[]>) =>
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser }, ...tables }) as unknown as ReturnType<typeof createSupabaseClient>)

  it('PUT on a live workflow that drops the loan amount template is 422 naming the step, the buyer and the rule, and writes no version', async () => {
    client({ workflows: [{ single: live(withLoan) }, { single: live(noLoan) }], workflow_versions: [{ single: { version_number: 1 } }, { insertResult: { id: 'ver-2' } }] })
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: noLoan } })
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('Step buyer_select has no Loan amount template')
    expect(body.error).toContain('Tripoint')
    expect(body.error).toContain('a minimum loan amount of 2,000')
    expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('PUT on a switched off workflow saves, since it judges no lead; switching it on is checked', async () => {
    client({ workflows: [{ single: live(withLoan, false) }, { single: live(noLoan, false) }], workflow_versions: [{ single: { version_number: 1 } }, { insertResult: { id: 'ver-2' } }] })
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: noLoan } })
    expect(res.status).toBe(200)
  })

  it('PUT on a live workflow whose step reads every rule saves', async () => {
    client({ workflows: [{ single: live(noLoan) }, { single: live(withLoan) }], workflow_versions: [{ single: { version_number: 1 } }, { insertResult: { id: 'ver-2' } }] })
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: withLoan } })
    expect(res.status).toBe(200)
  })

  it('PATCH switching on a workflow whose step cannot read a rule is 422, and the switch is not written', async () => {
    client({ workflows: [{ single: live(noLoan, false) }, { single: { id: 'wf-1', is_active: true } }] })
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toContain('Loan amount')
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('PATCH switching off is never refused', async () => {
    client({ workflows: [{ single: live(noLoan) }, { single: { id: 'wf-1', is_active: false } }] })
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: false } })
    expect(res.status).toBe(200)
  })

  it('restoring a version that cannot read a rule onto a live workflow is 422, and nothing is written', async () => {
    client({
      workflows: [{ single: live(withLoan) }, { list: [{ id: 'wf-1' }] }],
      workflow_versions: [{ single: { id: 'ver-1', definition: noLoan, version_number: 1 } }, { single: { version_number: 3 } }, { insertResult: { id: 'ver-4' } }],
    })
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(res.status).toBe(422)
    expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
  })

  it('a save is refused with 503 when the buyer profiles cannot be read, never let through as if none were enabled', async () => {
    vi.mocked(loadBuyerProfiles).mockRejectedValue(new Error('buyer profiles read failed'))
    client({ workflows: [{ single: live(withLoan) }, { single: live(noLoan) }], workflow_versions: [{ single: { version_number: 1 } }, { insertResult: { id: 'ver-2' } }] })
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: noLoan } })
    expect(res.status).toBe(503)
  })

  it('a definition with no buyer step never reads the profiles', async () => {
    const codeOnly = { nodes: [{ id: 'c', namespace: 'c', type: 'code', config: { script: 'x' } }], edges: [] }
    client({ workflows: [{ single: live({ nodes: [] }) }, { single: live(codeOnly) }], workflow_versions: [{ single: { version_number: 1 } }, { insertResult: { id: 'ver-2' } }] })
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: codeOnly } })
    expect(res.status).toBe(200)
    expect(vi.mocked(loadBuyerProfiles)).not.toHaveBeenCalled()
  })
})

// Every definition writer re-checks the connection ids it would write (#2338,
// build PR 7): a removed connection, or one of another organization, is refused
// by name with nothing written; a check that cannot be made refuses too; and a
// definition naming no connection is written exactly as before.
describe('workflow definition writers re-check connection ids (#2338)', () => {
  const REMOVED = '33333333-3333-3333-3333-333333333301'
  const ELSEWHERE = '33333333-3333-3333-3333-333333333302'
  const naming = (id: string) => ({ nodes: [{ id: 'n1', namespace: 'sf_import', type: 'code', config: { script: 'return 1', connection_id: id } }], edges: [] })
  const removedRow = { connection_id: REMOVED, problem: 'removed', name: 'Pennie Salesforce', steps: ['sf_import'] }
  const elsewhereRow = { connection_id: ELSEWHERE, problem: 'not_this_organization', name: null, steps: ['sf_import'] }
  const triggerRefusal = {
    code: 'BP409',
    message: 'workflow_names_missing_connection',
    details: JSON.stringify([{ id: REMOVED, problem: 'removed', name: 'Pennie Salesforce', steps: ['sf_import'] }]),
  }
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
    app = await makeApp()
  })

  /** The check answering with these rows, or failing with this error. */
  const checkAnswering = (answer: { data: unknown; error: unknown }) =>
    vi.fn(async (name: string, _args: unknown) => (name === 'definition_connection_problems' ? answer : { data: null, error: null }))

  // Every write is one write_workflow call since #1947, which writes a save's
  // snapshot with its row; any direct write to either table is counted too.
  const writes = (sb: ReturnType<typeof makeSupabase>) => ({
    workflows: [...sb.writes, ...(sb.calls.workflows ?? []).filter(([m]) => m === 'insert' || m === 'update' || m === 'upsert')],
    versions: (sb.calls.workflow_versions ?? []).filter(([m]) => m === 'insert' || m === 'update' || m === 'upsert'),
  })

  type Tables = Record<string, TableConfig | TableConfig[]>
  /** Each writer, with the tables it reads before its first write and the definition it would write. */
  const writers: Array<{ label: string; method: string; path: string; body: unknown; tables: Tables }> = [
    {
      label: 'POST / (create)',
      method: 'POST', path: '/workflows', body: { name: 'New', definition: naming(REMOVED) },
      tables: { workflows: { insertResult: { id: 'wf-new' } } },
    },
    {
      label: 'PUT /:id (save)',
      method: 'PUT', path: '/workflows/wf-1', body: { ...saveKeys, definition: naming(REMOVED) },
      tables: {
        workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
        workflow_versions: [{ single: { version_number: 1 } }, { insertResult: { id: 'ver-2', version_number: 2 } }],
      },
    },
    {
      label: 'POST /:id/duplicate',
      method: 'POST', path: '/workflows/wf-1/duplicate', body: undefined,
      tables: {
        workflows: [{ single: { name: 'Lead Routing', description: null, definition: naming(REMOVED), folder_id: null } }, { insertResult: { id: 'wf-copy' } }],
        workflow_versions: [{ list: [] }, { insertResult: {} }],
      },
    },
    {
      label: 'POST /:id/versions/:version_id/restore',
      method: 'POST', path: '/workflows/wf-1/versions/ver-1/restore', body: undefined,
      tables: {
        workflows: [{ single: existingWorkflow }, { list: [{ id: 'wf-1' }] }],
        workflow_versions: [{ single: { id: 'ver-1', definition: naming(REMOVED), version_number: 1 } }, { single: { version_number: 3 } }, { insertResult: { id: 'ver-4' } }],
      },
    },
  ]

  it.each(writers)('$label refuses a removed connection with 409, naming it and its step, and writes nothing', async (w) => {
    const sb = makeSupabase({ users: { single: testUser }, ...w.tables }, { rpc: checkAnswering({ data: [removedRow], error: null }) })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, w.method, w.path, { body: w.body })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; code: string; missing_connections: unknown[] }
    expect(body.code).toBe('workflow_connection_missing')
    expect(body.error).toBe('Nothing was saved. The step sf_import names the connection "Pennie Salesforce", which was removed. Give the step a replacement connection, then save again.')
    expect(body.missing_connections).toEqual([{ id: REMOVED, problem: 'removed', name: 'Pennie Salesforce', steps: ['sf_import'] }])
    expect(writes(sb)).toEqual({ workflows: [], versions: [] })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
  })

  it.each(writers)('$label asks the check with the caller\'s organization and the definition it would write', async (w) => {
    const rpc = checkAnswering({ data: [], error: null })
    const sb = makeSupabase({ users: { single: testUser }, ...w.tables }, { rpc })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, w.method, w.path, { body: w.body })
    expect(res.status).toBeLessThan(300)
    expect(rpc).toHaveBeenCalledWith('definition_connection_problems', { p_organization_id: USER_ORG, p_definition: naming(REMOVED) })
  })

  it('refuses another organization\'s connection by its id, never by a name', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
      workflow_versions: [{ single: { version_number: 1 } }, { insertResult: { id: 'ver-2', version_number: 2 } }],
    }, { rpc: checkAnswering({ data: [elsewhereRow], error: null }) })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: naming(ELSEWHERE) } })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toBe(`Nothing was saved. The step sf_import names a connection that is not one of this organization's (${ELSEWHERE}). Give the step a replacement connection, then save again.`)
    expect(writes(sb)).toEqual({ workflows: [], versions: [] })
  })

  it.each(writers)('$label answers a connection lookup that failed with 503 and writes nothing, never saving unchecked', async (w) => {
    const sb = makeSupabase({ users: { single: testUser }, ...w.tables }, {
      rpc: checkAnswering({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }),
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, w.method, w.path, { body: w.body })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { code: string }).code).toBe('workflow_connection_check_failed')
    expect(writes(sb)).toEqual({ workflows: [], versions: [] })
  })

  it.each(writers)('$label answers a check that does not exist yet (its migration unapplied) with a named 503 and writes nothing', async (w) => {
    const sb = makeSupabase({ users: { single: testUser }, ...w.tables }, {
      rpc: checkAnswering({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.definition_connection_problems(p_definition, p_organization_id) in the schema cache' } }),
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, w.method, w.path, { body: w.body })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { code: string }).code).toBe('workflow_connection_check_unavailable')
    expect(writes(sb)).toEqual({ workflows: [], versions: [] })
  })

  it('a save sending no definition writes none and asks no check', async () => {
    const rpc = checkAnswering({ data: [removedRow], error: null })
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: [{ single: existingWorkflow }, { single: { ...existingWorkflow, name: 'Renamed' } }],
      workflow_versions: [{ single: { version_number: 1 } }, { insertResult: { id: 'ver-2', version_number: 2 } }],
    }, { rpc })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { name: 'Renamed' } })
    expect(res.status).toBe(200)
    expect(rpc).not.toHaveBeenCalledWith('definition_connection_problems', expect.anything())
  })

  // The trigger refuses inside write_workflow's transaction, so the snapshot
  // goes with the row (supabase/tests/write_workflow.test.sql G): nothing is
  // left to take back, and the refusal is still answered by name.
  it.each([
    { label: 'PUT /:id (save)', method: 'PUT', path: '/workflows/wf-1', body: { ...saveKeys, definition: naming(REMOVED) } as unknown, tables: { workflows: { single: existingWorkflow } } as Tables },
    { label: 'POST /:id/versions/:version_id/restore', method: 'POST', path: '/workflows/wf-1/versions/ver-1/restore', body: undefined as unknown, tables: {
      workflows: { single: existingWorkflow }, workflow_versions: { single: { id: 'ver-1', definition: naming(REMOVED), version_number: 1 } },
    } as Tables },
    { label: 'POST / (create)', method: 'POST', path: '/workflows', body: { name: 'New', definition: naming(REMOVED) } as unknown, tables: {} as Tables },
    { label: 'POST /:id/duplicate', method: 'POST', path: '/workflows/wf-1/duplicate', body: undefined as unknown, tables: {
      workflows: { single: { name: 'Lead Routing', description: null, definition: naming(REMOVED), folder_id: null, lane: 'money' } },
    } as Tables },
  ])('$label that lost the race to a removal is answered by name, never as an internal error, and takes nothing back by hand', async (w) => {
    const sb = makeSupabase({ users: { single: testUser }, ...w.tables }, { write: () => ({ data: null, error: triggerRefusal }) })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await request(app, w.method, w.path, { body: w.body })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; error: string }
    expect(body.code).toBe('workflow_connection_missing')
    expect(body.error).toContain('"Pennie Salesforce", which was removed')
    expect((sb.calls.workflow_versions ?? []).filter(([m]) => m === 'delete' || m === 'insert')).toEqual([])
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
  })

  // The money workflows the money gate replays: a save of each, and a create of
  // each, writes the definition byte for byte as the route wrote it before the
  // check existed (the sanitised definition, nothing added or reordered).
  const money = [MONEY_MAIN_FLOW, MONEY_RML_GIGFI, MONEY_LEAD_ECONOMY, MONEY_LIBERTY1_CLICK, MONEY_ENGINE, MONEY_RML_LENDSWIFT, MONEY_DELEGATE_GMAIL] as unknown as Array<{ id: string; name: string; definition: Record<string, unknown> }>

  it('reads the money workflows it exists to check, each with steps (a fixture with none would pass on nothing)', () => {
    expect(money.map((m) => m.name)).toEqual(expect.arrayContaining(['Main Flow', 'Engine Bidding Workflow']))
    for (const m of money) expect((m.definition.nodes as unknown[]).length).toBeGreaterThan(0)
  })

  it.each(money)('a save of the money workflow $name writes its definition byte for byte as before', async (m) => {
    const expected = JSON.stringify(sanitizeCodeNodeScripts(structuredClone(m.definition) as { nodes?: unknown }))
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, id: m.id, is_active: false } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', `/workflows/${m.id}`, { body: { ...saveKeys, definition: m.definition } })
    expect(res.status).toBe(200)
    // One write_workflow call writes the snapshot and the row from this definition.
    expect(writesOf(sb, 'save').map((w) => JSON.stringify(w.p_fields.definition))).toEqual([expected])
  })

  it.each(money)('a create of the money workflow $name writes its definition byte for byte as before', async (m) => {
    const expected = JSON.stringify(sanitizeCodeNodeScripts(structuredClone(m.definition) as { nodes?: unknown }))
    const sb = makeSupabase({ users: { single: testUser } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows', { body: { name: m.name, definition: m.definition } })
    expect(res.status).toBe(201)
    expect(writesOf(sb, 'create').map((w) => JSON.stringify(w.p_fields.definition))).toEqual([expected])
  })

  // #2576: switching a workflow on writes no definition, so the trigger never
  // judges it; the route asks the same check about the definition it makes live.
  describe('PATCH /:id switching a workflow on (#2576)', () => {
    const live = { id: 'wf-1', name: 'Achieve report import', is_active: false, definition: naming(REMOVED), version: 9, lane: 'money' }
    const patchTables = (): Tables => ({ workflows: [{ single: live }, { single: { id: 'wf-1', name: live.name, is_active: true, folder_id: null, updated_at: '2026-10-21T15:00:00Z' } }] })

    it('refuses to switch on a workflow naming a removed connection, by name, and writes nothing', async () => {
      const sb = makeSupabase({ users: { single: testUser }, ...patchTables() }, { rpc: checkAnswering({ data: [removedRow], error: null }) })
      vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
      expect(res.status).toBe(409)
      const body = await res.json() as { error: string; code: string; missing_connections: unknown[] }
      expect(body.code).toBe('workflow_connection_missing')
      expect(body.error).toBe('The workflow was not switched on. The step sf_import names the connection "Pennie Salesforce", which was removed. Give the step a replacement connection and save it, then switch the workflow on.')
      expect(body.missing_connections).toEqual([{ id: REMOVED, problem: 'removed', name: 'Pennie Salesforce', steps: ['sf_import'] }])
      expect(writes(sb).workflows).toEqual([])
      expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
      expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
    })

    it('asks the check with the caller\'s organization and the stored definition, then switches it on', async () => {
      const rpc = checkAnswering({ data: [], error: null })
      const sb = makeSupabase({ users: { single: testUser }, ...patchTables() }, { rpc })
      vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
      expect(res.status).toBe(200)
      expect(rpc).toHaveBeenCalledWith('definition_connection_problems', { p_organization_id: USER_ORG, p_definition: naming(REMOVED) })
      // Switched on from the version whose definition was checked (#1947).
      expect(sb.writes).toEqual([expect.objectContaining({ p_op: 'patch', p_expected_version: 9, p_fields: { is_active: true } })])
    })

    it.each([
      { what: 'a lookup that failed', error: { code: '57014', message: 'canceling statement due to statement timeout' }, code: 'workflow_connection_check_failed' },
      { what: 'a check that does not exist yet', error: { code: 'PGRST202', message: 'Could not find the function' }, code: 'workflow_connection_check_unavailable' },
    ])('answers $what with a named 503 and never switches on unchecked', async ({ error, code }) => {
      const sb = makeSupabase({ users: { single: testUser }, ...patchTables() }, { rpc: checkAnswering({ data: null, error }) })
      vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
      expect(res.status).toBe(503)
      const body = (await res.json()) as { code: string; error: string }
      expect(body.code).toBe(code)
      expect(body.error.startsWith('The workflow was not switched on.')).toBe(true)
      expect(writes(sb).workflows).toEqual([])
    })

    it.each([
      { what: 'switching off', body: { is_active: false } },
      { what: 'moving it to a folder', body: { folder_id: null } },
    ])('asks no check when $what, which makes nothing live', async ({ body }) => {
      const rpc = checkAnswering({ data: [removedRow], error: null })
      const sb = makeSupabase({ users: { single: testUser }, ...patchTables() }, { rpc })
      vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request(app, 'PATCH', '/workflows/wf-1', { body })
      expect(res.status).toBe(200)
      expect(rpc).not.toHaveBeenCalledWith('definition_connection_problems', expect.anything())
    })
  })
})

// definition_schema_version (#1947): which rules a stored definition is judged
// by. The Worker stamps it on every definition write and never takes it from
// the caller. A definition this request wrote is stamped with the version this
// build checks by; a copied one (a restore, a duplicate, a snapshot of the
// stored definition) keeps the stamp of the row it came from, unstamped
// included, so an old definition is never relabelled as checked under rules
// it never met. 7 stands for a stamp other than this build's version 1, so a
// copy is seen to carry the stamp rather than to happen to equal it.
describe('definition_schema_version is stamped by the Worker on every definition write (#1947)', () => {
  const CURRENT = 1
  const definition = { nodes: [], edges: [], trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } } }
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
    app = await makeApp()
  })

  // Since #1947 the stamp of a copied definition (a restore, a duplicate, the
  // snapshot of a save that sends no definition) is decided by write_workflow
  // from the row it copies, and the route may not send one: the function
  // refuses it as field_not_writable. supabase/tests/write_workflow.test.sql
  // proves the copy keeps the row's stamp (B rename, C restore, F duplicate).
  // A definition the request wrote carries this build's stamp, never the caller's.
  const stampSent = (sb: ReturnType<typeof makeSupabase>, op: string) =>
    writesOf(sb, op).map((w) => (Object.hasOwn(w.p_fields, 'definition_schema_version') ? w.p_fields.definition_schema_version : 'absent'))

  it('POST / stamps a new workflow with the current version, whatever stamp the caller sends', async () => {
    const sb = makeSupabase({ users: { single: testUser } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New', definition, definition_schema_version: 99 } })
    expect(res.status).toBe(201)
    expect(stampSent(sb, 'create')).toEqual([CURRENT])
  })

  it('POST / stamps the default definition it writes when the caller sends none', async () => {
    const sb = makeSupabase({ users: { single: testUser } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New' } })
    expect(res.status).toBe(201)
    expect(stampSent(sb, 'create')).toEqual([CURRENT])
  })

  it('PUT with a definition stamps it with the current version, whatever the caller sends', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, definition_schema_version: 7 } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition, definition_schema_version: 99 } })
    expect(res.status).toBe(200)
    expect(stampSent(sb, 'save')).toEqual([CURRENT])
  })

  it.each([
    { what: 'PUT without a definition', method: 'PUT', path: '/workflows/wf-1', op: 'save', tables: { workflows: { single: { ...existingWorkflow, definition_schema_version: 7 } } }, body: { name: 'Renamed', definition_schema_version: 99 } },
    { what: 'restore', method: 'POST', path: '/workflows/wf-1/versions/ver-1/restore', op: 'restore', tables: {
      workflows: { single: existingWorkflow }, workflow_versions: { single: { id: 'ver-1', definition, version_number: 1, definition_schema_version: 7 } },
    }, body: { definition_schema_version: 99 } },
    { what: 'duplicate', method: 'POST', path: '/workflows/wf-1/duplicate', op: 'duplicate', tables: {
      workflows: { single: { name: 'Lead Routing', description: null, definition, folder_id: null, is_active: false, definition_schema_version: 7, lane: 'money' } },
    }, body: { definition_schema_version: 99 } },
  ])('$what sends no stamp, leaving the copied one to write_workflow, whatever the caller sends', async ({ method, path, op, tables, body }) => {
    const sb = makeSupabase({ users: { single: testUser }, ...(tables as Record<string, TableConfig>) })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, method, path, { body })
    expect(res.status).toBeLessThan(300)
    expect(stampSent(sb, op)).toEqual(['absent'])
  })
})

/** Every write the route made: each write_workflow call, and any direct write to the workflow tables, as [target, method]. */
const definitionWrites = (sb: ReturnType<typeof makeSupabase>) => [
  ...sb.writes.map((w) => ['write_workflow', w.p_op]),
  ...['workflows', 'workflow_versions'].flatMap((t) => (sb.calls[t] ?? []).filter(([m]) => ['insert', 'update', 'upsert', 'delete'].includes(m)).map(([m]) => [t, m])),
]

const httpTrigger = { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } }

// #2190: a definition the rules cannot read is refused by name on both routes a
// caller's definition enters by, before any check reads it, and create runs the
// same loop check as save.
describe('a malformed definition is refused by a named 400 on create and save, and create refuses a loop (#2190)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it.each([
    ['a null step', { nodes: [null], edges: [], trigger: httpTrigger }, 'step 1'],
    ['steps that are numbers and text', { nodes: [5, 'x'], edges: [], trigger: httpTrigger }, 'step 1'],
    ['a definition that is null', null, 'not an object'],
    ['no list of connections', { nodes: [], trigger: httpTrigger }, 'connections'],
  ])('PUT refuses %s by name and writes nothing', async (_, definition, named) => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: existingWorkflow } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition } })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; reason: string; problems: Array<{ rule: string }> }
    expect(body.reason).toBe('definition_malformed')
    expect(body.error).toContain(named)
    expect(new Set(body.problems.map((p) => p.rule))).toEqual(new Set(['definition_shape']))
    expect(definitionWrites(sb)).toEqual([])
  })

  it('POST refuses a definition holding a null step by name, and inserts nothing', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { insertResult: { id: 'wf-new' } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New', definition: { nodes: [null, 5, 'x'], edges: [], trigger: httpTrigger } } })
    expect(res.status).toBe(400)
    expect((await res.json() as { reason: string }).reason).toBe('definition_malformed')
    expect(definitionWrites(sb)).toEqual([])
  })

  it('POST refuses a looping definition, naming the loop, as save does, and inserts nothing', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { insertResult: { id: 'wf-new' } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const definition = {
      nodes: [{ id: 'a', namespace: 'validate', type: 'code', config: {} }, { id: 'b', namespace: 'enrich', type: 'code', config: {} }],
      edges: [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'a' }],
      trigger: httpTrigger,
    }
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New', definition } })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/loop/i)
    expect(body.error).toContain('validate')
    expect(definitionWrites(sb)).toEqual([])
  })

  it('POST with no definition still creates the default one', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { insertResult: { id: 'wf-new' } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New' } })
    expect(res.status).toBe(201)
  })
})

// #1952: a schedule the tick could not fire is refused at save, never stored to
// be dropped at fire time. Asked on create and save, the two routes a caller's
// definition enters by, whether or not the workflow is switched on. The rules are
// validateSchedule's (packages/workflow-definition); these prove the routes ask it.
describe('an invalid schedule is refused by a named 400 on create and save (#1952)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  const validSchedule = { cron: '0 6 * * MON', timezone: 'America/New_York', overlap: 'skip', catch_up: 'none', jitter_max_seconds: 0 }
  const scheduled = (config: unknown) => ({ nodes: [], edges: [], trigger: { type: 'schedule', config } })

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
    app = await makeApp()
  })

  it.each([
    ['a numeric weekday', { ...validSchedule, cron: '0 6 * * 1' }, 'cron_weekday_not_named'],
    ['a cron that is not five fields', { ...validSchedule, cron: '0 6 * *' }, 'cron_not_five_fields'],
    ['both a cron and an interval', { ...validSchedule, interval_seconds: 300 }, 'schedule_has_cron_and_interval'],
    ['a zone no schedule fires in', { ...validSchedule, timezone: 'Europe/London' }, 'timezone_unsupported'],
    ['no settings at all', {}, 'schedule_needs_cron_or_interval'],
    ['settings that are not an object', 'every monday', 'schedule_needs_cron_or_interval'],
  ])('PUT refuses %s by name and writes nothing', async (_, config, reason) => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, lane: 'ops' } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: scheduled(config) } })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; reason: string; problems: Array<{ reason: string; message: string }> }
    expect(body.reason).toBe('schedule_invalid')
    expect(body.error.startsWith('Nothing was saved. The workflow\'s schedule is not valid: ')).toBe(true)
    expect(body.problems.map((p) => p.reason)).toContain(reason)
    for (const p of body.problems) expect(body.error).toContain(p.message)
    expect(definitionWrites(sb)).toEqual([])
    expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
  })

  it('PUT refuses it on a switched off workflow too: a draft carrying it would page every tick once switched on', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, lane: 'ops', is_active: false } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: scheduled({ ...validSchedule, overlap: 'parallel' }) } })
    expect(res.status).toBe(400)
    expect((await res.json() as { reason: string }).reason).toBe('schedule_invalid')
    expect(definitionWrites(sb)).toEqual([])
  })

  it('PUT saves a valid schedule', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, lane: 'ops' } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: scheduled(validSchedule) } })
    expect(res.status).toBe(200)
    expect(writesOf(sb, 'save')).toHaveLength(1)
  })

  it('a save sending no definition is not judged by the stored one, so a rename still saves', async () => {
    const stored = { ...existingWorkflow, lane: 'ops', definition: scheduled({ ...validSchedule, cron: '0 6 * * 1' }) }
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: stored } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { name: 'Renamed' } })
    expect(res.status).toBe(200)
    expect(writesOf(sb, 'save')).toHaveLength(1)
  })

  it('POST refuses an invalid schedule by name and creates nothing', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { insertResult: { id: 'wf-new' } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New', definition: scheduled({ ...validSchedule, cron: '0 6 31 2 *' }) } })
    expect(res.status).toBe(400)
    const body = await res.json() as { reason: string; problems: Array<{ reason: string }> }
    expect(body.reason).toBe('schedule_invalid')
    expect(body.problems.map((p) => p.reason)).toContain('cron_never_fires')
    expect(definitionWrites(sb)).toEqual([])
  })

  it('POST creates a workflow with a valid schedule', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { insertResult: { id: 'wf-new' } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New', definition: scheduled(validSchedule) } })
    expect(res.status).toBe(201)
    expect(writesOf(sb, 'create')).toHaveLength(1)
  })

  // The stored definitions: none in production held a schedule when this
  // shipped, but a rule on what is stored must not rest on that measurement, so
  // the three routes that carry a stored definition into a new write, or make
  // one live, refuse an invalid schedule too.
  const storedInvalid = scheduled({ ...validSchedule, cron: '0 6 * * 1' })

  it('duplicate refuses a source whose stored schedule is invalid, and copies nothing', async () => {
    const source = { name: 'Weekly', description: null, definition: storedInvalid, folder_id: null, is_active: false, lane: 'ops', version: 3 }
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: source } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(400)
    const body = await res.json() as { reason: string; problems: Array<{ reason: string }> }
    expect(body.reason).toBe('schedule_invalid')
    expect(body.problems.map((p) => p.reason)).toEqual(['cron_weekday_not_named'])
    expect(definitionWrites(sb)).toEqual([])
  })

  it('restore refuses a version whose schedule is invalid, onto a switched off workflow too, and writes nothing', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: { single: { ...existingWorkflow, lane: 'ops', is_active: false } },
      workflow_versions: { single: { id: 'ver-1', definition: storedInvalid, version_number: 1 } },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(res.status).toBe(400)
    expect((await res.json() as { reason: string }).reason).toBe('schedule_invalid')
    expect(definitionWrites(sb)).toEqual([])
  })

  it('switching on refuses a workflow whose stored schedule is invalid, and switches nothing', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, lane: 'ops', is_active: false, definition: storedInvalid } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
    expect(res.status).toBe(400)
    expect((await res.json() as { reason: string }).reason).toBe('schedule_invalid')
    expect(definitionWrites(sb)).toEqual([])
  })

  it('switching off is never refused for it, so an invalid schedule can always be stopped', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, lane: 'ops', is_active: true, definition: storedInvalid } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: false } })
    expect(res.status).toBe(200)
  })

  it('a trigger that is not a schedule is not judged as one', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: existingWorkflow } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: { nodes: [], edges: [], trigger: { type: 'http_webhook', config: {} } } } })
    expect(res.status).toBe(200)
  })
})

// An ops workflow's retry setting (#1693, Dan's decision of 2026-10-28) saves
// through the existing routes, and a bad one is refused by name, as a schedule is.
describe('a bad retry setting is refused by a named 400 on every definition write (#1693)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const withRetry = (retry: unknown) => ({ nodes: [], edges: [], trigger: { type: 'http_webhook', config: {} }, retry })

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
    app = await makeApp()
  })

  it.each([
    ['the default', { mode: 'backoff' }],
    ['a configured base and cap', { mode: 'backoff', base_seconds: 5, cap_seconds: 120 }],
    ['no retry', { mode: 'none' }],
  ])('PUT saves %s on an ops workflow, as sent', async (_, retry) => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, lane: 'ops' } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: withRetry(retry) } })
    expect(res.status).toBe(200)
    const writes = writesOf(sb, 'save')
    expect(writes).toHaveLength(1)
    expect(JSON.stringify(writes[0])).toContain(JSON.stringify(retry))
  })

  it.each([
    ['a mode it does not know', { mode: 'sometimes' }, 'retry_mode_unknown'],
    ['a base of zero', { mode: 'backoff', base_seconds: 0 }, 'retry_base_invalid'],
    ['a cap over an hour', { mode: 'backoff', cap_seconds: 7200 }, 'retry_cap_invalid'],
    ['a base above the cap', { mode: 'backoff', base_seconds: 120, cap_seconds: 60 }, 'retry_base_above_cap'],
    ['a misspelt field', { mode: 'backoff', cap_second: 60 }, 'retry_field_unknown'],
    ['waits on no retry', { mode: 'none', base_seconds: 15 }, 'retry_none_takes_no_waits'],
    ['a setting that is not an object', 'none', 'retry_not_an_object'],
  ])('PUT refuses %s by name on a switched off ops workflow and writes nothing', async (_, retry, reason) => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, lane: 'ops', is_active: false } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: withRetry(retry) } })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; reason: string; problems: Array<{ reason: string; message: string }> }
    expect(body.reason).toBe('retry_invalid')
    expect(body.error.startsWith('Nothing was saved. The workflow\'s retry setting is not valid: ')).toBe(true)
    expect(body.problems.map((p) => p.reason)).toEqual([reason])
    for (const p of body.problems) expect(body.error).toContain(p.message)
    expect(definitionWrites(sb)).toEqual([])
  })

  it('PUT refuses any retry setting on a money workflow, whose engine does not read it', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: existingWorkflow } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: withRetry({ mode: 'none' }) } })
    expect(res.status).toBe(400)
    expect((await res.json() as { problems: Array<{ reason: string }> }).problems.map((p) => p.reason)).toEqual(['retry_on_money_lane'])
    expect(definitionWrites(sb)).toEqual([])
  })

  it('POST refuses one on the new workflow, which is a money workflow, and creates nothing', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { insertResult: { id: 'wf-new' } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New', definition: withRetry({ mode: 'none' }) } })
    expect(res.status).toBe(400)
    expect((await res.json() as { reason: string }).reason).toBe('retry_invalid')
    expect(definitionWrites(sb)).toEqual([])
  })

  // A bad setting can be stored only by hand, since every save refuses it; the
  // routes that carry a stored definition into a new write, or make one live, refuse it too.
  const storedInvalid = withRetry({ mode: 'backoff', base_seconds: 0 })

  it('duplicate refuses a source whose stored setting is bad, and copies nothing', async () => {
    const source = { name: 'Ops', description: null, definition: storedInvalid, folder_id: null, is_active: false, lane: 'ops', version: 3 }
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: source } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(400)
    expect((await res.json() as { reason: string }).reason).toBe('retry_invalid')
    expect(definitionWrites(sb)).toEqual([])
  })

  it('restore refuses a version whose setting is bad, and writes nothing', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: { single: { ...existingWorkflow, lane: 'ops', is_active: false } },
      workflow_versions: { single: { id: 'ver-1', definition: storedInvalid, version_number: 1 } },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(res.status).toBe(400)
    expect((await res.json() as { reason: string }).reason).toBe('retry_invalid')
    expect(definitionWrites(sb)).toEqual([])
  })

  it('switching on refuses a workflow whose stored setting is bad, and switching off never does', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, lane: 'ops', is_active: false, definition: storedInvalid } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const on = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
    expect(on.status).toBe(400)
    expect((await on.json() as { reason: string }).reason).toBe('retry_invalid')
    expect(definitionWrites(sb)).toEqual([])

    const live = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, lane: 'ops', is_active: true, definition: storedInvalid } } })
    vi.mocked(createSupabaseClient).mockReturnValue(live as unknown as ReturnType<typeof createSupabaseClient>)
    expect((await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: false } })).status).toBe(200)
  })
})

// #1947 PR 3: validateDefinition runs report only on every money lane write. It
// logs what it would refuse and refuses nothing new; the five saved shapes the
// production calibration found are each written as they were.
describe('validateDefinition reports on every definition write and refuses nothing new (#1947)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  let warn: ReturnType<typeof vi.spyOn>
  let log: ReturnType<typeof vi.spyOn>

  const reports = () =>
    [...log.mock.calls, ...warn.mock.calls]
      .map((c) => { try { return JSON.parse(String(c[0])) as Record<string, unknown> } catch { return null } })
      .filter((l): l is Record<string, unknown> => l !== null && l.event === 'definition_report')

  const integrationStep = { nodes: [{ id: 'f', type: 'integration', namespace: 'fail_test', config: {} }], edges: [], trigger: httpTrigger }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    app = await makeApp()
  })
  afterEach(() => {
    warn.mockRestore()
    log.mockRestore()
  })

  it('PUT saves a definition a rule would refuse, and logs what it would refuse at the stamp it writes', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: [{ single: { ...existingWorkflow, is_active: false } }, { single: existingWorkflow }],
      workflow_versions: [{ single: { version_number: 1 } }, { insertResult: { id: 'ver-2', version_number: 2, workflow_id: 'wf-1' } }],
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: integrationStep } })
    expect(res.status).toBe(200)
    expect(reports()).toEqual([expect.objectContaining({ writer: 'save', workflow_id: 'wf-1', lane: 'money', live: false, schema_version: 1, stamped: true, would_refuse_reasons: ['node_type_unknown'] })])
  })

  it('PUT of a money workflow with a schedule trigger saves, and logs that no money entry point fires it', async () => {
    const schedule = { type: 'schedule', config: { interval_seconds: 300, timezone: 'UTC', overlap: 'skip', catch_up: 'none', jitter_max_seconds: 0 } }
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: [{ single: { ...existingWorkflow, is_active: false } }, { single: existingWorkflow }],
      workflow_versions: [{ single: { version_number: 1 } }, { insertResult: { id: 'ver-2', version_number: 2, workflow_id: 'wf-1' } }],
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: { nodes: [], edges: [], trigger: schedule } } })
    expect(res.status).toBe(200)
    expect(reports()[0]).toMatchObject({ writer: 'save', would_refuse_reasons: ['trigger_not_on_lane'] })
  })

  it('a save sending no definition reports nothing, since it writes none', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
      workflow_versions: [{ single: { version_number: 1 } }, { insertResult: { id: 'ver-2', version_number: 2, workflow_id: 'wf-1' } }],
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { name: 'Renamed' } })
    expect(res.status).toBe(200)
    expect(reports()).toEqual([])
  })

  it('restore of a version with the old webhook spelling writes it unchanged, and logs the warning at the version\'s own stamp', async () => {
    const legacy = { nodes: [], edges: [], trigger: { type: 'webhook', config: { method: 'POST', auth_method: 'api_key' } } }
    const sb = makeSupabase({
      users: { single: testUser },
      workflow_versions: [{ single: { definition: legacy, version_number: 3, definition_schema_version: null } }, { single: { version_number: 5 } }, { insertResult: { id: 'ver-6' } }],
      workflows: [{ single: { ...existingWorkflow, is_active: true } }, { list: [{ id: 'wf-1' }] }],
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-3/restore')
    expect(res.status).toBe(200)
    const written = writesOf(sb, 'restore').map((w) => (w.p_fields.definition as { trigger: { type: string } }).trigger.type)
    expect(written).toEqual(['webhook'])
    expect(reports()).toEqual([expect.objectContaining({ writer: 'restore', live: true, schema_version: 1, stamped: false, by_rule: { trigger: 1 }, would_refuse: 0 })])
  })

  it('restore of a version holding the retired integration step restores it, and logs that a rule would refuse it', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflow_versions: [{ single: { definition: integrationStep, version_number: 3, definition_schema_version: null } }, { single: { version_number: 5 } }, { insertResult: { id: 'ver-6' } }],
      workflows: [{ single: { ...existingWorkflow, is_active: false } }, { list: [{ id: 'wf-1' }] }],
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-3/restore')
    expect(res.status).toBe(200)
    expect(reports()).toEqual([expect.objectContaining({ writer: 'restore', live: false, would_refuse_reasons: ['node_type_unknown'] })])
  })

  it('create logs the definition it writes as a draft at the current stamp', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { insertResult: { id: 'wf-new' } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New', definition: integrationStep } })
    expect(res.status).toBe(201)
    expect(reports()).toEqual([expect.objectContaining({ writer: 'create', workflow_id: null, live: false, schema_version: 1, would_refuse_reasons: ['node_type_unknown'] })])
  })

  it('duplicate logs the clone as a draft at the source\'s own stamp', async () => {
    const source = { name: 'Lead Routing', description: null, definition: integrationStep, folder_id: null, is_active: true, definition_schema_version: null, lane: 'money' }
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: [{ single: source }, { insertResult: { id: 'wf-copy', name: 'Lead Routing (copy)', organization_id: USER_ORG } }],
      workflow_versions: [{ list: [] }, { insertResult: {} }],
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(201)
    expect(reports()).toEqual([expect.objectContaining({ writer: 'duplicate', workflow_id: 'wf-1', live: false, stamped: false, would_refuse_reasons: ['node_type_unknown'] })])
  })

  it('switching a workflow on logs its stored definition as live, and switching off logs nothing', async () => {
    const stored = { ...existingWorkflow, is_active: false, definition: { nodes: [{ id: 'a', type: 'code', namespace: 'a', config: { script: '' } }, { id: 'b', type: 'response', namespace: 'b', config: {} }], edges: [{ source: 'a', target: 'b' }], trigger: httpTrigger }, definition_schema_version: null }
    const on = makeSupabase({ users: { single: testUser }, workflows: [{ single: stored }, { single: { id: 'wf-1', is_active: true } }] })
    vi.mocked(createSupabaseClient).mockReturnValue(on as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
    expect(res.status).toBe(200)
    expect(reports()).toEqual([expect.objectContaining({ writer: 'switch_on', live: true, stamped: false, would_refuse_reasons: ['node_unconfigured'] })])

    log.mockClear()
    warn.mockClear()
    const off = makeSupabase({ users: { single: testUser }, workflows: [{ single: { ...stored, is_active: true } }, { single: { id: 'wf-1', is_active: false } }] })
    vi.mocked(createSupabaseClient).mockReturnValue(off as unknown as ReturnType<typeof createSupabaseClient>)
    expect((await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: false } })).status).toBe(200)
    expect(reports()).toEqual([])
  })

  it('a save stores what the report found beside its snapshot, so the flip can be decided from the table', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, is_active: false } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: integrationStep } })
    expect(res.status).toBe(200)
    expect(writesOf(sb, 'save')[0].p_fields.definition_report).toMatchObject({ verdict: 'judged', would_refuse_reasons: ['node_type_unknown'] })
  })

  it('a restore stores its report beside the new snapshot too', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflow_versions: { single: { definition: integrationStep, version_number: 3, definition_schema_version: null } },
      workflows: { single: { ...existingWorkflow, is_active: false } },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    expect((await request(app, 'POST', '/workflows/wf-1/versions/ver-3/restore')).status).toBe(200)
    expect(writesOf(sb, 'restore')[0].p_fields.definition_report).toMatchObject({ verdict: 'judged', stamped: false })
  })
})

// #1947: every write of a workflow goes through write_workflow, which compares
// the version a write was made from with the stored one. A save made on top of
// someone else's newer save is refused by name and writes nothing, carrying the
// current row so the page can say whose change it would have undone.
describe('a save made from a version no longer stored is refused, never written over (#1947)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const definition = { nodes: [{ id: 'a', type: 'code', namespace: 'a', config: { script: 'return 1' } }], edges: [], trigger: httpTrigger }
  const staleAnswer = (current: Record<string, unknown>) => () => ({
    data: null,
    error: { code: 'BP409', message: 'stale_version', details: JSON.stringify({ current, last_save_id: '1c0ffee0-0000-4000-8000-000000000001', changed_by_name: 'Bob', changed_at: '2026-10-23T14:05:00Z' }) },
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
    app = await makeApp()
  })

  // The canvas names the version it was loaded from and its press on every save
  // (#2599). A canvas opened before that sends neither, and its save would be
  // made from whatever version the request read, writing over a newer save, so
  // it is refused before anything is read, its edits left on the canvas (L598).
  it.each([
    ['no version', { save_id: saveKeys.save_id }],
    ['no press', { expected_version: 4 }],
    ['neither', {}],
  ])('answers a definition save naming %s with 428 reload_required, reading and writing nothing', async (_, keys) => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, version: 9 } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...keys, definition } })
    expect(res.status).toBe(428)
    expect(await res.json()).toEqual({ code: 'reload_required', error: RELOAD_REQUIRED_WORKFLOW_MESSAGE })
    expect(sb.calls.workflows ?? []).toEqual([])
    expect(sb.writes).toEqual([])
  })

  // A rename from the list sends no definition, so it overwrites nothing anyone
  // edited on a canvas: it is made from the version the request read.
  it('a save sending no definition and no version is made from the version the request read', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, version: 9 } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { name: 'Renamed' } })
    expect(res.status).toBe(200)
    expect(sb.writes).toEqual([expect.objectContaining({ p_op: 'save', p_expected_version: 9, p_save_id: null })])
  })

  it.each([
    ['a version that is not a whole number', { expected_version: 'four', save_id: saveKeys.save_id }, 'expected_version_invalid'],
    ['a negative version', { expected_version: -1, save_id: saveKeys.save_id }, 'expected_version_invalid'],
    ['a press that is not a UUID', { expected_version: 4, save_id: 'press' }, 'save_id_invalid'],
  ])('refuses %s with a named 400', async (_, keys, error) => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: existingWorkflow } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...keys, definition } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe(error)
    expect(sb.writes).toEqual([])
  })

  it('sends the version the canvas was edited from and its press, never the one it read', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, version: 9 } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition } })
    expect(res.status).toBe(200)
    expect(sb.writes).toEqual([expect.objectContaining({ p_op: 'save', p_expected_version: 4, p_save_id: saveKeys.save_id })])
  })

  it('answers a save that lost the race with 409, the current row, the press that won and who made it, and writes nothing else', async () => {
    const current = { ...existingWorkflow, version: 5, name: 'Their name' }
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: existingWorkflow } }, { write: staleAnswer(current) })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition } })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      code: 'stale_version',
      error: expect.stringMatching(/^Not saved\./),
      current,
      last_save_id: '1c0ffee0-0000-4000-8000-000000000001',
      changed_by_name: 'Bob',
      changed_at: '2026-10-23T14:05:00Z',
    })
    expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    expect(vi.mocked(pushWorkflowToGitHub)).not.toHaveBeenCalled()
  })

  it('an unchanged save answers the stored version, so the canvas keeps the one it must send next', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, definition, version: 7 } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition } })
    expect(await res.json()).toMatchObject({ no_changes: true, version: 7 })
    expect(sb.writes).toEqual([])
  })

  it('a switch on that lost the race to a save is refused by name and switches nothing', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, is_active: false } } }, { write: staleAnswer({ ...existingWorkflow, version: 5 }) })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'stale_version', error: expect.stringMatching(/^Not switched on\./) })
    expect(sb.writes).toEqual([expect.objectContaining({ p_op: 'patch', p_expected_version: 4, p_fields: { is_active: true } })])
    expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
  })

  it('a switch off and a move to a folder name no version', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { ...existingWorkflow, is_active: true } } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: false, folder_id: 'f-1' } })
    expect(sb.writes).toEqual([expect.objectContaining({ p_op: 'patch', p_expected_version: null, p_fields: { is_active: false, folder_id: 'f-1' } })])
  })

  it('a folder of another organization is answered folder not found, as before', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: existingWorkflow } }, { write: () => ({ data: null, error: { code: 'P0002', message: 'folder_not_found' } }) })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { folder_id: 'f-other' } })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'folder not found' })
  })

  it('a delete is a soft delete through write_workflow, naming no version', async () => {
    const sb = makeSupabase({ users: { single: testUser } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'DELETE', '/workflows/wf-1')
    expect(res.status).toBe(200)
    expect(sb.writes).toEqual([expect.objectContaining({ p_op: 'delete', p_id: 'wf-1', p_expected_version: null, p_fields: {} })])
    expect(vi.mocked(refreshWorkflowCaches)).toHaveBeenCalledWith('wf-1', testEnv.WORKFLOW_CACHE, routeClient())
  })
})

// #2879: create and duplicate write a version as a save does, so each is backed
// up as a save is. Until then a new or duplicated workflow was missing from the
// backup until its first save, since neither write answered the version it made.
describe('a created or duplicated workflow is pushed to the GitHub backup (#2879)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
    vi.mocked(recordBackupSuccess).mockResolvedValue(undefined)
    vi.mocked(recordBackupFailure).mockResolvedValue(false)
    app = await makeApp()
  })

  const definition = { nodes: [], edges: [], trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } } }
  const created = { ...existingWorkflow, id: 'wf-new', name: 'New Flow', definition, version: 0, is_active: false }
  const createClient = () => makeSupabase(
    { users: { single: testUser }, workflow_versions: { list: [{ id: 'ver-new-1' }] } },
    { write: () => ({ data: { workflow: created, version_id: 'ver-new-1', version_number: 1 }, error: null }) },
  )
  const source = { name: 'Lead Routing', description: null, definition, folder_id: null, is_active: true, lane: 'money', version: 3 }
  const clone = { ...existingWorkflow, id: 'wf-copy', name: 'Lead Routing (copy)', definition, is_active: false }
  const duplicateClient = () => makeSupabase(
    { users: { single: testUser }, workflows: { single: source }, workflow_versions: { list: [{ id: 'ver-copy-3' }] } },
    { write: () => ({ data: { workflow: clone, version_id: 'ver-copy-3', version_number: 3, versions_copied: 3 }, error: null }) },
  )

  it('pushes a created workflow\'s definition and stamps the commit on its first version row', async () => {
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue('commit-create-1')
    const sb = createClient()
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New Flow', definition } })
    expect(res.status).toBe(201)
    await mockCtx.settle()
    expect(vi.mocked(pushWorkflowToGitHub)).toHaveBeenCalledWith('gh-tok', 'Try-Pennie/backups', 'wf-new', 'New Flow', definition, 1, expect.stringMatching(/create/))
    expect((sb.calls.workflow_versions ?? []).filter(([m]) => m === 'update')).toEqual([['update', [{ commit_sha: 'commit-create-1' }]]])
    expect(vi.mocked(recordBackupSuccess)).toHaveBeenCalled()
  })

  it('pushes a duplicate as the copy, and stamps the copy\'s version row', async () => {
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue('commit-copy-1')
    const sb = duplicateClient()
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(201)
    await mockCtx.settle()
    expect(vi.mocked(pushWorkflowToGitHub)).toHaveBeenCalledWith('gh-tok', 'Try-Pennie/backups', 'wf-copy', 'Lead Routing (copy)', definition, 3, expect.stringMatching(/duplicate workflow wf-1/))
    expect((sb.calls.workflow_versions ?? []).filter(([m]) => m === 'update')).toEqual([['update', [{ commit_sha: 'commit-copy-1' }]]])
  })

  it.each([
    ['create', () => createClient(), '/workflows', { name: 'New Flow', definition }, 'wf-new', 'New Flow'],
    ['duplicate', () => duplicateClient(), '/workflows/wf-1/duplicate', undefined, 'wf-copy', 'Lead Routing (copy)'],
  ] as const)('answers a %s whose backup push fails as written, and alerts the failure as a save does', async (_op, client, path, body, workflowId, workflowName) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(pushWorkflowToGitHub).mockRejectedValue(new Error('GitHub push failed (401): Bad credentials'))
    vi.mocked(createSupabaseClient).mockReturnValue(client() as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', path, body ? { body } : {})
    expect(res.status).toBe(201)
    await mockCtx.settle()
    expect(vi.mocked(recordBackupFailure)).toHaveBeenCalledWith(expect.objectContaining({ workflowId, workflowName }))
    expect(vi.mocked(recordBackupSuccess)).not.toHaveBeenCalled()
  })
})

// An ops workflow reads each variable's CURRENT value when a run starts (#2982,
// Dan's decision of 2026-10-28), secrets included (2026-10-29, "Any secret, no
// exceptions"), so a secret no longer blocks anything. Saving live, switching
// on or restoring onto a live ops workflow that reads a variable that does not
// exist for it is still refused up front, naming it (#3003). The run's own
// refusal stays as the backstop.
describe('an ops workflow\'s environment variables at switch on, a live save and a restore (#3003)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
    vi.mocked(recordBackupSuccess).mockResolvedValue(undefined)
    vi.mocked(recordBackupFailure).mockResolvedValue(false)
    app = await makeApp()
  })

  const reads = (...keys: string[]) => ({
    nodes: [{ id: 'shape', namespace: 'shape', type: 'transform', config: { mappings: keys.map((k) => ({ source: `env.${k}`, target: k.toLowerCase() })) } }],
    edges: [{ id: 'e0', source: 'trigger', target: 'shape' }],
  })
  const opsOff = { ...existingWorkflow, lane: 'ops', is_active: false, definition: reads('API_BASE'), definition_schema_version: 1 }
  let rowSeq = 0
  const plain = (key: string, over: Record<string, unknown> = {}) => ({
    id: `00000000-0000-4000-9000-${String(++rowSeq).padStart(12, '0')}`, organization_id: USER_ORG, key, value: 'https://api.example.test', is_secret: false, scope: 'global', workflow_id: null, ...over,
  })
  const client = (workflow: Record<string, unknown>, variables: TableConfig) => makeSupabase({
    users: { single: testUser },
    workflows: [{ single: workflow }],
    environment_variables: variables,
  })

  it('switching an ops workflow on writes a new version first, then switches it on from it', async () => {
    const sb = client(opsOff, { list: [plain('API_BASE')] })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
    expect(res.status).toBe(200)
    expect(sb.writes.map((w) => w.p_op)).toEqual(['save', 'patch'])
    const [save, patch] = sb.writes
    // No definition is sent, so the version snapshots the stored one.
    expect(save).toMatchObject({ p_id: 'wf-1', p_expected_version: 4, p_fields: { message: 'Switched on' } })
    expect(Object.keys(save.p_fields)).toEqual(['message'])
    expect(patch).toMatchObject({ p_fields: { is_active: true }, p_expected_version: 5 })
  })

  it('a switch on whose new version cannot be written switches nothing on', async () => {
    const sb = makeSupabase(
      { users: { single: testUser }, workflows: [{ single: opsOff }], environment_variables: { list: [plain('API_BASE')] } },
      { write: (args) => (args.p_op === 'save' ? { data: null, error: { code: 'XX000', message: 'the database is not answering' } } : defaultWrite(args)) },
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(writesOf(sb, 'patch')).toEqual([])
  })

  it('switching a money workflow on, an ops workflow off, or one already on writes no version', async () => {
    for (const [workflow, isActive] of [
      [{ ...existingWorkflow, is_active: false }, true],
      [{ ...opsOff, is_active: true }, false],
      [{ ...opsOff, is_active: true }, true],
    ] as const) {
      const sb = client(workflow, { list: [plain('API_BASE')] })
      vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: isActive } })
      expect(res.status).toBe(200)
      expect(sb.writes.map((w) => w.p_op)).toEqual(['patch'])
    }
  })

  it('switches on, saves live and restores onto a live ops workflow that reads a secret variable, as any other (#3003)', async () => {
    const secretRow = plain('API_BASE', { is_secret: true, value: 'ciphertext-not-real' })
    const off = client(opsOff, { list: [secretRow] })
    vi.mocked(createSupabaseClient).mockReturnValue(off as unknown as ReturnType<typeof createSupabaseClient>)
    const switched = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
    expect(switched.status).toBe(200)
    expect(off.writes.map((w) => w.p_op)).toEqual(['save', 'patch'])

    const live = client({ ...opsOff, is_active: true, definition: reads() }, { list: [secretRow] })
    vi.mocked(createSupabaseClient).mockReturnValue(live as unknown as ReturnType<typeof createSupabaseClient>)
    const saved = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: reads('API_BASE') } })
    expect(saved.status).toBe(200)
    expect(live.writes.map((w) => w.p_op)).toEqual(['save'])

    const restoring = makeSupabase({
      users: { single: testUser },
      workflows: [{ single: { ...opsOff, is_active: true } }],
      workflow_versions: [{ single: { id: 'ver-1', definition: reads('API_BASE'), version_number: 1 } }],
      environment_variables: { list: [secretRow] },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(restoring as unknown as ReturnType<typeof createSupabaseClient>)
    const restored = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(restored.status).toBe(200)
  })

  it('refuses to switch on an ops workflow reading a variable that does not exist for it, naming it', async () => {
    // Another workflow's own value is not this workflow's.
    const sb = client({ ...opsOff, definition: reads('API_BASE', 'LIST_ID') }, { list: [plain('API_BASE'), plain('LIST_ID', { scope: 'workflow', workflow_id: 'wf-other' })] })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({
      error: 'variable_unavailable',
      variables: { missing: ['LIST_ID'] },
      message: 'Nothing was saved. It reads env.LIST_ID, which is not a variable of this workflow. Add it on the environment variables page first.',
    })
    expect(sb.writes).toEqual([])
  })

  it('reads the variables by the env loader\'s rules: the workflow\'s own over the organization\'s, in this organization only', async () => {
    const sb = client({ ...opsOff, definition: reads('API_BASE') }, { list: [plain('API_BASE', { is_secret: true, value: 'x' }), plain('API_BASE', { scope: 'workflow', workflow_id: 'wf-1' })] })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
    expect(res.status).toBe(200)
    const calls = sb.calls.environment_variables ?? []
    expect(calls).toContainEqual(['eq', ['organization_id', USER_ORG]])
    expect(calls).toContainEqual(['in', ['key', ['API_BASE']]])
  })

  it('refuses the live save of an ops workflow reading a variable that does not exist, and lets a switched off draft save', async () => {
    const live = client({ ...opsOff, is_active: true, definition: reads() }, { list: [] })
    vi.mocked(createSupabaseClient).mockReturnValue(live as unknown as ReturnType<typeof createSupabaseClient>)
    const refused = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: reads('TOKEN') } })
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({ error: 'variable_unavailable', variables: { missing: ['TOKEN'] } })
    expect(live.writes).toEqual([])

    const draft = client({ ...opsOff, definition: reads() }, { list: [] })
    vi.mocked(createSupabaseClient).mockReturnValue(draft as unknown as ReturnType<typeof createSupabaseClient>)
    const saved = await request(app, 'PUT', '/workflows/wf-1', { body: { ...saveKeys, definition: reads('TOKEN') } })
    expect(saved.status).toBe(200)
  })

  it('refuses to restore onto a switched on ops workflow a version reading a missing variable', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: [{ single: { ...opsOff, is_active: true } }],
      workflow_versions: [{ single: { id: 'ver-1', definition: reads('GONE'), version_number: 1 } }],
      environment_variables: { list: [] },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'variable_unavailable', variables: { missing: ['GONE'] } })
    expect(sb.writes).toEqual([])
  })

  it('refuses with 503, writing nothing, when the variables cannot be read, never reading them as absent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sb = client(opsOff, { listError: { message: 'the database is not answering', code: 'PGRST000' } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'variables_unavailable' })
    expect(sb.writes).toEqual([])
  })

  it('never reads the variables of a money workflow, nor of an ops one that reads none', async () => {
    for (const workflow of [{ ...existingWorkflow, is_active: false, definition: reads('API_BASE') }, { ...opsOff, definition: reads() }]) {
      const sb = client(workflow, { listError: { message: 'must not be read' } })
      vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
      expect(res.status).toBe(200)
      expect(sb.calls.environment_variables).toBeUndefined()
    }
  })
})
