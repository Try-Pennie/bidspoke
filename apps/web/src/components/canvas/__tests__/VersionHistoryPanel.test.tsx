import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import VersionHistoryPanel from '../VersionHistoryPanel'

// #241: the panel only fetched on mount, so a save made while it was open left a
// stale list. It now refetches when `refreshToken` changes (the canvas bumps it
// on every successful save).
vi.mock('@/lib/api', () => ({ api: { versions: { list: vi.fn() } } }))
import { api } from '@/lib/api'
const listMock = api.versions.list as unknown as ReturnType<typeof vi.fn>

const version = (n: number) => ({
  id: `v${n}`,
  version_number: n,
  message: `change ${n}`,
  created_at: '2026-06-19T12:00:00Z',
})

beforeEach(() => listMock.mockReset())

describe('VersionHistoryPanel', () => {
  const baseProps = { workflowId: 'wf-1', onClose: () => {}, onRestore: async () => {}, width: 340, onResize: () => {} }

  it('refetches and shows the new version when refreshToken changes (#241)', async () => {
    listMock.mockResolvedValueOnce([version(1)])
    const { rerender } = render(<VersionHistoryPanel {...baseProps} refreshToken={0} />)
    expect(await screen.findByText('v1')).toBeInTheDocument()
    expect(listMock).toHaveBeenCalledTimes(1)

    // A save happened: the list now has a newer version and the token bumps.
    listMock.mockResolvedValueOnce([version(2), version(1)])
    rerender(<VersionHistoryPanel {...baseProps} refreshToken={1} />)

    expect(await screen.findByText('v2')).toBeInTheDocument()
    expect(listMock).toHaveBeenCalledTimes(2)
  })

  it('does not refetch when refreshToken is unchanged (re-render with same props)', async () => {
    listMock.mockResolvedValue([version(1)])
    const { rerender } = render(<VersionHistoryPanel {...baseProps} refreshToken={3} />)
    expect(await screen.findByText('v1')).toBeInTheDocument()
    rerender(<VersionHistoryPanel {...baseProps} refreshToken={3} />)
    expect(listMock).toHaveBeenCalledTimes(1)
  })
})

// #494. Restore overwrites nodes, edges and name outright and then re-baselines the
// dirty flag, so whatever was on the canvas unsaved is simply gone. The confirm step
// never said so: it looked identical whether you had unsaved work or not. For a
// non-technical user mid-edit that is silent data loss, and the canvas has no undo
// across a restore.
describe('VersionHistoryPanel: restoring over unsaved work (#494)', () => {
  const baseProps = { workflowId: 'wf-1', onClose: () => {}, onRestore: async () => {}, width: 340, onResize: () => {} }

  async function armRestore() {
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /restore/i }))
    return user
  }

  it('warns that unsaved changes will be discarded before the destructive click', async () => {
    listMock.mockResolvedValue([version(1)])
    render(<VersionHistoryPanel {...baseProps} isDirty />)

    await armRestore()

    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument()
  })

  it('says nothing about unsaved changes when the canvas is clean', async () => {
    // The warning has to mean something. If it showed on every restore, it would be
    // wallpaper and the one time it mattered nobody would read it.
    listMock.mockResolvedValue([version(1)])
    render(<VersionHistoryPanel {...baseProps} isDirty={false} />)

    await armRestore()

    expect(screen.queryByText(/unsaved changes/i)).not.toBeInTheDocument()
  })

  it('still restores when the user confirms despite the warning', async () => {
    const onRestore = vi.fn().mockResolvedValue(undefined)
    listMock.mockResolvedValue([version(1)])
    render(<VersionHistoryPanel {...baseProps} onRestore={onRestore} isDirty />)

    const user = await armRestore()
    await user.click(screen.getByRole('button', { name: /^restore$/i }))

    expect(onRestore).toHaveBeenCalledWith('v1')
  })

  it('does not restore when the user cancels', async () => {
    const onRestore = vi.fn().mockResolvedValue(undefined)
    listMock.mockResolvedValue([version(1)])
    render(<VersionHistoryPanel {...baseProps} onRestore={onRestore} isDirty />)

    const user = await armRestore()
    await user.click(screen.getByRole('button', { name: /cancel/i }))

    expect(onRestore).not.toHaveBeenCalled()
    expect(screen.queryByText(/unsaved changes/i)).not.toBeInTheDocument()
  })
})
