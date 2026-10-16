/**
 * Deleting the bid matrix a partner's resolver points at (#2217).
 *
 * The delete itself is immediate on the server, but the partner's
 * bid_resolver_config is page state: it is cleared to "No matrix" through the
 * page draft, so the page shows an unsaved change and the next save sends it,
 * instead of the partner going on naming a matrix that no longer exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/lib/api', () => ({
  api: {
    partners: { usage: () => Promise.resolve({ bid_group: [], partner_bid: [], latency_gate: [] }) },
    partnerUuids: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    partnerBidConfigs: { list: vi.fn(), get: vi.fn(), delete: vi.fn(), sync: vi.fn(), create: vi.fn() },
    buyerProfiles: { get: vi.fn(), history: vi.fn(), usage: vi.fn() },
    buyerSales: { list: vi.fn(), settle: vi.fn() },
    heldClicks: { list: vi.fn(), markSent: vi.fn(), free: vi.fn(), clear: vi.fn(), retrySalesforce: vi.fn() },
  },
}))

import PartnerForm from '../PartnerForm'
import { api } from '@/lib/api'
import type { Partner, PartnerBidConfig } from '@/lib/api'

const partner: Partner = {
  id: 'p1', organization_id: 'org-1', name: 'SoFi', slug: 'sofi', api_endpoint: null, cf_secret_key: null, daily_cap: null, min_bid: null,
  bid_formula: null, bid_resolver_type: 'matrix', bid_resolver_config: { bid_config_id: 'cfg-1' }, outbound_field_mapping: null,
  bid_comparison_source: 'auto', extra_extraction: null, last_probe_response: null, dedup_endpoint: null, response_classification: null,
  alert_config: null, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 300, circuit_enabled: true,
  confirmation_window_ms: null, is_active: true, priority: 0, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null,
  sub_account_min_bids: null, partner_type: 'buyer', created_at: '', updated_at: '2026-10-15T14:00:00Z', updated_by_email: null, updated_by_name: null,
  version: 3,
}

const matrix = (id: string, name: string) => ({
  id, name, slug: id, is_default: id === 'cfg-1', is_active: true, sync_source: 'salesforce', last_synced_at: null, last_sync_error: null,
  dimensions: [{ name: 'debt_amount', payload_field: 'debt_amount', column: 'row' }],
}) as unknown as PartnerBidConfig

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.partnerUuids.list).mockResolvedValue([])
  vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([matrix('cfg-1', 'sofi default'), matrix('cfg-2', 'sofi spare')])
  vi.mocked(api.partnerBidConfigs.get).mockImplementation(async (id: string) => ({ config: matrix(id, id), rows: [] }) as never)
  vi.mocked(api.partnerBidConfigs.delete).mockResolvedValue({ ok: true })
  vi.mocked(api.buyerProfiles.get).mockResolvedValue({ profile: null, accept_signals: [], other_sellers: [] })
  vi.mocked(api.buyerProfiles.history).mockResolvedValue({ entries: [] })
  vi.mocked(api.buyerProfiles.usage).mockRejectedValue(Object.assign(new Error('usage_unavailable'), { status: 503 }))
  vi.mocked(api.buyerSales.list).mockResolvedValue({ entries: [], total: 0, page: 1, limit: 100 })
  vi.mocked(api.heldClicks.list).mockResolvedValue({ entries: [], total: 0 })
})

describe('deleting the matrix the partner uses (#2217)', () => {
  it('clears the partner to no matrix as an unsaved change, and the save sends it', async () => {
    const onSave = vi.fn().mockResolvedValue({ partner: { ...partner, bid_resolver_config: { bid_config_id: null }, version: 4 }, profile: null, copyWarning: null })
    // The matrix is on the Bid Group tab (#2137), opened as the URL would ask.
    render(<PartnerForm partner={partner} requestedTab="bid_group" onSave={onSave} onCancel={vi.fn()} />)
    await waitFor(() => expect(api.partnerBidConfigs.get).toHaveBeenCalledWith('cfg-1'))
    // Nothing unsaved: no save bar (#2138).
    expect(document.querySelector('[data-save-bar]')).toBeNull()

    fireEvent.click(await screen.findByRole('button', { name: 'Delete this matrix' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete matrix' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    // The cleared matrix is an unsaved change, named in the save bar.
    expect(await screen.findByText('1 unsaved change: Resolver settings')).toBeInTheDocument()
    expect(screen.getByLabelText('Bid matrix')).toHaveTextContent('No matrix')
    expect(screen.queryByText(/no longer available/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toEqual({ bid_resolver_config: { bid_config_id: null } })
  })
})
