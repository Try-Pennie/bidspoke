import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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
import type { Partner, PartnerUuid } from '@/lib/api'

const partner: Partner = {
  id: 'p1',
  organization_id: 'org-1',
  name: 'M1',
  slug: 'm1',
  api_endpoint: null,
  cf_secret_key: null,
  daily_cap: null,
  min_bid: null,
  bid_formula: null,
  bid_resolver_type: 'api',
  bid_resolver_config: {},
  outbound_field_mapping: null,
  bid_comparison_source: 'auto',
  extra_extraction: null,
  last_probe_response: null,
  dedup_endpoint: null,
  response_classification: null,
  alert_config: null,
  circuit_error_threshold: 5,
  circuit_window_seconds: 60,
  circuit_cooldown_seconds: 300,
  circuit_enabled: true,
  confirmation_window_ms: null,
  is_active: true,
  priority: 0,
  sell_off_offer_title: null,
  sell_off_offer_details: null,
  click_url: null,
  sub_account_min_bids: null,
  partner_type: 'source',
  created_at: '',
  updated_at: '',
  updated_by_email: null,
  updated_by_name: null,
}

const uuid: PartnerUuid = { id: 'uuid-1', partner_slug: 'm1', uuid: '11111111-1111-1111-1111-111111111111', created_at: '' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.partnerUuids.list).mockResolvedValue([uuid])
  vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([])
  // A buyer partner's form reads its profile; these fixtures have none saved yet.
  vi.mocked(api.buyerProfiles.get).mockResolvedValue({ profile: null, accept_signals: [], other_sellers: [] })
  vi.mocked(api.buyerProfiles.usage).mockRejectedValue(Object.assign(new Error('usage_unavailable'), { status: 503 }))
  vi.mocked(api.buyerSales.list).mockResolvedValue({ entries: [], total: 0, page: 1, limit: 100 })
})

describe('PartnerForm — sub-account UUID removal surfaces errors (#514)', () => {
  it('shows an error and keeps the row when the delete call fails, instead of failing silently', async () => {
    vi.mocked(api.partnerUuids.delete).mockRejectedValue(new Error('Failed to remove UUID'))
    render(
      <PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} />
    )

    fireEvent.click(await screen.findByLabelText('Remove UUID'))

    expect(await screen.findByText('Failed to remove UUID')).toBeInTheDocument()
    expect(screen.getByText(uuid.uuid)).toBeInTheDocument()
  })

  it('removes the row and shows no error when the delete call succeeds', async () => {
    vi.mocked(api.partnerUuids.delete).mockResolvedValue({ ok: true })
    render(
      <PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} />
    )

    fireEvent.click(await screen.findByLabelText('Remove UUID'))

    await waitFor(() => expect(screen.queryByText(uuid.uuid)).not.toBeInTheDocument())
  })
})

