import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writeWorkflow, type WriteWorkflowCall } from '../write-workflow'
import type { createSupabaseClient } from '../supabase'
import { recordingContext } from '../../test-setup/wait-until'

vi.mock('../github')
vi.mock('../github-backup-alert')
import { pushWorkflowToGitHub } from '../github'
import { recordBackupFailure, recordBackupSuccess } from '../github-backup-alert'

// writeWorkflow (#1947): the Worker's one way to write a workflow, through the
// write_workflow database function. These pin the call it makes and how each
// answer of the function reaches a route.

type Client = ReturnType<typeof createSupabaseClient>
const client = (answer: { data: unknown; error: unknown }) => {
  const rpc = vi.fn().mockResolvedValue(answer)
  return { rpc, supabase: { rpc } as unknown as Client }
}

// The context a call hands the backup when a test does not watch it.
const fixtureCtx = recordingContext()

const call: WriteWorkflowCall = {
  op: 'save',
  orgId: 'org-1',
  workflowId: 'wf-1',
  expectedVersion: 3,
  fields: { name: 'Renamed' },
  saveId: 'save-1',
  actor: { id: 'user-1', email: 'dan@pennie.com', name: 'Dan' },
  storedDefinition: null,
  backup: { env: { GITHUB_TOKEN: 'gh-tok', GITHUB_REPO: 'Try-Pennie/backups', IDEMPOTENCY: {} as KVNamespace, APP_URL: 'https://app.test' }, waitUntil: fixtureCtx.waitUntil },
}

beforeEach(() => {
  vi.clearAllMocks()
  // Backup not configured, unless a test says otherwise, so a write's push does nothing more.
  vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
  vi.mocked(recordBackupSuccess).mockResolvedValue(undefined)
  vi.mocked(recordBackupFailure).mockResolvedValue(false)
})

