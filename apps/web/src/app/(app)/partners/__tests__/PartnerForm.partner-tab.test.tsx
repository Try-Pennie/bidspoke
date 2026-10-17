/**
 * The Partner tab as the settled design draws it (#2323, PM-20, frame 6): Name
 * with no hint, Does as two boxes, Active with what off means, and Sold through
 * as flat rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
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
import type { Partner } from '@/lib/api'

const partner: Partner = {
  id: 'p1', organization_id: 'org-1', name: 'Acme', slug: 'acme', api_endpoint: null, cf_secret_key: null, daily_cap: null, min_bid: null,
  bid_formula: null, bid_resolver_type: 'api', bid_resolver_config: {}, outbound_field_mapping: null,
  bid_comparison_source: 'auto', extra_extraction: null, last_probe_response: null, dedup_endpoint: null, response_classification: null,
  alert_config: null, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 300, circuit_enabled: true,
  confirmation_window_ms: null, is_active: true, priority: 0, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null,
  sub_account_min_bids: null, partner_type: 'buyer', created_at: '', updated_at: '2026-10-13T18:05:00Z', updated_by_email: null, updated_by_name: 'Editor A',
  version: 3,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.partners.usage).mockResolvedValue({ bid_group: [], partner_bid: [], latency_gate: [] })
  vi.mocked(api.partners.history).mockResolvedValue({ partnerId: 'p1', entries: [], complete: true, completeSince: null })
  vi.mocked(api.partnerUuids.list).mockResolvedValue([])
  vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([])
  vi.mocked(api.buyerProfiles.get).mockResolvedValue({ profile: null, accept_signals: [], other_sellers: [] })
  vi.mocked(api.buyerProfiles.usage).mockRejectedValue(new Error('not read here'))
  vi.mocked(api.buyerSales.list).mockResolvedValue({ entries: [], total: 0, page: 1, limit: 100 })
})

const panel = () => document.querySelector('[role="tabpanel"][id$="-content-partner"]') as HTMLElement

describe('the Partner tab (#2323)', () => {
  it('a buyer has Name, Does, Active and Sold through, and no Type strip or Status label', async () => {
    render(<PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Partner' }))
    expect(within(panel()).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Name', 'Does', 'Active', 'Sold through'])
    expect(within(panel()).queryByRole('radiogroup')).toBeNull()
    expect(screen.queryByText('Display name shown in the UI.')).toBeNull()
    expect(screen.queryByText('Status')).toBeNull()
  })

  it('a source has Name, Does and Active only', async () => {
    render(<PartnerForm partner={{ ...partner, partner_type: 'source' }} onSave={vi.fn()} onCancel={vi.fn()} />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Partner' }))
    expect(within(panel()).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Name', 'Does', 'Active'])
  })

  it('Does is two boxes; the last one ticked cannot be unticked, so the boxes always say what is stored', async () => {
    render(<PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Partner' }))
    const buys = within(panel()).getByRole('checkbox', { name: 'Buys leads' })
    const sends = within(panel()).getByRole('checkbox', { name: 'Sends us leads' })
    expect(buys).toBeChecked()
    expect(buys).toBeDisabled()
    expect(sends).not.toBeChecked()
    fireEvent.click(sends)
    expect(sends).toBeChecked()
    expect(buys).toBeEnabled()
  })

  it('ticking both saves a partner that does both', async () => {
    const onSave = vi.fn().mockResolvedValue({ partner: { ...partner, partner_type: 'both', version: 4 }, profile: null, copyWarning: null })
    render(<PartnerForm partner={partner} onSave={onSave} onCancel={vi.fn()} />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Partner' }))
    fireEvent.click(within(panel()).getByRole('checkbox', { name: 'Sends us leads' }))
    fireEvent.submit(document.querySelector('form')!)
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toEqual({ partner_type: 'both' })
  })

  it('Active says On or Off, and what off means', async () => {
    render(<PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Partner' }))
    const active = within(panel()).getByRole('switch', { name: 'Active' })
    expect(within(panel()).getByText('On')).toBeInTheDocument()
    expect(active).toHaveAccessibleDescription('Off: Bidspoke offers Acme no leads through any step, and workflows see it as inactive.')
    fireEvent.click(active)
    expect(within(panel()).getByText('Off')).toBeInTheDocument()
  })

  it('Sold through is flat rows, each label with Set up or its button beside it', async () => {
    render(<PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Partner' }))
    const rows = [...within(panel()).getByRole('region', { name: 'Sold through' }).querySelectorAll('[data-sold-row]')]
    expect(rows.map((r) => r.firstElementChild?.textContent)).toEqual(['Buyer profile', 'Bid Group'])
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: 'Set up for Bid Group' })).toBeInTheDocument()
    expect((rows[0] as HTMLElement).parentElement).not.toHaveClass('border')
  })
})
