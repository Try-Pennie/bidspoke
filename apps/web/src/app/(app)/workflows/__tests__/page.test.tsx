import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// NavLayout pulls in nav/auth chrome irrelevant to the delete-confirm flow under test.
vi.mock('@/components/NavLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    workflows: { list: vi.fn(), save: vi.fn() },
    stats: { get: vi.fn() },
    folders: { list: vi.fn(), delete: vi.fn() },
  },
}))

import WorkflowsPage from '../page'
import { api } from '@/lib/api'

const folder = { id: 'fol-1', organization_id: 'org-1', parent_id: null, name: 'Misc', created_at: '', updated_at: '' }
const workflow = {
  id: 'wf-1',
  organization_id: 'org-1',
  folder_id: null,
  name: 'My Workflow',
  description: null,
  is_active: true,
  updated_at: '2026-07-01T00:00:00.000Z',
  updated_by_name: null,
  updated_by_email: null,
} as never

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.workflows.list).mockResolvedValue([] as never)
  vi.mocked(api.stats.get).mockResolvedValue({ by_workflow: [] } as never)
  vi.mocked(api.folders.list).mockResolvedValue([folder] as never)
})

async function openFolderMenu() {
  render(<WorkflowsPage />)
  fireEvent.click(await screen.findByLabelText('Folder options'))
}

describe('Workflows page — folder delete requires confirm (#479)', () => {
  it('does not call the delete API on the first click — it shows an inline confirm instead', async () => {
    await openFolderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(api.folders.delete).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('deletes only after the confirm button is clicked', async () => {
    vi.mocked(api.folders.delete).mockResolvedValue({ ok: true } as never)
    await openFolderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(api.folders.delete).toHaveBeenCalledWith('fol-1'))
  })

  it('cancel dismisses the confirm without deleting', async () => {
    await openFolderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(api.folders.delete).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })

  it('surfaces the server contents message when the folder is not empty', async () => {
    const err = Object.assign(new Error('Folder still has 1 workflow — move or delete them first.'), { status: 409 })
    vi.mocked(api.folders.delete).mockRejectedValue(err)
    await openFolderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('Folder still has 1 workflow — move or delete them first.')).toBeInTheDocument()
  })
})

describe('Workflows page — failed rename surfaces an error (#514)', () => {
  it('shows an error and reverts the name when save fails, instead of failing silently', async () => {
    vi.mocked(api.workflows.list).mockResolvedValue([workflow])
    vi.mocked(api.workflows.save).mockRejectedValue(new Error('Failed to save workflow'))
    render(<WorkflowsPage />)

    fireEvent.click(await screen.findByLabelText('More options'))
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    const input = screen.getByDisplayValue('My Workflow')
    fireEvent.change(input, { target: { value: 'Renamed Workflow' } })
    fireEvent.click(screen.getByLabelText('Save name'))

    expect(await screen.findByText('Failed to save workflow')).toBeInTheDocument()
    expect(await screen.findByText('My Workflow')).toBeInTheDocument()
    expect(screen.queryByText('Renamed Workflow')).not.toBeInTheDocument()
  })
})