describe('writeWorkflow', () => {
  it('calls write_workflow with every argument named, and answers the written row', async () => {
    const { rpc, supabase } = client({ data: { workflow: { id: 'wf-1', version: 4 }, version_id: 'ver-9', version_number: 9 }, error: null })
    const result = await writeWorkflow(supabase, call)
    expect(rpc).toHaveBeenCalledWith('write_workflow', {
      p_op: 'save', p_org: 'org-1', p_id: 'wf-1', p_expected_version: 3, p_fields: { name: 'Renamed' },
      p_save_id: 'save-1', p_actor: 'user-1', p_actor_email: 'dan@pennie.com', p_actor_name: 'Dan',
    })
    expect(result).toEqual({ kind: 'written', workflow: { id: 'wf-1', version: 4 }, versionId: 'ver-9', versionNumber: 9, restoredFrom: null, versionsCopied: null })
  })

  // #2339: a person's own account may be used only by its owner, so every
  // definition written carries who bound each app_action step, the server's stamp.
  it('stamps who bound each app_action step on every definition it writes, from the stored definition, never the client\'s', async () => {
    const SAM = '00000000-0000-4000-8000-0000000023d2'
    const DAN = '00000000-0000-4000-8000-0000000023d1'
    const conn = '00000000-0000-4000-8000-0000000023c1'
    const app = (boundBy?: string) => ({ id: 'mail', namespace: 'mail', type: 'app_action', config: { service: 'google', connection: conn, ...(boundBy ? { boundBy } : {}) } })
    const sent = { nodes: [app(SAM)], edges: [] }
    const { rpc, supabase } = client({ data: { workflow: { id: 'wf-1' } }, error: null })
    await writeWorkflow(supabase, { ...call, actor: { id: SAM, email: 'sam@pennie.com', name: 'Sam' }, fields: { definition: sent }, storedDefinition: { nodes: [app(DAN)], edges: [] } })
    expect((rpc.mock.calls[0][1] as { p_fields: { definition: { nodes: Array<{ config: { boundBy: string } }> } } }).p_fields.definition.nodes[0].config.boundBy).toBe(DAN)
    const fresh = client({ data: { workflow: { id: 'wf-2' } }, error: null })
    await writeWorkflow(fresh.supabase, { ...call, op: 'create', workflowId: null, actor: { id: SAM, email: 'sam@pennie.com', name: 'Sam' }, fields: { definition: { nodes: [app(DAN)], edges: [] } }, storedDefinition: null })
    expect((fresh.rpc.mock.calls[0][1] as { p_fields: { definition: { nodes: Array<{ config: { boundBy: string } }> } } }).p_fields.definition.nodes[0].config.boundBy).toBe(SAM)
  })

  it('sends no name as an empty one, which the function stores as none', async () => {
    const { rpc, supabase } = client({ data: { workflow: { id: 'wf-1' } }, error: null })
    await writeWorkflow(supabase, { ...call, actor: { id: 'user-1', email: 'dan@pennie.com', name: null } })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_actor_name: '' })
  })

  it('answers a stale version with the current row, the save that won and who made it', async () => {
    const detail = JSON.stringify({ current: { id: 'wf-1', version: 5 }, last_save_id: 'save-0', changed_by_name: 'Bob', changed_at: '2026-10-23T14:00:00Z' })
    const { supabase } = client({ data: null, error: { code: 'BP409', message: 'stale_version', details: detail } })
    expect(await writeWorkflow(supabase, call)).toEqual({
      kind: 'stale', current: { id: 'wf-1', version: 5 }, lastSaveId: 'save-0', changedByName: 'Bob', changedAt: '2026-10-23T14:00:00Z',
    })
  })

  it('answers a stale version whose detail cannot be read with each part null, never as written', async () => {
    const { supabase } = client({ data: null, error: { code: 'BP409', message: 'stale_version', details: 'not json' } })
    expect(await writeWorkflow(supabase, call)).toEqual({ kind: 'stale', current: null, lastSaveId: null, changedByName: null, changedAt: null })
  })

  it.each([['workflow_not_found', 'workflow'], ['version_not_found', 'version'], ['folder_not_found', 'folder']])('answers %s as not found, naming what', async (message, what) => {
    const { supabase } = client({ data: null, error: { code: 'P0002', message } })
    expect(await writeWorkflow(supabase, call)).toEqual({ kind: 'not_found', what })
  })

  it('answers the connection trigger\'s refusal as that refusal, by name', async () => {
    const details = JSON.stringify([{ id: '33333333-3333-3333-3333-333333333333', problem: 'removed', name: 'Old', steps: ['post'] }])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { supabase } = client({ data: null, error: { code: 'BP409', message: 'workflow_names_missing_connection', details } })
    const result = await writeWorkflow(supabase, call)
    expect(result.kind).toBe('connection_refused')
  })

  it('answers a malformed call refused by the function by its reason', async () => {
    const { supabase } = client({ data: null, error: { code: 'BP422', message: 'name_required', details: null } })
    expect(await writeWorkflow(supabase, call)).toEqual({ kind: 'refused', reason: 'name_required', detail: null })
  })

  it('answers any other error as failed, carrying it, and a reply with no workflow as failed too', async () => {
    const error = { code: '57014', message: 'canceling statement due to statement timeout' }
    expect(await writeWorkflow(client({ data: null, error }).supabase, call)).toEqual({ kind: 'failed', error })
    const empty = await writeWorkflow(client({ data: {}, error: null }).supabase, call)
    expect(empty.kind).toBe('failed')
  })

  it('answers a call that throws as failed rather than throwing into the route', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('fetch failed'))
    const result = await writeWorkflow({ rpc } as unknown as Client, call)
    expect(result.kind).toBe('failed')
  })
})