// #306 / ADR 0001. A `both` partner is one company playing two parts (Engine
// sends us free leads inbound and bids as the fallback buyer outbound), so its
// form must expose BOTH config surfaces. Every section was gated on an exact
// `partner_type === 'buyer'` / `=== 'source'` comparison, which excludes a third
// value silently: the sections simply do not render, and the form reads as a
// partner with nothing to configure rather than as an unhandled value.
describe('PartnerForm: a both partner exposes buyer and source config (#306)', () => {
  const bothPartner: Partner = { ...partner, partner_type: 'both' }

  it('offers all three partner types on the type toggle, on the Partner tab', async () => {
    render(<PartnerForm partner={bothPartner} onSave={vi.fn()} onCancel={vi.fn()} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Partner' }))

    expect(screen.getByRole('radio', { name: 'Source' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Buyer' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Both' })).toBeInTheDocument()
  })

  // #2137: a buyer's bidding settings are on the Bid Group tab, which shows
  // when it applies, or after Set up for Bid Group, offered to every buyer.
  it('gives a both partner the buyer tabs, and its bidding settings one press away', async () => {
    render(<PartnerForm partner={bothPartner} onSave={vi.fn()} onCancel={vi.fn()} />)
    await screen.findByRole('tab', { name: 'Buyer profile' })
    await userEvent.click(screen.getByRole('tab', { name: 'Partner' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Set up for Bid Group' }))

    expect(screen.getByRole('tab', { name: 'Bid Group' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Bid resolution')).toBeVisible()
    expect(screen.getByText('Bidding limits')).toBeVisible()
    expect(screen.getByText('Circuit breaker')).toBeVisible()
  })

  it('shows the source-only sections for a both partner, on Workflow values', async () => {
    render(<PartnerForm partner={bothPartner} onSave={vi.fn()} onCancel={vi.fn()} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Workflow values' }))

    expect(screen.getByText('Sell-off offer')).toBeVisible()
    expect(screen.getByText('Sub-account IDs')).toBeVisible()
  })

  it('still hides the buyer tabs for a source-only partner', async () => {
    // The positive case above passes just as well if the gates were removed
    // outright, so the exclusion has to be asserted in the same fixture.
    render(<PartnerForm partner={{ ...partner, partner_type: 'source' }} onSave={vi.fn()} onCancel={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Partner', 'Workflow values', 'History']))
    expect(screen.queryByText('Bid resolution')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set up for Bid Group' })).not.toBeInTheDocument()
    expect(screen.getByText('Sell-off offer')).toBeVisible()
  })

  it('still hides the source sections for a buyer-only partner', async () => {
    render(<PartnerForm partner={{ ...partner, partner_type: 'buyer' }} onSave={vi.fn()} onCancel={vi.fn()} />)

    await screen.findByRole('tab', { name: 'Buyer profile' })
    expect(screen.queryByText('Sell-off offer')).not.toBeInTheDocument()
    expect(screen.queryByText('Sub-account IDs')).not.toBeInTheDocument()
  })

  it('switching a buyer to both brings the source sections and keeps the tab the person is on', async () => {
    render(<PartnerForm partner={{ ...partner, partner_type: 'buyer' }} onSave={vi.fn()} onCancel={vi.fn()} />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Partner' }))

    fireEvent.click(screen.getByRole('radio', { name: 'Both' }))

    await waitFor(() => expect(screen.getByText('Sell-off offer')).toBeInTheDocument())
    expect(screen.getByRole('tab', { name: 'Partner' })).toHaveAttribute('aria-selected', 'true')
  })
})

// #416. The API reports a declared-but-unprovisioned partner credential on every
// read and write. Rendering it here is what makes the check preventive: without
// it the field is written and never read, and the only place the fault surfaces
// is still a lost lead.
describe('PartnerForm: missing credential warning (#416)', () => {
  it('shows the warning the API reported', async () => {
    render(
      <PartnerForm
        partner={{ ...partner, credential_warning: "Credential 'SOFI_SECRET' is not set, so this partner will fail on the next live lead." }}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(await screen.findByText(/SOFI_SECRET/)).toBeInTheDocument()
  })

  it('shows nothing when the API reported no warning', async () => {
    const { container } = render(<PartnerForm partner={{ ...partner, credential_warning: null }} onSave={vi.fn()} onCancel={vi.fn()} />)

    await screen.findByRole('tab', { name: 'Workflow values' })
    expect(container.querySelector('[data-problem-mark]')).toBeNull()
    expect(screen.queryByRole('tab', { name: /Bid Group/ })).not.toBeInTheDocument()
  })

  // #2137 (settled design, "Missing credential"): red under the secret it is
  // about, a mark on the tab holding it, and the partner opens on that tab. It
  // is not the error banner, which says a save did not happen, and this one did.
  it('opens on the tab holding the secret, marks the tab, and says it under the secret field', async () => {
    const warning = "Credential 'SOFI_SECRET' is not set. Set it before activating this partner."
    render(<PartnerForm partner={{ ...partner, partner_type: 'buyer', cf_secret_key: 'SOFI_SECRET', credential_warning: warning }} onSave={vi.fn()} onCancel={vi.fn()} />)

    const tab = await screen.findByRole('tab', { name: 'Bid Group, has a problem' })
    expect(tab).toHaveAttribute('aria-selected', 'true')
    const secret = screen.getByLabelText('Auth secret name')
    expect(secret).toBeVisible()
    expect(secret).toHaveAccessibleDescription(warning)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
