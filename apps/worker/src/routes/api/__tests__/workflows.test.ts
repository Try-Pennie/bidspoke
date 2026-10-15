/**
 * Workflow CRUD routes — PRD Section 1.3
 * Covers: PUT version snapshot + KV invalidation, PATCH is_active toggle,
 * DELETE, version restore, test runner endpoint.
 * Auth rejection is covered in workflows-auth.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

/**
 * The shared mock now covers what this file kept a local copy for: a handler for
 * non-auth rpcs, with jwtAuth's lookup served internally (#347).
 */
const makeSupabase = (
  tables: Record<string, TableConfig | TableConfig[]> = {},
  opts: { rpc?: (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }> } = {},
) => makeSupabaseMock(tables, opts)

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
// A stored row always carries its lane (NOT NULL, default money, #1707), and the
// test and test-node routes refuse a row without one (#1725).
const existingWorkflow = { id: 'wf-1', name: 'Lead Routing', organization_id: USER_ORG, definition: { nodes: [] }, lane: 'money' }
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
  const { default: api } = await import('../index')
  return api
}

/**
 * The client the route built for itself: refreshWorkflowCaches must read the
 * row back through the same client the route wrote it with (#1845).
 */
const routeClient = () => vi.mocked(createSupabaseClient).mock.results[0]?.value

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

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

  it('creates a version snapshot and returns the new version_id', async () => {
    const newVersion = { id: 'ver-1', version_number: 2, workflow_id: 'wf-1' }
    const updatedWorkflow = { ...existingWorkflow, name: 'Renamed' }

    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        // workflows: first call fetches existing, second call is the update
        workflows: [
          { single: existingWorkflow },
          { single: updatedWorkflow },
        ],
        // workflow_versions: first call gets last version number, second call inserts
        workflow_versions: [
          { single: { version_number: 1 } },
          { insertResult: newVersion },
        ],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )

    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { name: 'Renamed' } })
    expect(res.status).toBe(200)
    const body = await res.json() as { version_id: string }
    expect(body.version_id).toBe('ver-1')
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
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { definition } })
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
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { definition } })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('invalid_state_sf_post: rename_fields must map each field name to a new field name')
  })

  it('aborts the save when the version-number lookup hits a real DB error (#303)', async () => {
    // A dropped error here defaulted nextVersion to 1, risking a clobber of the
    // existing version chain. A real (non-PGRST116) error must abort.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },
        workflow_versions: { singleError: { code: '57P01', message: 'db connection lost' } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { name: 'Renamed' } })
    expect(res.status).toBe(500)
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

  it('saves as version 1 when there are no prior versions (PGRST116 is not an error)', async () => {
    const newVersion = { id: 'ver-1', version_number: 1, workflow_id: 'wf-1' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
        // no `single` config → mock returns PGRST116 (no rows), then the insert
        workflow_versions: [{}, { insertResult: newVersion }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { name: 'First' } })
    expect(res.status).toBe(200)
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
    await request(app, 'PUT', '/workflows/wf-1', { body: { definition: { nodes: [{ id: 'a', type: 'code', config: {} }] } } })
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
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { definition: { nodes: [{ id: 'a', type: 'code', config: {} }] } } })
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
    await request(app, 'PUT', '/workflows/wf-1', { body: { definition: { nodes: [{ id: 'a', type: 'code', config: {} }] } } })
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
        workflow_versions: [
          { single: { version_number: 1 } },
          { insertResult: newVersion },
          { list: [] },                      // the commit_sha UPDATE touches nothing
        ],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'PUT', '/workflows/wf-1', { body: { definition: { nodes: [{ id: 'a', type: 'code', config: {} }] } } })
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
        workflow_versions: [
          { single: { version_number: 1 } },
          { insertResult: newVersion },
          { list: [{ id: 'ver-bk1' }] },
        ],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'PUT', '/workflows/wf-1', { body: { definition: { nodes: [{ id: 'a', type: 'code', config: {} }] } } })
    await drainWaitUntil()

    const logged = errSpy.mock.calls.map((call) => String(call[0]))
    expect(logged.some((line) => line.includes('zero_row_write'))).toBe(false)
    expect(vi.mocked(recordBackupSuccess)).toHaveBeenCalled()
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
    await request(app, 'PUT', '/workflows/wf-1', { body: { definition: { nodes: [{ id: 'a', type: 'code', config: {} }] } } })
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
      body: JSON.stringify({ definition: { nodes: [] } }),
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
    await request(app, 'PUT', '/workflows/wf-1', { body: { definition: { nodes: [{ id: 'a', type: 'code', config: {} }] } } })
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
      body: { name: 'Lead Routing', definition: { nodes: [] } },
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
      body: { name: 'Lead Routing', definition: { nodes: [] } },
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
      body: { name: 'Lead Routing', definition: { nodes: [] } },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { no_changes?: boolean; stored_copy_warning?: string }
    expect(body.no_changes).toBe(true)
    expect(body.stored_copy_warning).toMatch(/repaired automatically/i)
  })

  it('treats a key-reordered but structurally identical definition as no_changes (jsonb round-trip)', async () => {
    const stored = {
      ...existingWorkflow,
      definition: { nodes: [], trigger: { type: 'http_webhook', config: {} } },
    }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: stored },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    // Same content, keys in a different order (as jsonb would return them).
    const res = await request(app, 'PUT', '/workflows/wf-1', {
      body: { name: 'Lead Routing', definition: { trigger: { config: {}, type: 'http_webhook' }, nodes: [] } },
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
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/workflows/wf-1', {
      body: { name: 'Lead Routing', definition: { nodes: [{ id: 'a', type: 'code', config: {} }] } },
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

  it('clones the workflow, copies version history, and audit-logs the source', async () => {
    const source = { name: 'Lead Routing', description: null, definition: { nodes: [] }, folder_id: null, is_active: true }
    const clone = { id: 'wf-copy', name: 'Lead Routing (copy)', organization_id: USER_ORG }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        // 1st workflows call = source select; 2nd = clone insert
        workflows: [{ single: source }, { insertResult: clone }],
        // 1st workflow_versions call = source history select; 2nd = bulk insert
        workflow_versions: [
          { list: [{ version_number: 1, definition: { nodes: [] }, message: 'init' }, { version_number: 2, definition: { nodes: [] }, message: 'edit' }] },
          { insertResult: {} },
        ],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; name: string }
    expect(body.id).toBe('wf-copy')
    expect(body.name).toBe('Lead Routing (copy)')
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.anything(), USER_ORG, 'workflow', 'wf-copy', 'created', 'user-1', { duplicated_from: 'wf-1' }
    )
  })

  it('copies every version when the history runs past one 1,000 row page', async () => {
    const source = { name: 'Long', description: null, definition: { nodes: [] }, folder_id: null, is_active: false }
    const clone = { id: 'wf-long', name: 'Long (copy)', organization_id: USER_ORG }
    const version = (n: number) => ({ version_number: n, definition: { nodes: [] }, message: null })
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: [{ single: source }, { insertResult: clone }],
      workflow_versions: [
        { list: Array.from({ length: 1000 }, (_, i) => version(i + 1)) },
        { list: [version(1001), version(1002)] },
        { insertResult: {} },
      ],
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(201)
    const inserts = (sb.calls.workflow_versions ?? []).filter(([m]) => m === 'insert')
    expect(inserts).toHaveLength(1)
    const rows = inserts[0][1][0] as Array<{ version_number: number }>
    expect(rows.map((r) => r.version_number)).toEqual(Array.from({ length: 1002 }, (_, i) => i + 1))
    expect(((await res.json()) as { history_copied?: boolean }).history_copied).toBe(true)
  })

  it('does not invent a v1 when the source history could not be read', async () => {
    const source = { name: 'Real', description: null, definition: { nodes: [] }, folder_id: null, is_active: false }
    const clone = { id: 'wf-copy4', name: 'Real (copy)', organization_id: USER_ORG }
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: [{ single: source }, { insertResult: clone }],
      workflow_versions: [{ listError: { message: 'statement timeout' } }, { insertResult: {} }],
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(201)
    expect((sb.calls.workflow_versions ?? []).filter(([m]) => m === 'insert')).toEqual([])
    expect(((await res.json()) as { history_copied?: boolean }).history_copied).toBe(false)
  })

  it('reports the history as not copied when writing the copied versions fails', async () => {
    const source = { name: 'Real', description: null, definition: { nodes: [] }, folder_id: null, is_active: false }
    const clone = { id: 'wf-copy5', name: 'Real (copy)', organization_id: USER_ORG }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: source }, { insertResult: clone }],
        workflow_versions: [{ list: [{ version_number: 1, definition: { nodes: [] } }] }, { insertError: { message: 'insert failed' } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(201)
    expect(((await res.json()) as { history_copied?: boolean }).history_copied).toBe(false)
  })

  it('seeds a baseline v1 when the source has no saved versions', async () => {
    const source = { name: 'Fresh', description: null, definition: { nodes: [] }, folder_id: null, is_active: false }
    const clone = { id: 'wf-copy2', name: 'Fresh (copy)', organization_id: USER_ORG }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: source }, { insertResult: clone }],
        workflow_versions: [{ list: [] }, { insertResult: {} }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string }
    expect(body.id).toBe('wf-copy2')
  })

  it('succeeds when the source has code nodes (deploy path runs, no CF creds = no-op)', async () => {
    const source = {
      name: 'Coded',
      description: null,
      definition: { nodes: [{ id: 'n1', type: 'code', namespace: 'enrich', config: { script: 'return {}' } }] },
      folder_id: null,
      is_active: true,
    }
    const clone = { id: 'wf-copy3', name: 'Coded (copy)', organization_id: USER_ORG }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: source }, { insertResult: clone }],
        workflow_versions: [{ list: [{ version_number: 1, definition: source.definition }] }, { insertResult: {} }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
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
      makeSupabase({ users: { single: testUser }, workflows: { list: [] } }) as unknown as ReturnType<typeof createSupabaseClient>
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
    app = await makeApp()
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

  it('returns 200 with the new version number', async () => {
    const oldVersion = { id: 'ver-1', definition: { nodes: [] }, version_number: 1 }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_versions: [
          { single: oldVersion },              // fetch target version
          { single: { version_number: 3 } },   // get current max version number
          { insertResult: { id: 'ver-4', version_number: 4 } },
        ],
        workflows: [
          { single: existingWorkflow },        // ownership lookup
          { list: [{ id: 'wf-1' }] },          // the definition UPDATE touches one row
        ],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; version_number: number }
    expect(body.ok).toBe(true)
    expect(typeof body.version_number).toBe('number')
  })

  // The version snapshot is inserted before the definition UPDATE. That update
  // discarded its result entirely, so a restore could write history, fail to
  // move the live definition, and still answer 200 (#588).
  it('returns 404 when the definition update matches no row, so history and definition cannot silently diverge', async () => {
    const oldVersion = { id: 'ver-1', definition: { nodes: [] }, version_number: 1 }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_versions: [
          { single: oldVersion },
          { single: { version_number: 3 } },
          { insertResult: { id: 'ver-4', version_number: 4 } },
        ],
        workflows: [
          { single: existingWorkflow },        // ownership lookup passes
          { list: [] },                        // ...then the workflow vanishes
        ],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(res.status).toBe(404)
    expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('aborts the restore when the version-number lookup hits a real DB error (#303)', async () => {
    const oldVersion = { id: 'ver-1', definition: { nodes: [] }, version_number: 1 }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },
        workflow_versions: [
          { single: oldVersion },                                  // fetch target version
          { singleError: { code: '57P01', message: 'db down' } },  // lastVersion lookup errors
        ],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(res.status).toBe(500)
    // No clobbering write happened.
    expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
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
    const engineWorkflow = { id: 'wf-engine', name: 'Engine Bidding', definition: { nodes: [{ id: 'bs', namespace: 'sell_off', type: 'buyer_select', config: { population: 'engine', mode: 'live' } }] } }
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

describe('PUT /workflows/:id: zero-row update 404 vs real DB error (#595)', () => {
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

  it('returns 404 (not 500), skips audit + cache when the workflow-row update matches zero rows', async () => {
    // Ownership read passes and the version snapshot is inserted, then the
    // workflows UPDATE touches nothing (raced away or another org). That zero-row
    // write must read as not-found, and must not audit or bust the cache.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: null }],
        workflow_versions: [{ single: { version_number: 1 } }, { insertResult: { id: 'ver-1', version_number: 2 } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { name: 'Renamed' } })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Workflow not found' })
    expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 500 (not a false 404) when the workflow-row update hits a real DB error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { updateError: { code: '42P01', message: 'relation missing' } }],
        workflow_versions: [{ single: { version_number: 1 } }, { insertResult: { id: 'ver-1', version_number: 2 } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { name: 'Renamed' } })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal error' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 200 with the updated workflow on the happy path', async () => {
    const updated = { ...existingWorkflow, name: 'Renamed' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: updated }],
        workflow_versions: [{ single: { version_number: 1 } }, { insertResult: { id: 'ver-1', version_number: 2 } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { name: 'Renamed' } })
    expect(res.status).toBe(200)
    const body = await res.json() as { version_id: string; name: string }
    expect(body.version_id).toBe('ver-1')
    expect(body.name).toBe('Renamed')
  })
})

describe('PATCH /workflows/:id: zero-row update 404 vs real DB error (#595)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 (not 500), skips audit + cache when the update matches zero rows', async () => {
    // Ownership read passes, then the field UPDATE touches nothing. That zero-row
    // write must read as not-found, and must not audit or bust the cache.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: null }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: false } })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Workflow not found' })
    expect(vi.mocked(refreshWorkflowCaches)).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 500 (not a false 404) when the update hits a real DB error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { updateError: { code: '42P01', message: 'relation missing' } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: false } })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal error' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 200 with the updated fields on the happy path', async () => {
    const updated = { id: 'wf-1', name: 'Lead Routing', is_active: false, updated_at: '2026-01-01' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: updated }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: false } })
    expect(res.status).toBe(200)
    const body = await res.json() as { is_active: boolean }
    expect(body.is_active).toBe(false)
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
  const paddedDefinition = { nodes: [{ id: 'c1', type: 'code', config: { script: padded } }], edges: [] }
  let app: Awaited<ReturnType<typeof makeApp>>

  const scriptsWritten = (sb: ReturnType<typeof makeSupabase>, table: string, method: string) =>
    (sb.calls[table] ?? [])
      .filter(([m]) => m === method)
      .map(([, args]) => ((args[0] as { definition?: { nodes?: Array<{ config?: { script?: string } }> } }).definition?.nodes ?? []).map((n) => n.config?.script))

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
    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { definition: paddedDefinition } })
    expect(res.status).toBe(200)
    expect(scriptsWritten(sb, 'workflow_versions', 'insert')).toEqual([[clean]])
    expect(scriptsWritten(sb, 'workflows', 'update')).toEqual([[clean]])
  })

  it('POST strips the script of a newly created workflow', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: { insertResult: { id: 'wf-new', name: 'New', definition: paddedDefinition } },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New', definition: paddedDefinition } })
    expect(res.status).toBe(201)
    expect(scriptsWritten(sb, 'workflows', 'insert')).toEqual([[clean]])
  })

  it('restore strips the script of the version being restored', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflow_versions: [
        { single: { id: 'ver-1', definition: paddedDefinition, version_number: 1 } },
        { single: { version_number: 3 } },
        { insertResult: { id: 'ver-4', version_number: 4 } },
      ],
      workflows: [{ single: existingWorkflow }, { list: [{ id: 'wf-1' }] }],
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(res.status).toBe(200)
    expect(scriptsWritten(sb, 'workflow_versions', 'insert')).toEqual([[clean]])
    expect(scriptsWritten(sb, 'workflows', 'update')).toEqual([[clean]])
  })

  it('duplicate strips the script of the clone', async () => {
    const source = { name: 'Lead Routing', description: null, definition: paddedDefinition, folder_id: null, is_active: true }
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: [{ single: source }, { insertResult: { id: 'wf-copy', name: 'Lead Routing (copy)', organization_id: USER_ORG } }],
      workflow_versions: [{ list: [] }, { insertResult: {} }],
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(201)
    expect(scriptsWritten(sb, 'workflows', 'insert')).toEqual([[clean]])
  })
})

