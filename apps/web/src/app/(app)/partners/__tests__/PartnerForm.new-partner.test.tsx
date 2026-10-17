/**
 * The new partner page (#2321, PM-18, design frame 5): its own page with a large
 * heading, asking only the name, the slug and what the partner does, with
 * Cancel and Create partner in the dark bar. No tabs, no Type strip, no Status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/api', () => ({
  api: {
    partners: { usage: vi.fn(), history: vi.fn(), workflowValues: () => Promise.resolve({ partner: { id: 'p', slug: 'p' }, values: [], searched: { workflows: 0, with_constants_node: 0 } }) },
    partnerUuids: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    partnerBidConfigs: { list: vi.fn() },
    buyerProfiles: { get: vi.fn(), usage: vi.fn() },
    buyerSales: { list: vi.fn(), settle: vi.fn() },
  },
}))

import PartnerForm from '../PartnerForm'
import { api } from '@/lib/api'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.partnerUuids.list).mockResolvedValue([])
  vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([])
})

function renderNew(onSave = vi.fn().mockResolvedValue(undefined)) {
  const slot = document.createElement('div')
  document.body.appendChild(slot)
  render(<PartnerForm onSave={onSave} onCancel={vi.fn()} barSlot={slot} />)
  return { onSave, bar: slot }
}

describe('the new partner page (#2321)', () => {
  it('is its own page: a large heading, Name, Slug and Does, and no tabs', () => {
    renderNew()
    expect(screen.getByRole('heading', { level: 2, name: 'New partner' })).toHaveClass('text-2xl')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Name', 'Slug', 'Does'])
    expect(screen.getByRole('checkbox', { name: 'Sends us leads' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Buys leads' })).toBeChecked()
    expect(screen.getByLabelText('Slug')).toHaveAccessibleDescription('Made from the name. Workflows and logs use it, and it cannot change after the partner is created.')
    expect(screen.queryByText('Display name shown in the UI.')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('makes the slug from the name, and creates a partner that does both when both boxes are ticked', async () => {
    const { onSave, bar } = renderNew()
    await userEvent.type(screen.getByLabelText('Name'), 'Acme Lending')
    expect(screen.getByLabelText('Slug')).toHaveValue('acme-lending')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Sends us leads' }))
    await userEvent.click(within(bar).getByRole('button', { name: 'Create partner' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({ name: 'Acme Lending', slug: 'acme-lending', partner_type: 'both' })
  })

  it('holds Create partner until the partner does something', async () => {
    const { bar } = renderNew()
    await userEvent.type(screen.getByLabelText('Name'), 'Acme')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Buys leads' }))
    expect(within(bar).getByRole('button', { name: 'Create partner' })).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Sends us leads' }))
    expect(within(bar).getByRole('button', { name: 'Create partner' })).toBeEnabled()
  })
})

describe('the Create partner rule on every path (#2321)', () => {
  it('Try again after a failed create sends nothing once neither box is ticked, and says what to tick', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error('the server did not answer'))
    const { bar } = renderNew(onSave)
    await userEvent.type(screen.getByLabelText('Name'), 'Acme')
    await userEvent.click(within(bar).getByRole('button', { name: 'Create partner' }))
    expect(await within(bar).findByRole('button', { name: 'Try again' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Buys leads' }))
    await userEvent.click(within(bar).getByRole('button', { name: 'Try again' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(within(bar).getByText('Not created: tick what the partner does, Sends us leads or Buys leads.')).toBeInTheDocument()
  })
})
