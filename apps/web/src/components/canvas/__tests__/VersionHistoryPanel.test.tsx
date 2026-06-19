import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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
  const baseProps = { workflowId: 'wf-1', onClose: () => {}, onRestore: async () => {} }

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
