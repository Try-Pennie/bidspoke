import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// NavLayout pulls in nav/auth chrome irrelevant to the delete-confirm flow under test.
vi.mock('@/components/NavLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    workflows: { list: vi.fn(), save: vi.fn(), duplicate: vi.fn(), setActive: vi.fn(), setFolder: vi.fn(), delete: vi.fn(), get: vi.fn() },
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

describe('Workflows page: a copy made without its version history says so', () => {
  it('names the missing history when the server reports it was not copied', async () => {
    vi.mocked(api.workflows.list).mockResolvedValue([workflow])
    vi.mocked(api.workflows.duplicate).mockResolvedValue({ ...(workflow as object), id: 'wf-2', name: 'My Workflow (copy)', history_copied: false } as never)
    render(<WorkflowsPage />)

    fireEvent.click(await screen.findByLabelText('More options'))
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))

    expect(await screen.findByText('My Workflow (copy)')).toBeInTheDocument()
    expect(await screen.findByText(/version history could not be copied/)).toBeInTheDocument()
  })

  it('says nothing extra when the history was copied', async () => {
    vi.mocked(api.workflows.list).mockResolvedValue([workflow])
    vi.mocked(api.workflows.duplicate).mockResolvedValue({ ...(workflow as object), id: 'wf-2', name: 'My Workflow (copy)', history_copied: true } as never)
    render(<WorkflowsPage />)

    fireEvent.click(await screen.findByLabelText('More options'))
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))

    expect(await screen.findByText('My Workflow (copy)')).toBeInTheDocument()
    expect(screen.queryByText(/version history could not be copied/)).not.toBeInTheDocument()
  })
})

// #1845: each change from the list commits, then refreshes the stored copy the
// engine reads in an outage. When that refresh fails the server still answers
// 200 with stored_copy_warning, and the page must show it rather than drop it.
describe('Workflows page: a change whose stored copy was not refreshed says so', () => {
  const WARNING = 'The change was saved and recorded, but a stored copy of the old version could not be refreshed.'

  async function openRowMenu() {
    vi.mocked(api.workflows.list).mockResolvedValue([workflow])
    render(<WorkflowsPage />)
    fireEvent.click(await screen.findByLabelText('More options'))
  }

  it('after switching a workflow off', async () => {
    vi.mocked(api.workflows.setActive).mockResolvedValue({ id: 'wf-1', is_active: false, stored_copy_warning: WARNING })
    await openRowMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    expect(await screen.findByText(WARNING)).toBeInTheDocument()
  })

  it('after a rename', async () => {
    vi.mocked(api.workflows.save).mockResolvedValue({ stored_copy_warning: WARNING } as never)
    await openRowMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    fireEvent.change(screen.getByDisplayValue('My Workflow'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByLabelText('Save name'))
    expect(await screen.findByText(WARNING)).toBeInTheDocument()
  })

  it('after a move to a folder', async () => {
    vi.mocked(api.workflows.setFolder).mockResolvedValue({ id: 'wf-1', folder_id: 'fol-1', stored_copy_warning: WARNING })
    await openRowMenu()
    fireEvent.click(screen.getByRole('button', { name: /Move to folder/ }))
    // The folder header also reads Misc, so pick inside the popover the Root option sits in.
    const picker = screen.getByRole('button', { name: /Root \(no folder\)/ }).parentElement as HTMLElement
    fireEvent.click(within(picker).getByRole('button', { name: 'Misc' }))
    await waitFor(() => expect(api.workflows.setFolder).toHaveBeenCalledWith('wf-1', 'fol-1'))
    expect(await screen.findByText(WARNING)).toBeInTheDocument()
  })

  it('after a delete', async () => {
    vi.mocked(api.workflows.delete).mockResolvedValue({ ok: true, stored_copy_warning: WARNING })
    await openRowMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(await screen.findByText(WARNING)).toBeInTheDocument()
  })

  it('says nothing extra when the copy was refreshed', async () => {
    vi.mocked(api.workflows.setActive).mockResolvedValue({ id: 'wf-1', is_active: false })
    await openRowMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(api.workflows.setActive).toHaveBeenCalled())
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument()
  })
})
