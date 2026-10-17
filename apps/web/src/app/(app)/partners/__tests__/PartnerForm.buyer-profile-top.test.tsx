/**
 * The Buyer profile tab from Enabled to Caps as the settled design draws it
 * (#2324, PM-21, docs/design/partners-page.html frames 1, 19 and 20).
 *
 *   - Enabled on its own row ("Offered leads"), then Sold on as Offer or Click
 *     with one sentence for the one chosen.
 *   - Priority (an offer buyer) its own section: the rule in one line, then
 *     where the buyer stands today among the other offer buyers.
 *   - Eligibility: state chips, money boxes reading None when empty with "$"
 *     beside the box, and one shared hint.
 *   - Hours: the same hours every day, with the time zone reading Eastern time.
 *   - A buyer with no saved profile says it is not offered leads through buyer
 *     selection, with Set up a buyer profile.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BuyerProfileDocument } from '@bidspoke/buyer-profile'

vi.mock('@/lib/api', () => ({
  api: {
    partners: { usage: () => Promise.resolve({ bid_group: [], partner_bid: [], latency_gate: [] }), workflowValues: () => Promise.resolve({ partner: { id: 'p', slug: 'p' }, values: [], searched: { workflows: 0, with_constants_node: 0 } }) },
    partnerUuids: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    partnerBidConfigs: { list: vi.fn() },
    buyerProfiles: { get: vi.fn(), usage: vi.fn() },
    buyerSales: { list: vi.fn(), settle: vi.fn() },
    heldClicks: { list: vi.fn() },
  },
}))

import PartnerForm from '../PartnerForm'
import { api } from '@/lib/api'
import type { OfferBuyer, Partner, PartnerBody, PartnerPageSaveRequest } from '@/lib/api'

const partner: Partner = {
  id: 'p1', organization_id: 'org-1', name: 'Tripoint', slug: 'tripoint',
  api_endpoint: null, cf_secret_key: null, daily_cap: null, min_bid: null, bid_formula: null,
  bid_resolver_type: 'api', bid_resolver_config: {}, outbound_field_mapping: null, bid_comparison_source: 'auto',
  extra_extraction: null, last_probe_response: null, dedup_endpoint: null, response_classification: null,
  accept_signals: [{ field: 'ok', equals: true }],
  alert_config: null, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 300, circuit_enabled: true,
  confirmation_window_ms: null, is_active: true, priority: 0, sell_off_offer_title: null, sell_off_offer_details: null, click_url: 'https://trypennie.com/portal/tpl/{prospect_id}',
  external_routing_code: 2, duplicate_signals: [],
  sub_account_min_bids: null, partner_type: 'buyer', created_at: '', updated_at: '2026-10-13T15:00:00.000Z', updated_by_email: null, updated_by_name: null,
}

const offerDoc: BuyerProfileDocument = {
  partner_id: 'p1', version: 3, sold_on: 'offer', is_enabled: true, priority: 1, allowed_states: ['TX', 'FL'],
  debt_min: null, debt_max: null, loan_amount_min: 2000,
  hourly_lead_cap: null, daily_lead_cap: 500, hourly_spend_cap_cents: null, daily_spend_cap_cents: null,
  windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, opens_minute: 0, closes_minute: 1440 })),
  blackout_dates: [],
  tiers: [{ population: 'engine', debt_from: 15000, debt_to: null, multiplier: 0.0012 }],
}
const clickDoc: BuyerProfileDocument = { ...offerDoc, sold_on: 'click', priority: null, tiers: [], daily_lead_cap: 50, debt_min: 20000 }

function loads(profile: BuyerProfileDocument | null, offerBuyers?: OfferBuyer[]) {
  vi.mocked(api.buyerProfiles.get).mockResolvedValue({ profile, accept_signals: [], other_sellers: [], ...(offerBuyers ? { offer_buyers: offerBuyers } : {}) })
}

function pageSaver() {
  return vi.fn(async (body: PartnerBody, _id?: string, _pending?: string[], request?: PartnerPageSaveRequest) => ({
    partner: { ...partner, ...body, version: 1 } as Partner,
    profile: request?.profile ? { ...request.profile, partner_id: 'p1', version: 4 } : null,
    copyWarning: null,
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.partnerUuids.list).mockResolvedValue([])
  vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([])
  vi.mocked(api.buyerProfiles.usage).mockRejectedValue(new Error('not read here'))
  vi.mocked(api.buyerSales.list).mockResolvedValue({ entries: [], total: 0, page: 1, limit: 100 })
  vi.mocked(api.heldClicks.list).mockResolvedValue({ entries: [], total: 0 })
})

async function renderOn(profile: BuyerProfileDocument | null, offerBuyers?: OfferBuyer[], onSave = pageSaver()) {
  loads(profile, offerBuyers)
  render(<PartnerForm partner={partner} onSave={onSave} onCancel={vi.fn()} />)
  await waitFor(() => expect(api.buyerProfiles.get).toHaveBeenCalled())
  return onSave
}
const region = () => screen.getByRole('region', { name: 'Buyer profile' })
const headings = () => within(region()).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)

describe('the sections in the design\'s order', () => {
  it('a click buyer: Enabled, Sold on, Eligibility, Hours, Caps', async () => {
    await renderOn(clickDoc)
    await screen.findByRole('radiogroup', { name: 'Sold on' })
    expect(headings().slice(0, 5)).toEqual(['Enabled', 'Sold on', 'Eligibility', 'Hours', 'Caps'])
  })

  it('an offer buyer: Enabled, Sold on, Priority, Eligibility, Hours, Pricing, Caps', async () => {
    await renderOn(offerDoc, [])
    await screen.findByRole('radiogroup', { name: 'Sold on' })
    expect(headings().slice(0, 7)).toEqual(['Enabled', 'Sold on', 'Priority', 'Eligibility', 'Hours', 'Pricing', 'Caps'])
  })
})

describe('Enabled and Sold on', () => {
  it('Enabled is a switch reading Offered leads, and Sold on says one sentence, for the kind chosen', async () => {
    await renderOn(clickDoc)
    expect(await screen.findByRole('switch', { name: 'Offered leads' })).toHaveAttribute('aria-checked', 'true')
    expect(within(screen.getByRole('radiogroup', { name: 'Sold on' })).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Offer', 'Click'])
    expect(screen.getByText('Quoted at the Engine bid, and sent to the buyer only when the person clicks.')).toBeInTheDocument()
    expect(screen.queryByText(/Sold through buyer selection at a priced rate/)).toBeNull()
  })
})

describe('Priority, and where the buyer stands today', () => {
  it('says the rule in one line, then that the buyer is the only one on the offer', async () => {
    await renderOn(offerDoc, [])
    expect(await screen.findByText('When more than one buyer can take a lead, priority 1 is offered it first.')).toBeInTheDocument()
    expect(screen.getByText('Today Tripoint is the only buyer sold on the offer, so it is offered every lead it qualifies for.')).toBeInTheDocument()
    expect(screen.getByLabelText('Priority')).toHaveAttribute('aria-describedby', expect.stringContaining('bp-priority-standing'))
  })

  it('names the other buyers sold on the offer with their priority', async () => {
    await renderOn(offerDoc, [{ id: 'p2', name: 'Acme', priority: 2 }])
    expect(await screen.findByText('Today Acme (priority 2) is also sold on the offer.')).toBeInTheDocument()
  })

  it('says nothing about today when the Worker did not say', async () => {
    await renderOn(offerDoc)
    await screen.findByText('When more than one buyer can take a lead, priority 1 is offered it first.')
    expect(screen.queryByText(/^Today /)).toBeNull()
  })
})

describe('Eligibility', () => {
  it('states are chips, money reads grouped with "$" beside the box and None when empty, and one hint is shared', async () => {
    await renderOn(clickDoc)
    const eligibility = await screen.findByRole('region', { name: 'Eligibility' })
    expect(within(eligibility).getByRole('checkbox', { name: 'TX' })).toHaveClass('chip-on')
    expect(within(eligibility).getByText('2 of 51 states')).toBeInTheDocument()
    expect(screen.getByLabelText('Debt minimum')).toHaveValue('20,000')
    expect(screen.getByLabelText('Debt maximum')).toHaveValue('')
    expect(screen.getByLabelText('Debt maximum')).toHaveAttribute('placeholder', 'None')
    // "$" is fixed text beside the box, and describes it.
    const unit = document.getElementById(screen.getByLabelText('Debt minimum').getAttribute('aria-describedby')!.split(' ')[0])
    expect(unit).toHaveTextContent('$')
    expect(within(eligibility).queryByText(/Dollars/)).toBeNull()
    expect(within(eligibility).getAllByText(/Empty means/)).toHaveLength(1)
  })

  it('a typed amount with grouping is saved as the number', async () => {
    const onSave = await renderOn(clickDoc)
    fireEvent.change(await screen.findByLabelText('Debt maximum'), { target: { value: '55,000' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][3] as PartnerPageSaveRequest).profile).toMatchObject({ debt_max: 55000 })
  })

  it('text that is not an amount stays as typed with its reason, and is never saved', async () => {
    await renderOn(clickDoc)
    const box = await screen.findByLabelText('Debt maximum')
    fireEvent.change(box, { target: { value: '55k' } })
    expect(box).toHaveValue('55k')
    expect(box).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Type an amount of dollars, such as 20,000.')).toHaveAttribute('role', 'alert')
    expect(box).toHaveAttribute('aria-describedby', expect.stringContaining('bp-debt-max-typed-error'))
    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull()
  })
})

describe('Hours', () => {
  it('opens as the same hours every day, with the time zone reading Eastern time under them', async () => {
    await renderOn(offerDoc, [])
    const hours = await screen.findByRole('region', { name: 'Hours' })
    expect(within(hours).getAllByRole('checkbox').every((c) => c.getAttribute('aria-checked') === 'true')).toBe(true)
    expect(within(hours).getByRole('button', { name: 'Set different hours for each day' })).toBeInTheDocument()
    expect(within(hours).getByLabelText('Time zone')).toHaveTextContent('Eastern time')
  })
})

describe('Caps for a click buyer', () => {
  it('one hint naming the buyer and when the count resets', async () => {
    await renderOn(clickDoc)
    expect(await screen.findByText(/^Empty means Tripoint is not offered at all\. The count resets at .+ Eastern time\.$/)).toBeInTheDocument()
  })
})

describe('a buyer with no saved profile (design frame 20)', () => {
  it('says it is not offered leads through buyer selection, and Set up a buyer profile shows the form', async () => {
    await renderOn(null)
    expect(await screen.findByText('Tripoint is not offered leads through buyer selection.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'No buyer profile' })).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Sold on' })).toBeNull()
    expect(screen.queryByText(/of 51 states/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Set up a buyer profile' }))
    expect(screen.getByRole('radiogroup', { name: 'Sold on' })).toBeInTheDocument()
    expect(screen.queryByText('Tripoint is not offered leads through buyer selection.')).toBeNull()
  })

  it('Set up a buyer profile on the Partner tab opens the form, not the note asking again', async () => {
    loads(null)
    render(<PartnerForm partner={partner} requestedTab="partner" onSave={pageSaver()} onCancel={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Set up a buyer profile' }))
    expect(screen.getByRole('tab', { name: 'Buyer profile' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByRole('radiogroup', { name: 'Sold on' })).toBeInTheDocument()
  })
})
