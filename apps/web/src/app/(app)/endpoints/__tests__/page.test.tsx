import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/components/NavLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const WARNING = 'The change was saved and recorded, but a stored copy of the old version could not be refreshed.'

// The forms are stubbed to hand the page what the real ones pass on: the
// server's answer, warning included. What is under test is that the page shows it.
vi.mock('@/components/forms/EndpointCreateForm', () => ({
  default: (props: { onCreated: (ep: unknown) => void }) => (
    <button onClick={() => props.onCreated({ id: 'ep-2', subdomain: 'new', path: '/', workflow_id: 'wf-1', workflow_name: null, source_name: 'new', is_active: true, created_at: '', updated_at: '', stored_copy_warning: WARNING })}>Stub create</button>
  ),
}))
vi.mock('@/components/forms/EndpointEditForm', () => ({
  default: (props: { endpoint: Record<string, unknown>; onSaved: (ep: unknown) => void }) => (
    <button onClick={() => props.onSaved({ ...props.endpoint, stored_copy_warning: WARNING })}>Stub save</button>
  ),
}))

vi.mock('@/lib/api', () => ({
  api: {
    endpoints: { list: vi.fn(), update: vi.fn(), delete: vi.fn() },
    workflows: { list: vi.fn() },
  },
}))

import EndpointsPage from '../page'
import { api } from '@/lib/api'

const endpoint = { id: 'ep-1', subdomain: 'engine', path: '/bidding', workflow_id: 'wf-1', workflow_name: 'Engine', source_name: 'engine', is_active: true, created_at: '', updated_at: '' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.endpoints.list).mockResolvedValue([endpoint] as never)
  vi.mocked(api.workflows.list).mockResolvedValue([] as never)
})

// #1846: an endpoint change commits, then clears the copy of the record served
// in a database outage. When KV refuses that, the server answers the change as
// done with stored_copy_warning, and the page shows it.
describe('Endpoints page: a change whose stored copy was not cleared says so', () => {
  it('after switching an endpoint off', async () => {
    vi.mocked(api.endpoints.update).mockResolvedValue({ ...endpoint, is_active: false, stored_copy_warning: WARNING })
    render(<EndpointsPage />)
    fireEvent.click(await screen.findByTitle('Disable endpoint'))
    expect(await screen.findByText(WARNING)).toBeInTheDocument()
  })

  it('after a delete', async () => {
    vi.mocked(api.endpoints.delete).mockResolvedValue({ ok: true, stored_copy_warning: WARNING })
    render(<EndpointsPage />)
    fireEvent.click(await screen.findByLabelText('Delete endpoint'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText(WARNING)).toBeInTheDocument()
  })

  it('after creating one', async () => {
    render(<EndpointsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Stub create' }))
    expect(await screen.findByText(WARNING)).toBeInTheDocument()
  })

  it('after an edit', async () => {
    render(<EndpointsPage />)
    fireEvent.click(await screen.findByLabelText('Edit endpoint'))
    fireEvent.click(screen.getByRole('button', { name: 'Stub save' }))
    expect(await screen.findByText(WARNING)).toBeInTheDocument()
  })
})
