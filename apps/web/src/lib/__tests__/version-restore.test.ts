import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { versions: { restore: vi.fn() }, workflows: { get: vi.fn() } },
}))

import { api } from '@/lib/api'
import { restoreVersion } from '../version-restore'

/**
 * The canvas's version restore (#1845): restore, then read the workflow back,
 * and hand the canvas whatever it must tell the person. A restore commits, then
 * refreshes the stored copy the engine reads in an outage; when that refresh
 * failed the server says so in stored_copy_warning, which must reach the canvas.
 */
const workflow = { id: 'wf-1', name: 'Engine', definition: { nodes: [], edges: [] } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.workflows.get).mockResolvedValue(workflow as never)
})

describe('restoreVersion', () => {
  it('returns the restored workflow and the stored copy warning the server sent', async () => {
    const warning = 'The change was saved and recorded, but a stored copy of the old version could not be refreshed.'
    vi.mocked(api.versions.restore).mockResolvedValue({ ok: true, version_number: 4, stored_copy_warning: warning })
    const r = await restoreVersion('wf-1', 'ver-1')
    expect(api.versions.restore).toHaveBeenCalledWith('wf-1', 'ver-1')
    expect(r.workflow).toBe(workflow)
    expect(r.notice).toBe(warning)
  })

  it('has nothing to say when the copy was refreshed', async () => {
    vi.mocked(api.versions.restore).mockResolvedValue({ ok: true, version_number: 4 })
    expect((await restoreVersion('wf-1', 'ver-1')).notice).toBeNull()
  })

  it('reads the workflow back only after the restore succeeded', async () => {
    vi.mocked(api.versions.restore).mockRejectedValue(new Error('Restore failed'))
    await expect(restoreVersion('wf-1', 'ver-1')).rejects.toThrow('Restore failed')
    expect(api.workflows.get).not.toHaveBeenCalled()
  })
})