// New and duplicated workflows start switched off (#1706). A workflow written by
// the Pipedream converter or an API caller must not take traffic before a person
// has looked at it and switched it on through PATCH, which keeps its safeguards.
describe('new and duplicated workflows start inactive (#1706)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  const activeFlagsInserted = (sb: ReturnType<typeof makeSupabase>) =>
    (sb.calls.workflows ?? [])
      .filter(([m]) => m === 'insert')
      .map(([, args]) => (args[0] as { is_active?: unknown }).is_active)

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('POST creates the workflow with is_active false', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: { insertResult: { id: 'wf-new', name: 'New', is_active: false } },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New' } })
    expect(res.status).toBe(201)
    expect(activeFlagsInserted(sb)).toEqual([false])
  })

  it('POST ignores an is_active true sent in the body', async () => {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: { insertResult: { id: 'wf-new', name: 'New', is_active: false } },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows', { body: { name: 'New', is_active: true } })
    expect(res.status).toBe(201)
    expect(activeFlagsInserted(sb)).toEqual([false])
  })

  it('duplicating an ACTIVE workflow creates an inactive copy', async () => {
    const source = { name: 'Live Flow', description: null, definition: { nodes: [] }, folder_id: null, is_active: true }
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: [{ single: source }, { insertResult: { id: 'wf-copy', name: 'Live Flow (copy)', organization_id: USER_ORG, is_active: false } }],
      workflow_versions: [{ list: [] }, { insertResult: {} }],
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(201)
    expect(activeFlagsInserted(sb)).toEqual([false])
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
