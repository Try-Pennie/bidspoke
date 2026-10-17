/**
 * The Workflow values tab inside the form (#2142), against PR7's save bar and
 * leave guard (#2138). A sub-account ID is written the moment it is added or
 * removed, outside the versioned save, so it must leave nothing unsaved (no
 * save bar, nothing for the leave guard to ask about), and the tab must read
 * the workflow values again, because what the Constants step emits changed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/api', () => ({
  api: {
    partners: { usage: () => Promise.resolve({ bid_group: [], partner_bid: [], latency_gate: [] }), versions: vi.fn(), workflowValues: vi.fn() },
    partnerUuids: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    partnerBidConfigs: { list: vi.fn() },
    buyerProfiles: { get: vi.fn(), usage: vi.fn() },
    buyerSales: { list: vi.fn(), settle: vi.fn() },
  },
}))

import PartnerForm from '../PartnerForm'
import { api } from '@/lib/api'
import type { Partner, PartnerUuid, PartnerWorkflowValues } from '@/lib/api'

const partner: Partner = {
  id: 'p1', organization_id: 'org-1', name: 'Sofi', slug: 'sofi', api_endpoint: null, cf_secret_key: null, daily_cap: null, min_bid: null,
  bid_formula: null, bid_resolver_type: 'api', bid_resolver_config: {}, outbound_field_mapping: null,
  bid_comparison_source: 'auto', extra_extraction: null, last_probe_response: null, dedup_endpoint: null, response_classification: null,
  alert_config: null, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 300, circuit_enabled: true,
  confirmation_window_ms: null, is_active: true, priority: 0, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null,
  sub_account_min_bids: null, partner_type: 'source', created_at: '', updated_at: '2026-10-15T14:00:00Z', updated_by_email: null, updated_by_name: null,
  version: 3,
}
const existing: PartnerUuid = { id: 'uuid-1', partner_slug: 'sofi', uuid: '11111111-1111-4111-8111-111111111111', created_at: '' }
const added: PartnerUuid = { id: 'uuid-2', partner_slug: 'sofi', uuid: '22222222-2222-4222-8222-222222222222', created_at: '' }
const NONE: PartnerWorkflowValues = { partner: { id: 'p1', slug: 'sofi' }, values: [], searched: { workflows: 11, with_constants_node: 7 } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.partnerUuids.list).mockResolvedValue([existing])
  vi.mocked(api.partnerUuids.create).mockResolvedValue(added)
  vi.mocked(api.partners.workflowValues).mockResolvedValue(NONE)
  vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([])
  vi.mocked(api.buyerProfiles.get).mockResolvedValue({ profile: null, accept_signals: [], other_sellers: [] })
  // A buyer's Buyer profile tab reads its usage; unanswered here, as in PartnerForm.test.tsx.
  vi.mocked(api.buyerProfiles.usage).mockRejectedValue(Object.assign(new Error('usage_unavailable'), { status: 503 }))
  vi.mocked(api.buyerSales.list).mockResolvedValue({ entries: [], total: 0, page: 1, limit: 100 })
})

describe('a sub-account ID on the Workflow values tab, against the save bar (#2138)', () => {
  // #2327, PM-24: added through "+ Add sub-account ID" and a box of its own,
  // where it used to be an "Enter UUID" box and a blue Add button.
  it('is written at once, leaves nothing unsaved, and the tab reads the workflow values again', async () => {
    render(<PartnerForm partner={partner} requestedTab="workflow_values" onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByDisplayValue(existing.uuid)).toBeVisible()
    await waitFor(() => expect(api.partners.workflowValues).toHaveBeenCalled())
    const readsBefore = vi.mocked(api.partners.workflowValues).mock.calls.length

    await userEvent.click(screen.getByRole('button', { name: 'Add sub-account ID' }))
    await userEvent.type(screen.getByLabelText('New sub-account ID'), `${added.uuid}{Enter}`)

    expect(await screen.findByDisplayValue(added.uuid)).toBeVisible()
    expect(screen.getByLabelText('Sub-account ID 2')).toHaveValue(added.uuid)
    expect(api.partnerUuids.create).toHaveBeenCalledWith({ partner_slug: 'sofi', uuid: added.uuid })
    await waitFor(() => expect(vi.mocked(api.partners.workflowValues).mock.calls.length).toBe(readsBefore + 1))
    // Nothing to save: the save bar never offers Save changes for a write already made.
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
  })

  it('a changed ID is added before the old one is removed, so a failed removal never leaves the partner with neither (L5)', async () => {
    vi.mocked(api.partnerUuids.delete).mockRejectedValue(new Error('Failed to remove UUID'))
    render(<PartnerForm partner={partner} requestedTab="workflow_values" onSave={vi.fn()} onCancel={vi.fn()} />)
    const box = await screen.findByDisplayValue(existing.uuid)
    fireEvent.change(box, { target: { value: added.uuid } })
    fireEvent.blur(box)

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to remove UUID')
    expect(api.partnerUuids.create).toHaveBeenCalledWith({ partner_slug: 'sofi', uuid: added.uuid })
    expect(api.partnerUuids.delete).toHaveBeenCalledWith(existing.id)
    expect(vi.mocked(api.partnerUuids.create).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.partnerUuids.delete).mock.invocationCallOrder[0])
    // Both are listed, as both are stored: the old one can still be removed with its minus.
    expect(screen.getByLabelText('Sub-account ID 1')).toHaveValue(existing.uuid)
    expect(screen.getByLabelText('Sub-account ID 2')).toHaveValue(added.uuid)
  })
})

describe('the sell-off offer beside its preview (#2327, PM-24, design frame 21)', () => {
  it('is side by side at every width, the preview never stacked under the fields', async () => {
    render(<PartnerForm partner={{ ...partner, sell_off_offer_title: 'Denied?', sell_off_offer_details: '<p>Up to $100,000</p>' }} requestedTab="workflow_values" onSave={vi.fn()} onCancel={vi.fn()} />)
    const grid = (await screen.findByText('As shown')).closest('[data-sell-off]')!
    expect(grid).not.toBeNull()
    // Two columns with no breakpoint: before #2327 it was one column below lg (1024px).
    expect(grid.className.split(/\s+/)).toContain('grid-cols-2')
    expect(grid.className).not.toMatch(/grid-cols-1|lg:/)
    expect(screen.getByText('Up to $100,000')).toBeVisible()
  })

  it('with nothing saved, shows the preview card holding the example, not a sentence', async () => {
    render(<PartnerForm partner={partner} requestedTab="workflow_values" onSave={vi.fn()} onCancel={vi.fn()} />)
    await screen.findByText('As shown')
    expect(document.querySelector('[data-offer-preview]')).toHaveAttribute('data-example', 'true')
    expect(screen.queryByText(/Nothing to show/)).toBeNull()
  })
})

describe('a buyer\'s values (#2327, PM-24, design frame 22)', () => {
  const buyer: Partner = { ...partner, name: 'Liberty1', slug: 'liberty1', partner_type: 'buyer', click_url: 'https://trypennie.com/portal/liberty/{prospect_id}', sub_account_min_bids: { 'bc36a297-28a5-476b-a68b-22a16baa60bf': 3.08 } }

  it('tints the {prospect_id} placeholder in the click URL, in a mono box', async () => {
    render(<PartnerForm partner={buyer} requestedTab="workflow_values" onSave={vi.fn()} onCancel={vi.fn()} />)
    const box = await screen.findByLabelText('Click URL')
    expect(box).toHaveValue(buyer.click_url)
    expect(box).toHaveClass('font-mono')
    const marks = Array.from(document.querySelectorAll('[data-tint-mark]')).map((m) => m.textContent)
    expect(marks).toEqual(['{prospect_id}'])
  })

  it('draws the sub-account minimum bids as a table: headed columns, $ beside the bid, and the add link', async () => {
    render(<PartnerForm partner={buyer} requestedTab="workflow_values" onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByText('Minimum bid')).toBeVisible()
    expect(screen.getByText('Sub-account')).toBeVisible()
    expect(screen.getByLabelText('Sub-account UUID, floor 1')).toHaveValue('bc36a297-28a5-476b-a68b-22a16baa60bf')
    const bid = screen.getByLabelText('Minimum bid, floor 1')
    expect(bid).toHaveValue(3.08)
    // "$" is a fixed word of the value, so it sits beside the box, never in it (Dan, 2026-10-17).
    expect(bid.parentElement).toHaveTextContent('$')
    // A dark add link, where it was a white "Add row" button.
    expect(screen.getByRole('button', { name: 'Add sub-account' })).toHaveClass('btn-quiet')
    expect(screen.queryByRole('button', { name: /Add row/ })).toBeNull()
  })
})
