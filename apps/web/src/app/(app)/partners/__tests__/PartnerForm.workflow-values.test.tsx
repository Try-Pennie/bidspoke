/**
 * The Workflow values tab inside the form (#2142), against PR7's save bar and
 * leave guard (#2138). A sub-account ID is written the moment it is added or
 * removed, outside the versioned save, so it must leave nothing unsaved (no
 * save bar, nothing for the leave guard to ask about), and the tab must read
 * the workflow values again, because what the Constants step emits changed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

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
  vi.mocked(api.buyerSales.list).mockResolvedValue({ entries: [], total: 0, page: 1, limit: 100 })
})

describe('a sub-account ID on the Workflow values tab, against the save bar (#2138)', () => {
  it('is written at once, leaves nothing unsaved, and the tab reads the workflow values again', async () => {
    render(<PartnerForm partner={partner} requestedTab="workflow_values" onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByText(existing.uuid)).toBeVisible()
    await waitFor(() => expect(api.partners.workflowValues).toHaveBeenCalled())
    const readsBefore = vi.mocked(api.partners.workflowValues).mock.calls.length

    fireEvent.change(screen.getByLabelText('New sub-account UUID'), { target: { value: added.uuid } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(await screen.findByText(added.uuid)).toBeVisible()
    expect(api.partnerUuids.create).toHaveBeenCalledWith({ partner_slug: 'sofi', uuid: added.uuid })
    await waitFor(() => expect(vi.mocked(api.partners.workflowValues).mock.calls.length).toBe(readsBefore + 1))
    // Nothing to save: the save bar never offers Save changes for a write already made.
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
  })
})
