/**
 * Every partner field's registry section is a heading on the tab the registry
 * names (#2137), so the merge dialog, a refused save's mark and the history
 * name a section the person can find. Read from the rendered form, not a list
 * kept beside it. Seen red with click_url's section left as 'Endpoints' after
 * the click URL moved to Workflow values.
 *
 * A field the registry marks offPage (List order, which left the page with the
 * alphabetical list) has no control on any tab, so it is not looked for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('@/lib/api', () => ({
  api: {
    partners: { usage: vi.fn() },
    partnerUuids: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    partnerBidConfigs: { list: vi.fn() },
    buyerProfiles: { get: vi.fn(), usage: vi.fn() },
    buyerSales: { list: vi.fn(), settle: vi.fn() },
  },
}))

import PartnerForm from '../PartnerForm'
import { api } from '@/lib/api'
import type { Partner } from '@/lib/api'
import type { BuyerProfileDocument } from '@bidspoke/buyer-profile'
import { PARTNER_FIELD_REGISTRY, PROFILE_PREFIX } from '../partner-draft'

// A partner that does both, with a Bid Group setting and a confirmation window
// set, so every tab and every partner section is drawn.
const partner: Partner = {
  id: 'p1', organization_id: 'org-1', name: 'Acme', slug: 'acme', api_endpoint: 'https://acme.example/bid', cf_secret_key: null, daily_cap: null, min_bid: 1,
  bid_formula: null, bid_resolver_type: 'api', bid_resolver_config: {}, outbound_field_mapping: null,
  bid_comparison_source: 'auto', extra_extraction: null, last_probe_response: null, dedup_endpoint: null, response_classification: null,
  alert_config: null, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 300, circuit_enabled: true,
  confirmation_window_ms: 5000, is_active: true, priority: 0, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null,
  sub_account_min_bids: null, partner_type: 'both', created_at: '', updated_at: '2026-10-13T18:05:00Z', updated_by_email: null, updated_by_name: null,
  version: 3,
}

// A saved profile, so the Buyer profile tab draws its sections: since #2324 a buyer
// with none shows only that it is not offered leads, until one is set up.
const profile: BuyerProfileDocument = {
  partner_id: 'p1', version: 1, sold_on: 'offer', is_enabled: false, priority: null, allowed_states: [],
  debt_min: null, debt_max: null, loan_amount_min: null,
  hourly_lead_cap: null, daily_lead_cap: null, hourly_spend_cap_cents: null, daily_spend_cap_cents: null,
  windows: [], blackout_dates: [], tiers: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.partners.usage).mockResolvedValue({ bid_group: [], partner_bid: [], latency_gate: [] })
  vi.mocked(api.partnerUuids.list).mockResolvedValue([])
  vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([])
  vi.mocked(api.buyerProfiles.get).mockResolvedValue({ profile, accept_signals: [], other_sellers: [] })
  vi.mocked(api.buyerProfiles.usage).mockRejectedValue(new Error('not read here'))
  vi.mocked(api.buyerSales.list).mockResolvedValue({ entries: [], total: 0, page: 1, limit: 100 })
})

describe('registry sections are headings on their tab (#2137)', () => {
  it('every partner field drawn on the page sits under a heading named as its registry section, on its registry tab', async () => {
    const { container } = render(<PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} />)
    await waitFor(() => expect(api.partners.usage).toHaveBeenCalled())
    await screen.findByRole('tab', { name: 'Bid Group' })
    await waitFor(() => expect(container.querySelector('[role="tabpanel"][id$="-content-buyer_profile"] h3')).not.toBeNull())
    const headings = (tab: string) => [...container.querySelectorAll(`[role="tabpanel"][id$="-content-${tab}"] h3, [role="tabpanel"][id$="-content-${tab}"] h4`)].map((h) => h.textContent?.trim())
    const drawn = PARTNER_FIELD_REGISTRY.filter((e) => !e.pattern.startsWith(PROFILE_PREFIX) && !e.offPage)
    expect(drawn.length).toBeGreaterThan(25)
    const missing = drawn.filter((e) => !headings(e.tab).includes(e.section)).map((e) => `${e.pattern}: '${e.section}' not a heading on ${e.tab}`)
    expect(missing).toEqual([])
  })
})
