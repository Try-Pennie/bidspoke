/**
 * The display time zone on the partner page (#2143, PM-10).
 *
 * A buyer profile chooses the zone its hours and reset times are shown in: a
 * picker of the four zones under Hours, unset showing Eastern. The hours stay
 * stored in Eastern, so choosing a zone redraws them and saves only the zone,
 * and the page sends the zone only when the person changed it (an absent key
 * keeps what is stored, so this save cannot put back a zone someone else set).
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { BuyerProfileDocument } from '@bidspoke/buyer-profile'
import { chooseOption, readSelect } from '@/components/ui/__tests__/_select'

vi.mock('@/lib/api', () => ({
  api: {
    partners: { usage: () => Promise.resolve({ bid_group: [], partner_bid: [], latency_gate: [] }) },
    partnerUuids: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    partnerBidConfigs: { list: vi.fn() },
    buyerProfiles: { get: vi.fn(), usage: vi.fn() },
    buyerSales: { list: vi.fn(), settle: vi.fn() },
    heldClicks: { list: vi.fn(), markSent: vi.fn(), free: vi.fn(), clear: vi.fn(), retrySalesforce: vi.fn() },
  },
}))

import PartnerForm from '../PartnerForm'
import { api } from '@/lib/api'
import type { Partner, PartnerBody, PartnerPageSaveRequest } from '@/lib/api'

const partner: Partner = {
  id: 'p1', organization_id: 'org-1', name: 'Tripoint', slug: 'tripoint',
  api_endpoint: 'https://tripoint.example/leads', cf_secret_key: null, daily_cap: 250, min_bid: null, bid_formula: null,
  bid_resolver_type: 'api', bid_resolver_config: {}, outbound_field_mapping: null, bid_comparison_source: 'auto',
  extra_extraction: null, last_probe_response: null, dedup_endpoint: null,
  response_classification: null, accept_signals: [{ field: 'ok', equals: true }],
  alert_config: null, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 300, circuit_enabled: true,
  confirmation_window_ms: null, is_active: true, priority: 2, sell_off_offer_title: null, sell_off_offer_details: null, click_url: 'https://trypennie.com/portal/tpl',
  external_routing_code: 2, duplicate_signals: [],
  sub_account_min_bids: null, partner_type: 'buyer', created_at: '', updated_at: '2027-09-20T15:00:00.000Z', updated_by_email: null, updated_by_name: null,
}

// Monday all day Eastern: in Pacific that is Sunday from 9:00 PM and Monday until 9:00 PM.
const doc: BuyerProfileDocument = {
  partner_id: 'p1', version: 3, sold_on: 'offer', is_enabled: true, priority: 1, allowed_states: ['TX'],
  debt_min: 15000, debt_max: null, loan_amount_min: null,
  hourly_lead_cap: null, daily_lead_cap: 500, hourly_spend_cap_cents: null, daily_spend_cap_cents: null,
  windows: [{ day_of_week: 1, opens_minute: 0, closes_minute: 1440 }],
  blackout_dates: [{ date: '2027-12-25', note: null }],
  tiers: [{ population: 'engine', debt_from: 15000, debt_to: null, multiplier: 0.0012 }],
  display_time_zone: null,
}

const usage = {
  sold_on: 'offer' as const,
  et_day: '2027-09-20', hour_bucket: 505_935, hour: { leads: 7, spend_cents: 15_330 },
  day: { leads: 42, spend_cents: 91_980, by_status: { reserved: 1, accepted: 40, declined: 5, released: 2, unresolved: 1 } },
  counted_populations: ['engine'], outside_wins_today: 3, unmeasured: [],
}

function pageSaver() {
  return vi.fn(async (body: PartnerBody, _id?: string, _pending?: string[], request?: PartnerPageSaveRequest) => ({
    partner: { ...partner, ...body, version: 1 } as Partner,
    profile: request?.profile ? { ...request.profile, partner_id: 'p1', version: 4 } : null,
    copyWarning: null,
  }))
}

const profileSent = (onSave: Mock) => onSave.mock.calls.map((c) => (c[3] as PartnerPageSaveRequest | undefined)?.profile ?? null)

function loads(profile: BuyerProfileDocument) {
  vi.mocked(api.buyerProfiles.get).mockResolvedValue({ profile, accept_signals: [{ field: 'ok', equals: true }], other_sellers: [] })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.partnerUuids.list).mockResolvedValue([])
  vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([])
  loads(doc)
  vi.mocked(api.buyerProfiles.usage).mockResolvedValue(usage)
  vi.mocked(api.buyerSales.list).mockResolvedValue({ entries: [], total: 0, page: 1, limit: 100 })
  vi.mocked(api.heldClicks.list).mockResolvedValue({ entries: [], total: 0 })
})

async function renderBuyer(onSave: Mock = pageSaver()) {
  render(<PartnerForm partner={partner} onSave={onSave} onCancel={vi.fn()} />)
  await waitFor(() => expect(screen.getByLabelText('Leads per day')).toHaveValue(500))
  return onSave
}

const hours = (day: string) => within(screen.getByRole('group', { name: day })).queryAllByRole('textbox').map((b) => (b as HTMLInputElement).value)

describe('the Time zone picker under Hours', () => {
  it('offers the four zones by name, an unset profile showing Eastern', async () => {
    await renderBuyer()
    const reading = readSelect(screen.getByLabelText('Time zone'))
    // #2324: each zone reads as the design words it, "Eastern time".
    expect(reading.options).toEqual(['Eastern time', 'Central time', 'Mountain time', 'Pacific time'])
    expect(reading.shown).toBe('Eastern time')
    // In Eastern, Monday all day is the same hours every day: one chip and one range (#2324).
    expect(screen.getByRole('checkbox', { name: 'Monday' })).toHaveAttribute('aria-checked', 'true')
    expect([screen.getByLabelText('Opens'), screen.getByLabelText('Closes')].map((b) => (b as HTMLInputElement).value)).toEqual(['12:00 AM', '12:00 AM'])
    expect(screen.getByText(/A day runs midnight to midnight Eastern time\./)).toBeInTheDocument()
  })

  it('choosing Pacific redraws the hours and the reset times in Pacific, and saves only the zone', async () => {
    const onSave = await renderBuyer()
    chooseOption(screen.getByLabelText('Time zone'), 'Pacific time')
    // In Pacific the same window touches two days with different hours, so it opens one row per day (#2324).
    expect(hours('Sunday')).toEqual(['9:00 PM', '12:00 AM'])
    expect(hours('Monday')).toEqual(['12:00 AM', '9:00 PM'])
    expect(screen.getByText(/A day runs from 9:00 PM to 9:00 PM Pacific time, starting the evening before\./)).toBeInTheDocument()
    expect(screen.getByText('Each date is an Eastern day: it starts at 9:00 PM Pacific time the evening before.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const [sent] = profileSent(onSave)
    expect(sent).toMatchObject({ display_time_zone: 'America/Los_Angeles', windows: doc.windows })
  })

  it('shows a stored zone, and a save that did not change it leaves the zone out so the stored one is kept', async () => {
    loads({ ...doc, display_time_zone: 'America/Chicago' })
    const onSave = await renderBuyer()
    expect(readSelect(screen.getByLabelText('Time zone')).shown).toBe('Central time')
    fireEvent.change(screen.getByLabelText('Leads per day'), { target: { value: '600' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const [sent] = profileSent(onSave)
    expect(sent).toMatchObject({ daily_lead_cap: 600 })
    expect(sent && 'display_time_zone' in sent).toBe(false)
  })
})
