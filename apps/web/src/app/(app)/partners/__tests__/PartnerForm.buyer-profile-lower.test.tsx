/**
 * The Buyer profile tab from Click delivery to Blackout dates, with Pricing,
 * an offer buyer's caps and Unresolved sales, as the settled design draws them
 * (#2325, PM-22, docs/design/partners-page.html frames 1, 13 and 19).
 *
 *   - Section order: a click buyer is Enabled, Sold on, Eligibility, Hours,
 *     Caps, Click delivery, Sale, Held clicks, Blackout dates; an offer buyer
 *     is Enabled, Sold on, Priority, Eligibility, Hours, Pricing, Caps, Sale,
 *     Unresolved sales, Outcome rules, Blackout dates.
 *   - Sale is its own section holding the Salesforce routing code, with no
 *     example naming another buyer's code.
 *   - Outcome rules are an offer buyer's: three sets as rows, the column names
 *     said once per set, "Accept when every one of", and a grey empty note.
 *   - Click delivery routes are flat: a name and an address, the states as
 *     chips, the catch all route saying only "Every state no other route lists."
 *   - Pricing is one "Engine leads" table with a short hint and one line naming
 *     the populations not priced here yet.
 *   - An offer buyer's caps are a table: Leads and Spend by Per hour and Per
 *     day, an empty box reading No cap.
 *   - Unresolved sales are cards with a lead sentence, each button followed by
 *     what it does.
 *   - Blackout dates are a list, one row per day off with its weekday.
 *   - Discard after Set up a buyer profile goes back to the no profile note.
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
import type { Partner, PartnerBody, PartnerPageSaveRequest } from '@/lib/api'

const LC = 'https://services.leadconnectorhq.com/hooks/abc/webhook-trigger'

const tripoint: Partner = {
  id: 'p1', organization_id: 'org-1', name: 'Tripoint', slug: 'tripoint',
  api_endpoint: null, cf_secret_key: null, daily_cap: null, min_bid: null, bid_formula: null,
  bid_resolver_type: 'api', bid_resolver_config: {}, outbound_field_mapping: null, bid_comparison_source: 'auto',
  extra_extraction: null, last_probe_response: null, dedup_endpoint: null,
  response_classification: { rejection_signals: [{ field: 'data.createLead.resultCode', not_in: [1000, 1001] }] },
  accept_signals: [{ field: 'ok', equals: true }],
  alert_config: null, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 300, circuit_enabled: true,
  confirmation_window_ms: null, is_active: true, priority: 0, sell_off_offer_title: null, sell_off_offer_details: null, click_url: 'https://trypennie.com/portal/tpl/{prospect_id}',
  external_routing_code: 2, duplicate_signals: [],
  sub_account_min_bids: null, partner_type: 'buyer', created_at: '', updated_at: '2026-10-13T15:00:00.000Z', updated_by_email: null, updated_by_name: null,
}
const liberty1: Partner = { ...tripoint, id: 'p2', name: 'Liberty1', slug: 'liberty1', response_classification: null, accept_signals: [], external_routing_code: 4, click_url: 'https://trypennie.com/portal/l1/{prospect_id}' }

const offerDoc: BuyerProfileDocument = {
  partner_id: 'p1', version: 3, sold_on: 'offer', is_enabled: true, priority: 1, allowed_states: ['TX'],
  debt_min: null, debt_max: null, loan_amount_min: 2000,
  hourly_lead_cap: null, daily_lead_cap: null, hourly_spend_cap_cents: null, daily_spend_cap_cents: null,
  windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, opens_minute: 0, closes_minute: 1440 })),
  blackout_dates: [{ date: '2026-12-25', note: null }, { date: '2026-11-26', note: null }],
  tiers: [
    { population: 'engine', debt_from: 10000, debt_to: 12500, multiplier: 0.0009 },
    { population: 'engine', debt_from: 12500, debt_to: null, multiplier: 0.0013 },
  ],
}
const clickDoc: BuyerProfileDocument = {
  ...offerDoc, partner_id: 'p2', sold_on: 'click', priority: null, tiers: [], daily_lead_cap: 50,
  click_delivery: {
    routes: [
      { name: 'DV1', url: `${LC}/dv1`, states: ['OR', 'WA'] },
      { name: 'DI4', url: `${LC}/di4`, states: [] },
    ],
    success_pattern: '"id"\\s*:\\s*"(?<id>[A-Za-z0-9]{15,20})"',
  },
}

const unresolvedSale = { id: 'sale-1', lead_key: 'a0B5f00000RzK4mEAF', kind: 'live', payout_cents: 1625, reserved_at: '2026-10-14T19:12:00.000Z', http_status: 200, result_code: null }

function pageSaver(base: Partner) {
  return vi.fn(async (body: PartnerBody, _id?: string, _pending?: string[], request?: PartnerPageSaveRequest) => ({
    partner: { ...base, ...body, version: 1 } as Partner,
    profile: request?.profile ? { ...request.profile, partner_id: base.id, version: 4 } : null,
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

async function renderOn(partner: Partner, profile: BuyerProfileDocument | null) {
  vi.mocked(api.buyerProfiles.get).mockResolvedValue({ profile, accept_signals: (partner.accept_signals ?? []) as never, other_sellers: [], offer_buyers: [] })
  const onSave = pageSaver(partner)
  render(<PartnerForm partner={partner} onSave={onSave} onCancel={vi.fn()} />)
  await waitFor(() => expect(api.buyerProfiles.get).toHaveBeenCalled())
  if (profile) await screen.findByRole('radiogroup', { name: 'Sold on' })
  return onSave
}
const profileRegion = () => screen.getByRole('region', { name: 'Buyer profile' })
const headings = () => within(profileRegion()).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
const section = (name: string) => screen.getByRole('region', { name })

describe('the sections in the design\'s order', () => {
  it('a click buyer: ... Caps, Click delivery, Sale, Held clicks, Blackout dates', async () => {
    await renderOn(liberty1, clickDoc)
    expect(headings()).toEqual(['Enabled', 'Sold on', 'Eligibility', 'Hours', 'Caps', 'Click delivery', 'Sale', 'Held clicks', 'Blackout dates'])
  })

  it('an offer buyer: ... Pricing, Caps, Sale, Unresolved sales, Outcome rules, Blackout dates', async () => {
    await renderOn(tripoint, offerDoc)
    expect(headings()).toEqual(['Enabled', 'Sold on', 'Priority', 'Eligibility', 'Hours', 'Pricing', 'Caps', 'Sale', 'Unresolved sales', 'Outcome rules', 'Blackout dates'])
  })
})

describe('Sale', () => {
  it('holds the Salesforce routing code, with no example naming another buyer\'s code', async () => {
    await renderOn(liberty1, clickDoc)
    expect(within(section('Sale')).getByLabelText('Salesforce routing code')).toHaveValue(4)
    expect(screen.queryByText(/Tripoint is 2/)).toBeNull()
  })
})

describe('Outcome rules', () => {
  it('are not shown for a click buyer with no rules stored', async () => {
    await renderOn(liberty1, clickDoc)
    expect(screen.queryByRole('heading', { name: 'Outcome rules' })).toBeNull()
  })

  it('stay shown for a click buyer that holds a decline rule, so it can be seen and removed', async () => {
    await renderOn({ ...liberty1, response_classification: tripoint.response_classification }, clickDoc)
    expect(within(section('Outcome rules')).getByRole('group', { name: 'Decline when any of' })).toBeInTheDocument()
  })

  it('an offer buyer\'s three sets are rows, each naming Field, Operator and Value once, and an empty set is a grey sentence', async () => {
    await renderOn(tripoint, offerDoc)
    const outcome = section('Outcome rules')
    const accept = within(outcome).getByRole('group', { name: 'Accept when every one of' })
    const decline = within(outcome).getByRole('group', { name: 'Decline when any of' })
    const duplicate = within(outcome).getByRole('group', { name: 'Duplicate when any of' })
    // Said once over the rows of each set that has rows, never on every rule.
    expect(within(accept).getAllByText('Field')).toHaveLength(1)
    expect(within(decline).getAllByText('Operator')).toHaveLength(1)
    expect(within(duplicate).queryByText('Value')).toBeNull()
    expect(within(accept).getByRole('textbox', { name: 'Accept rule 1 field' })).toHaveValue('ok')
    expect(within(decline).getByRole('textbox', { name: 'Decline rule 1 field' })).toHaveValue('data.createLead.resultCode')
    const empty = within(duplicate).getByText('No rules. Every decline is recorded as Fail.')
    expect(empty).toHaveClass('text-hint')
    expect(empty.className).not.toMatch(/amber/)
  })
})

describe('Click delivery', () => {
  it('routes are flat, the catch all route says only "Every state no other route lists.", and nothing on it is red', async () => {
    await renderOn(liberty1, clickDoc)
    const delivery = section('Click delivery')
    const routes = within(delivery).getAllByRole('listitem')
    expect(routes).toHaveLength(2)
    for (const r of routes) expect(r.className).not.toMatch(/border /)
    // The route with states shows them as chips.
    expect(within(routes[0]).getByRole('checkbox', { name: 'OR' })).toHaveClass('chip-on')
    // The catch all route draws no chips, only the sentence.
    expect(within(routes[1]).queryByRole('checkbox')).toBeNull()
    expect(within(routes[1]).getByText('Every state no other route lists.')).toBeInTheDocument()
    // Name and Address are not labels on screen: the boxes say what they hold.
    expect(within(delivery).queryByText('Name')).toBeNull()
    expect(within(delivery).queryByText('Address')).toBeNull()
    expect(within(delivery).getByLabelText('Route 1 name')).toHaveValue('DV1')
    // The remove marks are the grey minus, and removing all delivery is not a red button.
    expect(within(delivery).getByRole('button', { name: 'Remove route DV1' }).className).not.toMatch(/btn-danger/)
    expect(within(delivery).getByRole('button', { name: 'Remove click delivery' }).className).not.toMatch(/btn-danger/)
  })

  it('the catch all route can be given states, which shows its chips', async () => {
    await renderOn(liberty1, clickDoc)
    const routes = within(section('Click delivery')).getAllByRole('listitem')
    fireEvent.click(within(routes[1]).getByRole('button', { name: 'Choose states for DI4' }))
    expect(within(routes[1]).getByRole('group', { name: 'States for DI4' })).toBeInTheDocument()
  })
})

describe('Pricing', () => {
  it('one Engine leads table, a short hint, and one line naming the populations not priced here yet', async () => {
    await renderOn(tripoint, offerDoc)
    const pricing = section('Pricing')
    expect(within(pricing).getByText('Engine leads')).toBeInTheDocument()
    expect(within(pricing).getAllByRole('table')).toHaveLength(1)
    expect(within(pricing).getByText('A lead pays its debt times the multiplier. Debt to is not included, so the next tier starts there.')).toBeInTheDocument()
    expect(within(pricing).getByText('Main Flow and Lead Economy are not priced here yet: no workflow sells those leads through buyer selection.')).toBeInTheDocument()
    expect(within(pricing).queryByText(/18,250/)).toBeNull()
    // Dollars read grouped with "$" beside the box; an open top tier reads No upper bound.
    expect(within(pricing).getByRole('textbox', { name: 'Debt from, tier 10,000 to 12,500' })).toHaveValue('10,000')
    expect(within(pricing).getByRole('textbox', { name: 'Debt to, tier 12,500 to no upper bound' })).toHaveAttribute('placeholder', 'No upper bound')
  })
})

describe('an offer buyer\'s caps', () => {
  it('a table of Leads and Spend by Per hour and Per day, each empty box reading No cap', async () => {
    await renderOn(tripoint, offerDoc)
    const caps = section('Caps')
    const table = within(caps).getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Per hour', 'Per day'])
    expect(within(table).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Leads', 'Spend'])
    for (const name of ['Leads per hour', 'Leads per day', 'Spend per hour', 'Spend per day']) {
      expect(within(caps).getByLabelText(name)).toHaveAttribute('placeholder', 'No cap')
    }
    expect(within(caps).getByText('An empty box is no cap. Counts Engine leads sold through buyer selection. Hours and days are Eastern.')).toBeInTheDocument()
  })

  it('a typed spend cap is saved in cents', async () => {
    const onSave = await renderOn(tripoint, offerDoc)
    fireEvent.change(screen.getByLabelText('Spend per day'), { target: { value: '800' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][3] as PartnerPageSaveRequest).profile).toMatchObject({ daily_spend_cap_cents: 80000 })
  })
})

describe('Unresolved sales', () => {
  it('a lead sentence, then a card per sale with each button followed by what it does', async () => {
    vi.mocked(api.buyerSales.list).mockResolvedValue({ entries: [unresolvedSale], total: 1, page: 1, limit: 100 })
    await renderOn(tripoint, offerDoc)
    const unresolved = section('Unresolved sales')
    expect(await within(unresolved).findByText('1 sale has no outcome. Its slot stays reserved until a person settles it.')).toBeInTheDocument()
    expect(within(unresolved).queryByRole('table')).toBeNull()
    expect(within(unresolved).getByText('Tripoint answered HTTP 200, no rule matched.')).toBeInTheDocument()
    expect(within(unresolved).getByText('Tripoint has it. Counts as sold for $16.25 today.')).toBeInTheDocument()
    expect(within(unresolved).getByText('Tripoint does not have it. Frees one slot and counts nothing.')).toBeInTheDocument()
    expect(within(unresolved).getByRole('button', { name: 'Free the slot' }).className).toMatch(/btn-danger/)
  })
})

describe('Blackout dates', () => {
  it('a list, one row per day off with its weekday, sorted, and no table', async () => {
    await renderOn(tripoint, offerDoc)
    const blackout = section('Blackout dates')
    expect(within(blackout).queryByRole('table')).toBeNull()
    expect(within(blackout).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Thursday, Nov 26, 2026', 'Friday, Dec 25, 2026'])
    expect(within(blackout).getByRole('button', { name: 'Remove Thursday, Nov 26, 2026' })).toBeInTheDocument()
    expect(within(blackout).getByText('Whole days, Eastern.')).toBeInTheDocument()
  })
})

describe('Discard after Set up a buyer profile (#2325)', () => {
  it('goes back to the no profile note, not an empty profile form', async () => {
    await renderOn(tripoint, null)
    await userEvent.click(await screen.findByRole('button', { name: 'Set up a buyer profile' }))
    await userEvent.click(screen.getByRole('switch', { name: 'Offered leads' }))
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(screen.getByText('Tripoint is not offered leads through buyer selection.')).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Sold on' })).toBeNull()
  })
})
