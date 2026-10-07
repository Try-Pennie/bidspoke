import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ api: { workflows: { renameApply: vi.fn() } } }))

import { api } from '@/lib/api'
import { applyFormulaRenames } from '../formula-renames'

/**
 * The partner formula rewrites a save applies for the steps renamed since the
 * last save. Each can fail on its own, and each that lands also clears the
 * partners' stored outage copies, which can fail too (#1846). Every failure
 * comes back as one line for the save's message; none stops the next rename.
 */
const WARNING = 'The change was saved and recorded, but a stored copy of the old version could not be refreshed.'

beforeEach(() => vi.clearAllMocks())

describe('applyFormulaRenames', () => {
  it('applies every rename and reports nothing when all landed', async () => {
    vi.mocked(api.workflows.renameApply).mockResolvedValue({ updated: 1 })
    expect(await applyFormulaRenames('wf-1', [{ oldNs: 'a', newNs: 'b', partner_ids: ['p-1'] }, { oldNs: 'c', newNs: 'd', partner_ids: ['p-2'] }])).toEqual([])
    expect(api.workflows.renameApply).toHaveBeenCalledTimes(2)
    expect(api.workflows.renameApply).toHaveBeenCalledWith('wf-1', 'a', 'b', ['p-1'])
  })

  it('reports a failed rewrite and still applies the next', async () => {
    vi.mocked(api.workflows.renameApply).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ updated: 1 })
    const failures = await applyFormulaRenames('wf-1', [{ oldNs: 'a', newNs: 'b', partner_ids: [] }, { oldNs: 'c', newNs: 'd', partner_ids: [] }])
    expect(failures).toEqual(['Saved, but failed to rewrite partner formulas for a→b: boom'])
    expect(api.workflows.renameApply).toHaveBeenCalledTimes(2)
  })

  it('reports the stored copy warning of a rewrite that landed', async () => {
    vi.mocked(api.workflows.renameApply).mockResolvedValue({ updated: 2, copies_not_cleared: ['p-1'], stored_copy_warning: WARNING })
    expect(await applyFormulaRenames('wf-1', [{ oldNs: 'a', newNs: 'b', partner_ids: ['p-1'] }])).toEqual([WARNING])
  })

  it('reports the stored copy warning once however many renames hit it', async () => {
    vi.mocked(api.workflows.renameApply).mockResolvedValue({ updated: 1, copies_not_cleared: ['p-1'], stored_copy_warning: WARNING })
    expect(await applyFormulaRenames('wf-1', [{ oldNs: 'a', newNs: 'b', partner_ids: ['p-1'] }, { oldNs: 'c', newNs: 'd', partner_ids: ['p-1'] }])).toEqual([WARNING])
  })
})
