import { describe, expect, it, vi } from 'vitest'
import { writeWorkflow, type WriteWorkflowCall } from '../write-workflow'
import type { createSupabaseClient } from '../supabase'

// writeWorkflow (#1947): the Worker's one way to write a workflow, through the
// write_workflow database function. These pin the call it makes and how each
// answer of the function reaches a route.

type Client = ReturnType<typeof createSupabaseClient>
const client = (answer: { data: unknown; error: unknown }) => {
  const rpc = vi.fn().mockResolvedValue(answer)
  return { rpc, supabase: { rpc } as unknown as Client }
}

const call: WriteWorkflowCall = {
  op: 'save',
  orgId: 'org-1',
  workflowId: 'wf-1',
  expectedVersion: 3,
  fields: { name: 'Renamed' },
  saveId: 'save-1',
  actor: { id: 'user-1', email: 'dan@pennie.com', name: 'Dan' },
}

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
