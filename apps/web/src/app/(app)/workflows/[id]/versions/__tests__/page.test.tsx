import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/components/NavLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'wf-1' }),
  useRouter: () => ({ push }),
}))

vi.mock('@/lib/api', () => ({
  api: { versions: { list: vi.fn(), restore: vi.fn() } },
}))

import VersionHistoryPage from '../page'
import { api } from '@/lib/api'

const version = { id: 'ver-1', workflow_id: 'wf-1', version_number: 3, message: 'before the change', created_at: '2026-10-01T12:00:00.000Z' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.versions.list).mockResolvedValue([version] as never)
})

async function restore() {
  render(<VersionHistoryPage />)
  fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
}

// #1845: a restore commits, then refreshes the stored copy the engine reads in
// an outage. When that refresh fails the server answers 200 with
// stored_copy_warning; the page stays and shows it instead of navigating away.
describe('Version history: a restore whose stored copy was not refreshed says so', () => {
  it('shows the warning and stays on the page', async () => {
    const warning = 'The change was saved and recorded, but a stored copy of the old version could not be refreshed.'
    vi.mocked(api.versions.restore).mockResolvedValue({ ok: true, version_number: 4, stored_copy_warning: warning })
    await restore()
    expect(await screen.findByText(warning)).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('returns to the editor when the copy was refreshed', async () => {
    vi.mocked(api.versions.restore).mockResolvedValue({ ok: true, version_number: 4 })
    await restore()
    await waitFor(() => expect(push).toHaveBeenCalledWith('/workflows/wf-1'))
  })
})
