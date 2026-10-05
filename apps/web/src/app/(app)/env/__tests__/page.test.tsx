import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// NavLayout pulls in nav/auth chrome irrelevant to the delete-confirm flow under test.
vi.mock('@/components/NavLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/lib/api', () => ({
  api: {
    env: { list: vi.fn(), update: vi.fn(), reveal: vi.fn(), create: vi.fn() },
    envFolders: { list: vi.fn(), delete: vi.fn() },
    workflows: { list: vi.fn() },
  },
}))

import EnvPage from '../page'
import { api } from '@/lib/api'

const folder = { id: 'fol-1', organization_id: 'org-1', parent_id: null, name: 'Secrets', created_at: '', updated_at: '' }
const plainVar = { id: 'var-1', key: 'MY_VAR', value: 'hello', is_secret: false, scope: 'global', folder_id: null, updated_at: '2026-01-01T00:00:00Z' }
const secretVar = { id: 'var-2', key: 'MY_SECRET', value: null, is_secret: true, scope: 'global', folder_id: null, updated_at: '2026-01-01T00:00:00Z' }

const workflows = [
  { id: 'wf-main', name: 'Main Flow', is_active: true, created_at: '', updated_at: '' },
  { id: 'wf-achieve', name: 'Achieve Offers', is_active: true, created_at: '', updated_at: '' },
]
const companyChannel = { id: 'var-3', key: 'CHANNEL', value: '#alerts', is_secret: false, scope: 'global', workflow_id: null, folder_id: null, updated_at: '2026-01-01T00:00:00Z' }
const mainChannel = { id: 'var-4', key: 'CHANNEL', value: '#main', is_secret: false, scope: 'workflow', workflow_id: 'wf-main', folder_id: null, updated_at: '2026-01-01T00:00:00Z' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.env.list).mockResolvedValue([] as never)
  vi.mocked(api.envFolders.list).mockResolvedValue([folder] as never)
  vi.mocked(api.workflows.list).mockResolvedValue(workflows as never)
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

describe('Env page: which runs read each variable (#1774)', () => {
  it("names the workflow a workflow's own row belongs to, and the workflows a shared row does not reach", async () => {
    vi.mocked(api.env.list).mockResolvedValue([plainVar, companyChannel, mainChannel] as never)
    render(<EnvPage />)

    expect(await screen.findByRole('columnheader', { name: 'Used by' })).toBeInTheDocument()
    const rowOf = (value: string) => screen.getByText(value).closest('tr') as HTMLElement
    expect(within(rowOf('hello')).getByText('All workflows')).toBeInTheDocument()
    expect(within(rowOf('#alerts')).getByText('All workflows except Main Flow')).toBeInTheDocument()
    expect(within(rowOf('#main')).getByText('Main Flow')).toBeInTheDocument()
  })

  it('still lists every variable when the workflows cannot be loaded, and says what is missing', async () => {
    vi.mocked(api.env.list).mockResolvedValue([companyChannel, mainChannel] as never)
    vi.mocked(api.workflows.list).mockRejectedValue(new Error('API 503: upstream'))
    render(<EnvPage />)

    expect(await screen.findByText('#main')).toBeInTheDocument()
    expect(screen.getByText('Workflow name unavailable')).toBeInTheDocument()
    expect(screen.getByText(/could not load the workflows/i)).toHaveTextContent('API 503: upstream')
  })
})

describe('Env page: a variable for one workflow (#1774)', () => {
  async function openForm() {
    render(<EnvPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add variable' }))
  }

  it('offers every workflow by name, and saves the variable against the one chosen', async () => {
    vi.mocked(api.env.create).mockResolvedValue({ ...mainChannel, id: 'var-9' } as never)
    await openForm()

    const usedBy = screen.getByLabelText('Used by')
    expect(within(usedBy).getAllByRole('option').map((o) => o.textContent)).toEqual(['All workflows', 'Achieve Offers', 'Main Flow'])
    fireEvent.change(usedBy, { target: { value: 'wf-main' } })
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'CHANNEL' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '#main' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.env.create).toHaveBeenCalledWith(expect.objectContaining({ key: 'CHANNEL', value: '#main', workflow_id: 'wf-main' })))
    expect(await screen.findByText('Main Flow')).toBeInTheDocument()
  })

  it('saves a variable for all workflows without naming one', async () => {
    vi.mocked(api.env.create).mockResolvedValue({ ...companyChannel, id: 'var-9' } as never)
    await openForm()

    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'CHANNEL' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.env.create).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.env.create).mock.calls[0][0]).not.toHaveProperty('workflow_id')
  })

  it("does not claim a workflow's own secret is copied to the Cloudflare Worker", async () => {
    await openForm()
    expect(screen.getByText(/synced to Cloudflare/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Used by'), { target: { value: 'wf-main' } })

    expect(screen.queryByText(/Cloudflare/)).not.toBeInTheDocument()
  })

  it('offers only all workflows while the workflows cannot be loaded, and says why', async () => {
    vi.mocked(api.workflows.list).mockRejectedValue(new Error('API 503: upstream'))
    await openForm()

    const usedBy = screen.getByLabelText('Used by')
    expect(within(usedBy).getAllByRole('option').map((o) => o.textContent)).toEqual(['All workflows'])
    expect(usedBy).toBeDisabled()
  })
})