// #2868: the GitHub backup is pushed by writeWorkflow itself, for every write
// that writes a version snapshot (save and restore), so no route can write a
// version and leave the backup holding the one before it. It runs after the
// write is answered, through the caller's waitUntil, and its failure is
// alerted as the save route always alerted it.
describe('writeWorkflow pushes the GitHub backup of every version it writes (#2868)', () => {
  const WRITTEN = { id: 'wf-1', name: 'Lead Routing', definition: { nodes: [{ id: 'a' }], edges: [] }, version: 5 }

  /** A client answering write_workflow with `answer`, and the commit stamp update with `stamped` rows. */
  const backed = (answer: { data: unknown; error: unknown }, stamped: Array<{ id: string }> = [{ id: 'ver-9' }]) => {
    const updates: Array<{ values: unknown; id: unknown }> = []
    const from = vi.fn((table: string) => ({
      update: (values: unknown) => ({
        eq: (_col: string, id: unknown) => ({
          select: () => {
            updates.push({ values, id })
            return Promise.resolve({ data: table === 'workflow_versions' ? stamped : [], error: null })
          },
        }),
      }),
    }))
    const rpc = vi.fn().mockResolvedValue(answer)
    const ctx = recordingContext()
    return { supabase: { rpc, from } as unknown as Client, ctx, updates, backup: { ...call.backup, waitUntil: ctx.waitUntil } }
  }

  it('pushes a restore\'s definition as the version it wrote, and stamps the commit on that version row', async () => {
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue('commit-abc')
    const { supabase, ctx, updates, backup } = backed({ data: { workflow: WRITTEN, version_id: 'ver-9', version_number: 9, restored_from: 2 }, error: null })
    const result = await writeWorkflow(supabase, { ...call, op: 'restore', fields: { version_id: 'ver-2', definition: WRITTEN.definition }, backup })
    expect(result.kind).toBe('written')
    await ctx.settle()
    expect(vi.mocked(pushWorkflowToGitHub)).toHaveBeenCalledWith('gh-tok', 'Try-Pennie/backups', 'wf-1', 'Lead Routing', WRITTEN.definition, 9, expect.stringMatching(/restore.*v2/i))
    expect(updates).toEqual([{ values: { commit_sha: 'commit-abc' }, id: 'ver-9' }])
    expect(vi.mocked(recordBackupSuccess)).toHaveBeenCalledWith(call.backup.env.IDEMPOTENCY, 'org-1')
    expect(vi.mocked(recordBackupFailure)).not.toHaveBeenCalled()
  })

  it('pushes a save\'s stored definition with the message it was saved with', async () => {
    const { supabase, ctx, backup } = backed({ data: { workflow: WRITTEN, version_id: 'ver-9', version_number: 9 }, error: null })
    await writeWorkflow(supabase, { ...call, fields: { definition: WRITTEN.definition, message: 'fix: the filter' }, backup })
    await ctx.settle()
    expect(vi.mocked(pushWorkflowToGitHub)).toHaveBeenCalledWith('gh-tok', 'Try-Pennie/backups', 'wf-1', 'Lead Routing', WRITTEN.definition, 9, 'fix: the filter')
  })

  it.each(['create', 'duplicate', 'patch', 'delete'] as const)('pushes nothing for a %s, which writes no version of its own', async (op) => {
    const { supabase, ctx, backup } = backed({ data: { workflow: WRITTEN }, error: null })
    await writeWorkflow(supabase, { ...call, op, backup })
    await ctx.settle()
    expect(ctx.waitUntil).not.toHaveBeenCalled()
    expect(vi.mocked(pushWorkflowToGitHub)).not.toHaveBeenCalled()
  })

  it('pushes nothing when nothing was written', async () => {
    const { supabase, ctx, backup } = backed({ data: null, error: { code: 'BP409', message: 'stale_version', details: '{}' } })
    expect((await writeWorkflow(supabase, { ...call, op: 'restore', backup })).kind).toBe('stale')
    await ctx.settle()
    expect(vi.mocked(pushWorkflowToGitHub)).not.toHaveBeenCalled()
  })

  it('answers the write as written when the push fails, and records the failure for the alert', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('GitHub push failed (401): Bad credentials')
    vi.mocked(pushWorkflowToGitHub).mockRejectedValue(failure)
    const { supabase, ctx, updates, backup } = backed({ data: { workflow: WRITTEN, version_id: 'ver-9', version_number: 9, restored_from: 2 }, error: null })
    const result = await writeWorkflow(supabase, { ...call, op: 'restore', backup })
    expect(result.kind).toBe('written')
    await ctx.settle()
    expect(vi.mocked(recordBackupFailure)).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1', workflowId: 'wf-1', workflowName: 'Lead Routing', error: failure, appUrl: 'https://app.test' }))
    expect(vi.mocked(recordBackupSuccess)).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })

  it('answers the write as written when the push throws before it returns a promise', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(pushWorkflowToGitHub).mockImplementation(() => { throw new Error('btoa refused the definition') })
    const { supabase, ctx, backup } = backed({ data: { workflow: WRITTEN, version_id: 'ver-9', version_number: 9 }, error: null })
    expect((await writeWorkflow(supabase, { ...call, backup })).kind).toBe('written')
    await ctx.settle()
    expect(vi.mocked(recordBackupFailure)).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 'wf-1' }))
  })

  it('records no failure from a local dev process, which shares production\'s Slack', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(pushWorkflowToGitHub).mockRejectedValue(new Error('GitHub backup misconfigured: GITHUB_TOKEN is not set (GITHUB_REPO is configured)'))
    const { supabase, ctx, backup } = backed({ data: { workflow: WRITTEN, version_id: 'ver-9', version_number: 9 }, error: null })
    await writeWorkflow(supabase, { ...call, backup: { ...backup, env: { ...backup.env, LOCAL_DEV: 'true' } } })
    await ctx.settle()
    expect(vi.mocked(recordBackupFailure)).not.toHaveBeenCalled()
  })
})
