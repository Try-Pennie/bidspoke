import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TriggerConfigPanel from '../TriggerConfigPanel'

const WARNING = 'The change was saved and recorded, but a stored copy of the old version could not be refreshed.'

vi.mock('@/lib/api', () => ({
  api: {
    endpoints: { list: vi.fn().mockResolvedValue([]) },
    sources: {
      list: vi.fn().mockResolvedValue([]),
      listAssignments: vi.fn().mockResolvedValue([]),
    },
  },
}))
// The create form is stubbed to hand the panel what the real one passes on:
// the server's answer, warning included.
vi.mock('@/components/forms/EndpointCreateForm', () => ({
  default: (props: { onCreated: (ep: unknown) => void }) => (
    <button onClick={() => props.onCreated({ id: 'ep-2', subdomain: 'new', path: '/', workflow_id: 'wf-1', workflow_name: null, source_name: 'new', is_active: true, created_at: '', updated_at: '', stored_copy_warning: WARNING })}>Stub create</button>
  ),
}))
vi.mock('@/components/forms/SourceCreateForm', () => ({ default: () => null }))

// #1846: creating an endpoint clears any copy left at its address from one
// before it. When KV refuses that, the server answers the create as done with
// stored_copy_warning, and the panel shows it.
describe('TriggerConfigPanel: an endpoint created with a stored copy not cleared says so', () => {
  it('shows the warning', async () => {
    render(
      <TriggerConfigPanel
        workflowId="wf-1"
        workflowName="Main Flow"
        trigger={{ type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } }}
        onChange={vi.fn()}
        onClose={vi.fn()}
        width={320}
        onResize={vi.fn()}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Stub create' }))
    expect(await screen.findByText(WARNING)).toBeInTheDocument()
  })
})
