/**
 * Issue #550: same fix as EndpointCreateForm. Clearing the partner slug and
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

/**
 * Issue #556. Create and edit were near-duplicate files, which is why the #550
 * partner-slug fix had to be made twice. They now share one form, so these pin
 * the things edit does DIFFERENTLY, which is what a consolidation can quietly
 * flatten away.
 */
describe('EndpointEditForm keeps what edit does differently (#556)', () => {
  it('shows a stored single-segment path as empty rather than a literal slash', () => {
    render(<EndpointEditForm endpoint={endpoint} workflows={workflows} onSaved={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByPlaceholderText('/bidding')).toHaveValue('')
  })

  it('seeds the existing values', () => {
    render(<EndpointEditForm endpoint={endpoint} workflows={workflows} onSaved={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByPlaceholderText('partner-name')).toHaveValue('lead-economy')
  })

  it('does NOT mirror the slug into the source name', () => {
    // Only create does that. Retyping a slug on an existing endpoint must not
    // silently rewrite the source name that live traffic is already tagged with.
    render(<EndpointEditForm endpoint={endpoint} workflows={workflows} onSaved={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('partner-name'), { target: { value: 'renamed' } })
    expect(screen.getByPlaceholderText('renamed')).toHaveValue('lead-economy')
  })

  it('always shows the workflow picker', () => {
    render(<EndpointEditForm endpoint={endpoint} workflows={workflows} onSaved={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  it('resolves the workflow name the update response does not carry', async () => {
    const onSaved = vi.fn()
    vi.mocked(api.endpoints.update).mockResolvedValue({ ...endpoint, workflow_id: 'wf-1' } as never)
    render(<EndpointEditForm endpoint={endpoint} workflows={workflows} onSaved={onSaved} onCancel={vi.fn()} />)
    fireEvent.submit(screen.getByRole('button', { name: /save changes/i }).closest('form') as HTMLFormElement)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onSaved.mock.calls[0][0].workflow_name).toBe('Lead Economy Bidding Workflow')
  })
})
