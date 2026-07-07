/**
 * Issue #550: the Create endpoint button was disabled whenever the partner
 * slug was empty, with no message telling the user why — and a layout bug
 * elsewhere on the form made the slug input hard to reach, so it silently
 * stayed empty. This locks in that submitting without a slug now surfaces
 * an explicit error instead of doing nothing.
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
