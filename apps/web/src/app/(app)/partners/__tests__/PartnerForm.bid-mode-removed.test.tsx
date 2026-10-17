/**
 * Bid mode is off the partners page (PM-9, #2136, part of #2114).
 *
 * The Commit and Ping only control is gone and no save the page makes carries
 * bid_mode, for an existing partner or a new one. Since #2182 bid_mode is not a
 * Partner field, its column is dropped, and the Worker and save_partner_config
 * both refuse a save that names it.
 *
 * The section the control sat in is asserted present first (its Sample
 * response panel), so the control's absence is not read off a section that
 * never rendered (L564).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/lib/api', () => ({
  api: {
    partners: { usage: () => Promise.resolve({ bid_group: [], partner_bid: [], latency_gate: [] }), workflowValues: () => Promise.resolve({ partner: { id: 'p', slug: 'p' }, values: [], searched: { workflows: 0, with_constants_node: 0 } }) },
    partnerUuids: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    partnerBidConfigs: { list: vi.fn() },
    buyerProfiles: { get: vi.fn(), save: vi.fn(), usage: vi.fn() },
    buyerSales: { list: vi.fn(), settle: vi.fn() },
  },
}))

import PartnerForm from '../PartnerForm'
import { api } from '@/lib/api'
import type { Partner } from '@/lib/api'

// A buyer on the Partner API resolver: the only partner the control was ever
// shown for.
const partner = {
  id: 'p1', organization_id: 'org-1', name: 'M1', slug: 'm1', api_endpoint: 'https://m1.example/ping', cf_secret_key: null, daily_cap: null, min_bid: null,
  bid_formula: null, bid_resolver_type: 'api', bid_resolver_config: {}, outbound_field_mapping: null,
  bid_comparison_source: 'auto', extra_extraction: null, last_probe_response: null, dedup_endpoint: null, response_classification: null,
  alert_config: null, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 300, circuit_enabled: true,
  confirmation_window_ms: null, is_active: true, priority: 0, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null,
  sub_account_min_bids: null, partner_type: 'buyer', created_at: '', updated_at: '2026-10-15T14:00:00Z', updated_by_email: null, updated_by_name: null,
  version: 3,
} as Partner

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.partnerUuids.list).mockResolvedValue([])
  vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([])
  vi.mocked(api.buyerProfiles.get).mockResolvedValue({ profile: null, accept_signals: [], other_sellers: [] })
  vi.mocked(api.buyerProfiles.usage).mockRejectedValue(Object.assign(new Error('usage_unavailable'), { status: 503 }))
  vi.mocked(api.buyerSales.list).mockResolvedValue({ entries: [], total: 0, page: 1, limit: 100 })
})

const save = () => fireEvent.click(document.querySelector('button[type="submit"]')!)

function expectNoBidModeControl() {
  // The section the control lived in still renders, so its absence is measured.
  expect(screen.getByText('Sample answer')).toBeInTheDocument()
  expect(screen.queryByText('Bid mode')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Ping only' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Commit' })).not.toBeInTheDocument()
}

describe('bid mode is off the partners page (PM-9, #2136)', () => {
  it('shows no Commit or Ping only control on an API buyer stored as ping_only', () => {
    render(<PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} />)
    expectNoBidModeControl()
  })

  it('a save of an edited existing partner carries no bid_mode', async () => {
    const onSave = vi.fn().mockResolvedValue({ partner: { ...partner, name: 'M1 renamed', version: 4 }, copyWarning: null })
    render(<PartnerForm partner={partner} onSave={onSave} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByDisplayValue('M1'), { target: { value: 'M1 renamed' } })
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toEqual({ name: 'M1 renamed' })
    expect('bid_mode' in onSave.mock.calls[0][0]).toBe(false)
  })

  it('a new partner\'s create body carries no bid_mode, so the Worker stores its default', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<PartnerForm onSave={onSave} onCancel={vi.fn()} />)
    // The new partner page asks only the name, slug and what it does (#2321), so
    // no bidding setting is on it at all; what matters is the body it sends.
    expect(screen.queryByText('Bid mode')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Acme' } })
    fireEvent.submit(document.querySelector('form')!)
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const body = onSave.mock.calls[0][0] as Record<string, unknown>
    expect(body.name).toBe('Acme')
    expect('bid_mode' in body).toBe(false)
  })
})
