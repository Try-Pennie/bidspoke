import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// NavLayout pulls in nav/auth chrome irrelevant to the delete-confirm flow under test.
vi.mock('@/components/NavLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/lib/api', () => ({
  api: {
    env: { list: vi.fn(), update: vi.fn(), reveal: vi.fn() },
    envFolders: { list: vi.fn(), delete: vi.fn() },
  },
}))

import EnvPage from '../page'
import { api } from '@/lib/api'

const folder = { id: 'fol-1', organization_id: 'org-1', parent_id: null, name: 'Secrets', created_at: '', updated_at: '' }
const plainVar = { id: 'var-1', key: 'MY_VAR', value: 'hello', is_secret: false, scope: 'global', folder_id: null, updated_at: '2026-01-01T00:00:00Z' }
const secretVar = { id: 'var-2', key: 'MY_SECRET', value: null, is_secret: true, scope: 'global', folder_id: null, updated_at: '2026-01-01T00:00:00Z' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.env.list).mockResolvedValue([] as never)
  vi.mocked(api.envFolders.list).mockResolvedValue([folder] as never)
})

async function openFolderMenu() {
  render(<EnvPage />)
  fireEvent.click(await screen.findByLabelText('Folder options'))
}

async function openRowMenu() {
  render(<EnvPage />)
  fireEvent.click(await screen.findByLabelText('More options'))
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

describe('Env page — edit value (#480)', () => {
  it('shows an Edit value option in the row menu', async () => {
    vi.mocked(api.env.list).mockResolvedValue([plainVar] as never)
    await openRowMenu()

    expect(screen.getByRole('button', { name: 'Edit value' })).toBeInTheDocument()
  })

  it('edits a plain variable value and saves via PUT', async () => {
    vi.mocked(api.env.list).mockResolvedValue([plainVar] as never)
    vi.mocked(api.env.update).mockResolvedValue({ ...plainVar, value: 'world' } as never)
    await openRowMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Edit value' }))

    const input = screen.getByDisplayValue('hello')
    fireEvent.change(input, { target: { value: 'world' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save value' }))

    await waitFor(() => expect(api.env.update).toHaveBeenCalledWith('var-1', { value: 'world' }))
    expect(await screen.findByText('world')).toBeInTheDocument()
  })

  it('cancel dismisses the edit without calling update', async () => {
    vi.mocked(api.env.list).mockResolvedValue([plainVar] as never)
    await openRowMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Edit value' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }))

    expect(api.env.update).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Save value' })).not.toBeInTheDocument()
  })

  it('secret edit starts blank, disables save until a value is entered, and rotates via PUT', async () => {
    vi.mocked(api.env.list).mockResolvedValue([secretVar] as never)
    vi.mocked(api.env.update).mockResolvedValue({ ...secretVar, value: null } as never)
    await openRowMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Edit value' }))

    const input = screen.getByPlaceholderText('Enter new value to rotate')
    expect(input).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Save value' })).toBeDisabled()

    fireEvent.change(input, { target: { value: 'new-secret-123' } })
    expect(screen.getByRole('button', { name: 'Save value' })).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save value' }))

    await waitFor(() => expect(api.env.update).toHaveBeenCalledWith('var-2', { value: 'new-secret-123' }))
  })

  it('rotating a secret clears the "rotate to enable reveal" unavailable state', async () => {
    vi.mocked(api.env.list).mockResolvedValue([secretVar] as never)
    vi.mocked(api.env.reveal).mockRejectedValue(new Error('422'))
    vi.mocked(api.env.update).mockResolvedValue({ ...secretVar, value: null } as never)
    render(<EnvPage />)

    fireEvent.click(await screen.findByLabelText('Show value'))
    expect(await screen.findByText('Rotate to enable reveal')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('More options'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit value' }))
    fireEvent.change(screen.getByPlaceholderText('Enter new value to rotate'), { target: { value: 'rotated-value' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save value' }))

    await waitFor(() => expect(api.env.update).toHaveBeenCalled())
    expect(screen.queryByText('Rotate to enable reveal')).not.toBeInTheDocument()
  })
})
