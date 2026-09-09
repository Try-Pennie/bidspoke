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
    // Delays injected as zero: this asserts the outcome, not the wait. With the
    // real ladder the retries outlive the test's own timeout and the failure is
    // logged during whichever test runs next (L205).
    await expect(
      writeAuditLog(sb as never, 'org-1', 'workflow', 'wf-1', 'deleted', 'user-1', undefined, [0, 0])
    ).resolves.toBeUndefined()
  })

  // #105: a dropped audit row used to vanish silently (that's how the stale
  // CHECK constraints rejected newer entity types for months). It must log.
  it('logs (does not silently drop) when the insert fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sb = makeSupabase({ message: 'check constraint violation' })
    await writeAuditLog(sb as never, 'org-1', 'partner_uuid', 'pu-1', 'created', 'user-1', undefined, [0, 0])
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

// #277: writeAuditLog was single-attempt, so a transient Supabase failure (the
// nightly partition purge holding a lock, a statement timeout, a dropped
// connection) dropped the audit row for good. It logged, which beats silence,
// but a log line is not an audit trail. The step logger already survives this
// window; the audit write did not.
//
// Delays are injected rather than real, so these assert the ladder without
// waiting for it.
describe('writeAuditLog retries', () => {
  const NO_DELAYS = [0, 0]

  function supabaseReturning(results: Array<{ error: { code?: string; message: string } | null }>) {
    let call = 0
    const insert = vi
      .fn()
      .mockImplementation(() => Promise.resolve(results[Math.min(call++, results.length - 1)]))
    return { supabase: { from: vi.fn().mockReturnValue({ insert }) }, insert }
  }

  it('retries a statement timeout and records the row on the second attempt', async () => {
    const { supabase, insert } = supabaseReturning([
      { error: { code: '57014', message: 'canceling statement due to statement timeout' } },
      { error: null },
    ])
    await writeAuditLog(
      supabase as never, 'org-1', 'workflow', 'wf-1', 'deleted', 'user-1', undefined, NO_DELAYS
    )
    expect(insert).toHaveBeenCalledTimes(2)
  })

  it('does not log a failure when a retry succeeds', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { supabase } = supabaseReturning([
      { error: { code: '57014', message: 'canceling statement due to statement timeout' } },
      { error: null },
    ])
    await writeAuditLog(
      supabase as never, 'org-1', 'workflow', 'wf-1', 'deleted', 'user-1', undefined, NO_DELAYS
    )
    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('stops immediately on a permanent error rather than spending the ladder', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { supabase, insert } = supabaseReturning([
      { error: { code: '23502', message: 'null value in column violates not-null constraint' } },
    ])
    await writeAuditLog(
      supabase as never, 'org-1', 'workflow', 'wf-1', 'deleted', 'user-1', undefined, NO_DELAYS
    )
    expect(insert).toHaveBeenCalledTimes(1)
    errSpy.mockRestore()
  })

  it('logs once, and says how many attempts it made, when the ladder is exhausted', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { supabase, insert } = supabaseReturning([
      { error: { code: '57014', message: 'canceling statement due to statement timeout' } },
    ])
    await writeAuditLog(
      supabase as never, 'org-1', 'partner_config', 'p-9', 'updated', 'user-1', undefined, NO_DELAYS
    )
    expect(insert).toHaveBeenCalledTimes(NO_DELAYS.length + 1)
    expect(errSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(errSpy.mock.calls)
    expect(logged).toContain('partner_config')
    expect(logged).toContain(String(NO_DELAYS.length + 1))
    errSpy.mockRestore()
  })

  it('still resolves rather than throwing when every attempt fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { supabase } = supabaseReturning([
      { error: { code: '57014', message: 'timeout' } },
    ])
    await expect(
      writeAuditLog(supabase as never, 'org-1', 'workflow', 'w-1', 'updated', 'u-1', undefined, NO_DELAYS)
    ).resolves.toBeUndefined()
    errSpy.mockRestore()
  })
})
