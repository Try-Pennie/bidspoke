/**
 * Source-to-workflow assignment enforcement.
 * Empty assignments = unrestricted; any row = locked to listed workflows only.
 * Enforced on the generic /webhooks/:id path; custom endpoints are exempt.
 */
import { describe, it, expect, vi } from 'vitest'
import { enforceSourceAssignment, SourceNotAuthorizedError, SourceAuthUnavailableError } from '../source-assignment'

function makeSupabase(rows: { workflow_id: string }[] | null, error: { message: string } | null = null) {
  const final = { data: rows, error }
  const chain: unknown = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'then') return (resolve: (v: typeof final) => void) => resolve(final)
      return () => chain
    },
  })
  return { from: vi.fn().mockReturnValue(chain) }
}

describe('enforceSourceAssignment', () => {
  it('allows the request when the source has no assignments (unrestricted)', async () => {
    const sb = makeSupabase([])
    await expect(
      enforceSourceAssignment(sb as never, 'org-1', 'website_form', 'wf-1')
    ).resolves.toBeUndefined()
  })

  it('allows the request when the source is explicitly assigned to this workflow', async () => {
    const sb = makeSupabase([{ workflow_id: 'wf-1' }, { workflow_id: 'wf-2' }])
    await expect(
      enforceSourceAssignment(sb as never, 'org-1', 'tripoint', 'wf-1')
    ).resolves.toBeUndefined()
  })

  it('throws SourceNotAuthorizedError when the source is locked to other workflows', async () => {
    const sb = makeSupabase([{ workflow_id: 'wf-other' }])
    await expect(
      enforceSourceAssignment(sb as never, 'org-1', 'tripoint', 'wf-1')
    ).rejects.toBeInstanceOf(SourceNotAuthorizedError)
  })

  it('filters the query by org, source_name', async () => {
    const sb = makeSupabase([])
    const fromSpy = sb.from as ReturnType<typeof vi.fn>
    await enforceSourceAssignment(sb as never, 'org-42', 'wallet_owl', 'wf-9')
    expect(fromSpy).toHaveBeenCalledWith('source_workflow_assignments')
  })

  it('treats a null data response (no error) as unrestricted', async () => {
    const sb = makeSupabase(null)
    await expect(
      enforceSourceAssignment(sb as never, 'org-1', 'x', 'wf-1')
    ).resolves.toBeUndefined()
  })

  it('fails CLOSED (throws SourceAuthUnavailableError) when the lookup errors (#65)', async () => {
    // A DB error must NOT be read as "no assignments → allow" — that would lift a
    // pinned source's workflow restriction during a database blip.
    const sb = makeSupabase(null, { message: 'connection reset' })
    await expect(
      enforceSourceAssignment(sb as never, 'org-1', 'engine', 'wf-1')
    ).rejects.toBeInstanceOf(SourceAuthUnavailableError)
  })
})
