/**
 * Issue #550: the Create endpoint button was disabled whenever the partner
 * slug was empty, with no message telling the user why. A layout bug
 * elsewhere on the form also made the slug input hard to reach, so it
 * silently stayed empty. This locks in that submitting without a slug now
 * surfaces an explicit error instead of doing nothing.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import EndpointCreateForm from '../EndpointCreateForm'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    endpoints: {
      create: vi.fn(),
    },
  },
}))

describe('EndpointCreateForm (#550)', () => {
  it('shows an error instead of doing nothing when the partner slug is empty', () => {
    render(
      <EndpointCreateForm
        workflowId="wf-1"
        workflowName="Lead Economy Bidding Workflow"
        lockWorkflow
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create endpoint' }))
    expect(screen.getByText('Partner slug is required.')).toBeInTheDocument()
    expect(api.endpoints.create).not.toHaveBeenCalled()
  })

  it('submits once a partner slug is entered', async () => {
    vi.mocked(api.endpoints.create).mockResolvedValue({
      id: 'ep-1',
      subdomain: 'lead-economy',
      path: '/',
      workflow_id: 'wf-1',
      source_name: 'lead-economy',
    } as never)
    const onCreated = vi.fn()
    render(
      <EndpointCreateForm
        workflowId="wf-1"
        workflowName="Lead Economy Bidding Workflow"
        lockWorkflow
        onCreated={onCreated}
        onCancel={() => {}}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('partner-name'), { target: { value: 'lead-economy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create endpoint' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Partner slug is required.')).not.toBeInTheDocument()
  })
})

/**
 * Issue #556. Create and edit now share one form, so these pin the things create
 * does DIFFERENTLY, which is what a consolidation can quietly flatten away.
 */
const workflows = [{ id: 'wf-1', name: 'Lead Economy Bidding Workflow' }] as never[]

describe('EndpointCreateForm keeps what create does differently (#556)', () => {
  it('mirrors the slug into the source name', () => {
    render(<EndpointCreateForm workflows={workflows} onCreated={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('partner-name'), { target: { value: 'acme' } })
    expect(screen.getByPlaceholderText('acme')).toHaveValue('acme')
  })

  it('stops mirroring once the source name is edited', () => {
    render(<EndpointCreateForm workflows={workflows} onCreated={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('partner-name'), { target: { value: 'acme' } })
    fireEvent.change(screen.getByPlaceholderText('acme'), { target: { value: 'chosen' } })
    fireEvent.change(screen.getByPlaceholderText('partner-name'), { target: { value: 'acme-two' } })
    expect(screen.getByPlaceholderText('acme-two')).toHaveValue('chosen')
  })

  it('hides the workflow picker when the workflow is locked', () => {
    render(
      <EndpointCreateForm
        lockWorkflow
        workflowId="wf-1"
        workflowName="Main Flow"
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByText('Main Flow')).toBeInTheDocument()
  })

  it('shows the picker when the workflow is not locked', () => {
    render(<EndpointCreateForm workflows={workflows} onCreated={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })
})
