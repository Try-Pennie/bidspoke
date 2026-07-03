import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// NavLayout pulls in nav/auth chrome irrelevant to the delete-confirm flow under test.
vi.mock('@/components/NavLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/lib/api', () => ({
  api: {
    env: { list: vi.fn() },
    envFolders: { list: vi.fn(), delete: vi.fn() },
  },
}))

import EnvPage from '../page'
import { api } from '@/lib/api'

const folder = { id: 'fol-1', organization_id: 'org-1', parent_id: null, name: 'Secrets', created_at: '', updated_at: '' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.env.list).mockResolvedValue([] as never)
  vi.mocked(api.envFolders.list).mockResolvedValue([folder] as never)
})

async function openFolderMenu() {
  render(<EnvPage />)
  fireEvent.click(await screen.findByLabelText('Folder options'))
}

describe('Env page — folder delete requires confirm (#479)', () => {
  it('does not call the delete API on the first click — it shows an inline confirm instead', async () => {
    await openFolderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(api.envFolders.delete).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('deletes only after the confirm button is clicked', async () => {
    vi.mocked(api.envFolders.delete).mockResolvedValue({ ok: true } as never)
    await openFolderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(api.envFolders.delete).toHaveBeenCalledWith('fol-1'))
  })

  it('cancel dismisses the confirm without deleting', async () => {
    await openFolderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(api.envFolders.delete).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })
})
