/**
 * Issue #550: same fix as EndpointCreateForm — clearing the partner slug and
 * saving must surface an explicit error, not a silently disabled button.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import EndpointEditForm from '../EndpointEditForm'
import { api } from '@/lib/api'
import type { WebhookEndpoint } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    endpoints: {
      update: vi.fn(),
    },
  },
}))

const endpoint: WebhookEndpoint = {
  id: 'ep-1',
  subdomain: 'lead-economy',
  path: '/',
  workflow_id: 'wf-1',
  source_name: 'lead-economy',
} as WebhookEndpoint

const workflows = [{ id: 'wf-1', name: 'Lead Economy Bidding Workflow' }] as never[]

describe('EndpointEditForm (#550)', () => {
  it('shows an error instead of doing nothing when the partner slug is cleared', () => {
    render(<EndpointEditForm endpoint={endpoint} workflows={workflows} onSaved={() => {}} onCancel={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('partner-name'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(screen.getByText('Partner slug is required.')).toBeInTheDocument()
    expect(api.endpoints.update).not.toHaveBeenCalled()
  })

  it('saves when the partner slug is present', async () => {
    vi.mocked(api.endpoints.update).mockResolvedValue({ ...endpoint } as never)
    const onSaved = vi.fn()
    render(<EndpointEditForm endpoint={endpoint} workflows={workflows} onSaved={onSaved} onCancel={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  })
})
