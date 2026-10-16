import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/lib/api', () => ({
  api: {
    partnerUuids: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    partnerBidConfigs: { list: vi.fn() },
    buyerProfiles: { get: vi.fn(), save: vi.fn(), history: vi.fn(), usage: vi.fn() },
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
  vi.mocked(api.buyerProfiles.history).mockResolvedValue({ entries: [] })
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

  it('offers all three partner types on the type toggle', () => {
    render(<PartnerForm partner={bothPartner} onSave={vi.fn()} onCancel={vi.fn()} />)

    expect(screen.getByRole('radio', { name: 'Source' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Buyer' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Both' })).toBeInTheDocument()
  })

  it('shows the buyer-only sections for a both partner', () => {
    render(<PartnerForm partner={bothPartner} onSave={vi.fn()} onCancel={vi.fn()} />)

    expect(screen.getByText('Bid resolution')).toBeInTheDocument()
    expect(screen.getByText('Bidding limits')).toBeInTheDocument()
    expect(screen.getByText('Circuit breaker')).toBeInTheDocument()
  })

  it('shows the source-only sections for a both partner', () => {
    render(<PartnerForm partner={bothPartner} onSave={vi.fn()} onCancel={vi.fn()} />)

    expect(screen.getByText('Sell-off offer copy')).toBeInTheDocument()
    expect(screen.getByText('Sub-account UUIDs')).toBeInTheDocument()
  })

  it('still hides the buyer sections for a source-only partner', () => {
    // The positive case above passes just as well if the gates were removed
    // outright, so the exclusion has to be asserted in the same fixture.
    render(<PartnerForm partner={{ ...partner, partner_type: 'source' }} onSave={vi.fn()} onCancel={vi.fn()} />)

    expect(screen.queryByText('Bid resolution')).not.toBeInTheDocument()
    expect(screen.getByText('Sell-off offer copy')).toBeInTheDocument()
  })

  it('still hides the source sections for a buyer-only partner', () => {
    render(<PartnerForm partner={{ ...partner, partner_type: 'buyer' }} onSave={vi.fn()} onCancel={vi.fn()} />)

    expect(screen.queryByText('Sell-off offer copy')).not.toBeInTheDocument()
    expect(screen.getByText('Bid resolution')).toBeInTheDocument()
  })

  it('saves the type the person picked, so switching to both persists', async () => {
    const onSave = vi.fn()
    render(<PartnerForm partner={{ ...partner, partner_type: 'buyer' }} onSave={onSave} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByRole('radio', { name: 'Both' }))

    await waitFor(() => expect(screen.getByText('Sell-off offer copy')).toBeInTheDocument())
    expect(screen.getByText('Bid resolution')).toBeInTheDocument()
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
    render(<PartnerForm partner={{ ...partner, credential_warning: null }} onSave={vi.fn()} onCancel={vi.fn()} />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('does not present the warning as a save error', async () => {
    // The two are different: an error means the save did not happen, and this
    // save did. Sharing the error banner would say the opposite of what occurred.
    render(
      <PartnerForm
        partner={{ ...partner, credential_warning: "Credential 'SOFI_SECRET' is not set. Set it before activating this partner." }}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    const warning = await screen.findByRole('status')
    expect(warning).toHaveTextContent('SOFI_SECRET')
    expect(warning.className).not.toContain('red')
  })
})
