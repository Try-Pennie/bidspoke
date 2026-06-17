/**
 * Audit log — PRD Section 3.1
 * Smoke tests: verify insert shape, no throw when Supabase returns an error.
 */
import { describe, it, expect, vi } from 'vitest'
import { writeAuditLog } from '../audit'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSupabase(insertError: { message: string } | null = null) {
  const insertSpy = vi.fn().mockResolvedValue({ data: null, error: insertError })
  const supabase = {
    from: vi.fn().mockReturnValue({ insert: insertSpy }),
    _insertSpy: insertSpy,
  }
  return supabase
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('writeAuditLog', () => {
  it('inserts a row with all required fields', async () => {
    const sb = makeSupabase()
    await writeAuditLog(
      sb as never,
      'org-1',
      'workflow',
      'wf-abc',
      'created',
      'user-1',
      { name: 'My Workflow' }
    )

    expect(sb.from).toHaveBeenCalledWith('audit_log')
    expect(sb._insertSpy).toHaveBeenCalledWith({
      organization_id: 'org-1',
      entity_type: 'workflow',
      entity_id: 'wf-abc',
      action: 'created',
      changed_by: 'user-1',
      changes: { name: 'My Workflow' },
    })
  })

  it('sets changes to null when omitted', async () => {
    const sb = makeSupabase()
    await writeAuditLog(sb as never, 'org-1', 'partner_config', 'p-1', 'updated', 'user-1')

    expect(sb._insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ changes: null })
    )
  })

  it('does not throw when Supabase returns an error', async () => {
    const sb = makeSupabase({ message: 'connection refused' })
    // Should resolve without throwing even when the insert fails
    await expect(
      writeAuditLog(sb as never, 'org-1', 'workflow', 'wf-1', 'deleted', 'user-1')
    ).resolves.toBeUndefined()
  })

  // #105: a dropped audit row used to vanish silently (that's how the stale
  // CHECK constraints rejected newer entity types for months). It must log.
  it('logs (does not silently drop) when the insert fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sb = makeSupabase({ message: 'check constraint violation' })
    await writeAuditLog(sb as never, 'org-1', 'partner_uuid', 'pu-1', 'created', 'user-1')
    expect(errSpy).toHaveBeenCalled()
    const logged = JSON.stringify(errSpy.mock.calls)
    expect(logged).toContain('partner_uuid')
    expect(logged).toContain('check constraint violation')
    errSpy.mockRestore()
  })

  it('does not log on a successful insert', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await writeAuditLog(makeSupabase() as never, 'org-1', 'api_source', 's-1', 'created', 'user-1')
    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('supports all entity types without throwing', async () => {
    const entityTypes = ['partner_config', 'environment_variable', 'service_connection', 'workflow', 'circuit_breaker'] as const
    for (const entityType of entityTypes) {
      const sb = makeSupabase()
      await expect(
        writeAuditLog(sb as never, 'org-1', entityType, 'id-1', 'created', 'user-1')
      ).resolves.toBeUndefined()
    }
  })

  it('supports all action types without throwing', async () => {
    const actions = ['created', 'updated', 'deleted', 'circuit_force_closed', 'secret_rotated'] as const
    for (const action of actions) {
      const sb = makeSupabase()
      await expect(
        writeAuditLog(sb as never, 'org-1', 'workflow', 'wf-1', action, 'user-1')
      ).resolves.toBeUndefined()
    }
  })
})
