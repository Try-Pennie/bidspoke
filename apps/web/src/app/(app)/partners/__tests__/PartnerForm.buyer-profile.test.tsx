/**
 * The Buyer profile section on the partner page (#1412, Phase 5 PR 2).
 *
 * The section is part of the partner form: the profile document and the
 * accept rules are form state, so one Save writes the partner record first
 * (the rules live there) and the profile document second, and the outcome says
 * what landed. A stale version comes back as the side by side, keeping every
 * edit. The two legacy fields whose names collided with the profile's are
 * relabelled so one word means one thing on the page (L118).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { BuyerProfileDocument } from '@bidspoke/buyer-profile'

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
import type { Partner } from '@/lib/api'

const partner: Partner = {
  id: 'p1', organization_id: 'org-1', name: 'Tripoint', slug: 'tripoint',
  api_endpoint: 'https://tripoint.example/leads', cf_secret_key: null, daily_cap: 250, min_bid: null, bid_formula: null,
  bid_resolver_type: 'api', bid_resolver_config: {}, outbound_field_mapping: null, bid_mode: 'commit', bid_comparison_source: 'auto',
  extra_extraction: null, last_probe_response: null, dedup_endpoint: null,
  response_classification: { rejection_signals: [{ field: 'data.createLead.resultCode', in: [1003, 1004, 1020] }] },
  accept_signals: [{ field: 'ok', equals: true }],
  alert_config: null, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 300, circuit_enabled: true,
  confirmation_window_ms: null, is_active: true, priority: 2, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null,
  sub_account_min_bids: null, partner_type: 'buyer', created_at: '', updated_at: '2027-09-20T15:00:00.000Z', updated_by_email: null, updated_by_name: null,
}

const doc: BuyerProfileDocument = {
  partner_id: 'p1', version: 3, is_enabled: true, priority: 1, allowed_states: ['TX'],
  debt_min: 15000, debt_max: null, loan_amount_min: null,
  hourly_lead_cap: null, daily_lead_cap: 500, hourly_spend_cap_cents: null, daily_spend_cap_cents: null,
  windows: [{ day_of_week: 1, opens_minute: 0, closes_minute: 1440 }],
  blackout_dates: [],
  tiers: [{ population: 'engine', debt_from: 15000, debt_to: null, multiplier: 0.0012 }],
}

const usage = {
  et_day: '2027-09-20', hour_bucket: 505_935, hour: { leads: 7, spend_cents: 15_330 },
  day: { leads: 42, spend_cents: 91_980, by_status: { reserved: 1, accepted: 40, declined: 5, released: 2, unresolved: 1 } },
  counted_populations: ['engine'], outside_wins_today: 3, unmeasured: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.partnerUuids.list).mockResolvedValue([])
  vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([])
  vi.mocked(api.buyerProfiles.get).mockResolvedValue({ profile: doc, accept_signals: [{ field: 'ok', equals: true }], other_sellers: [{ id: 'wf-main', name: 'Main Flow' }] })
  vi.mocked(api.buyerProfiles.history).mockResolvedValue({ entries: [] })
  vi.mocked(api.buyerProfiles.usage).mockResolvedValue(usage)
  vi.mocked(api.buyerSales.list).mockResolvedValue({ entries: [], total: 0, page: 1, limit: 100 })
  vi.mocked(api.buyerProfiles.save).mockResolvedValue({ profile: { ...doc, version: 4 } })
})

async function renderBuyer(onSave = vi.fn().mockResolvedValue(undefined)) {
  render(<PartnerForm partner={partner} onSave={onSave} onCancel={vi.fn()} />)
  await waitFor(() => expect(screen.getByRole('region', { name: 'Buyer profile' })).toBeInTheDocument())
  await waitFor(() => expect(screen.getByLabelText('Leads per day')).toHaveValue(500))
  return onSave
}

describe('the Buyer profile section', () => {
  it('renders for a buyer partner with the loaded document, and not for a source partner', async () => {
    await renderBuyer()
    expect(screen.getByRole('switch', { name: 'Enabled' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('checkbox', { name: 'TX' })).toBeChecked()
    render(<PartnerForm partner={{ ...partner, partner_type: 'source' }} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getAllByRole('region', { name: 'Buyer profile' })).toHaveLength(1)
  })

  it('the word priority appears once on the composed page: the legacy field is List order (L118)', async () => {
    await renderBuyer()
    expect(screen.getAllByText(/priority/i)).toHaveLength(1)
    expect(screen.getByLabelText('List order')).toHaveValue(2)
    expect(screen.getByText('Orders the partner list. It does not affect who is offered a lead.')).toBeInTheDocument()
    expect(screen.getByLabelText('Daily attempt cap (bidding workflows)')).toHaveValue(250)
  })

  it('orders the section for the reader: enabled and priority, then pricing and caps, then rules, blackout dates last (L609)', async () => {
    await renderBuyer()
    const region = screen.getByRole('region', { name: 'Buyer profile' })
    const headings = within(region).getAllByRole('heading').map((h) => h.textContent)
    const index = (label: RegExp) => headings.findIndex((h) => label.test(h ?? ''))
    expect(index(/enabled/i)).toBeLessThan(index(/pricing/i))
    expect(index(/pricing/i)).toBeLessThan(index(/caps/i))
    expect(index(/caps/i)).toBeLessThan(index(/outcome rules/i))
    expect(index(/outcome rules/i)).toBeLessThan(index(/blackout/i))
  })

  it('saves the partner record first (the rules live there) and the profile second, and says both landed', async () => {
    const onSave = await renderBuyer()
    fireEvent.change(screen.getByLabelText('Leads per day'), { target: { value: '600' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(api.buyerProfiles.save).toHaveBeenCalled())
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.buyerProfiles.save).mock.invocationCallOrder[0])
    expect(onSave.mock.calls[0][0]).toMatchObject({ accept_signals: [{ field: 'ok', equals: true }] })
    expect(api.buyerProfiles.save).toHaveBeenCalledWith('p1', { expected_version: 3, profile: expect.objectContaining({ daily_lead_cap: 600 }) })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Partner saved\. Buyer profile saved, version 4\./))
  })

  it('a profile the shared validator refuses is not saved on either side, and the errors sit beside their controls', async () => {
    const onSave = await renderBuyer()
    fireEvent.change(screen.getByLabelText('Leads per hour'), { target: { value: '900' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/hourly.*daily/i))
    expect(onSave).not.toHaveBeenCalled()
    expect(api.buyerProfiles.save).not.toHaveBeenCalled()
  })

  it('a stale version shows the side by side, keeps the edits, and Save over theirs re-submits with the new version', async () => {
    const theirs = { ...doc, version: 5, daily_lead_cap: 250 }
    const stale = Object.assign(new Error('stale_version'), { status: 409, body: { error: 'stale_version', current: theirs } })
    vi.mocked(api.buyerProfiles.save).mockRejectedValueOnce(stale).mockResolvedValueOnce({ profile: { ...doc, version: 6, daily_lead_cap: 600 } })
    await renderBuyer()
    fireEvent.change(screen.getByLabelText('Leads per day'), { target: { value: '600' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    const dialog = await screen.findByRole('alertdialog', { name: /saved by someone else/i })
    expect(dialog).toHaveTextContent(/Leads per day/)
    expect(screen.getByLabelText('Leads per day')).toHaveValue(600)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save over theirs' }))
    await waitFor(() => expect(api.buyerProfiles.save).toHaveBeenLastCalledWith('p1', { expected_version: 5, profile: expect.objectContaining({ daily_lead_cap: 600 }) }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/version 6/))
  })

  it('Take theirs replaces the form with the current document and closes the side by side', async () => {
    const theirs = { ...doc, version: 5, daily_lead_cap: 250 }
    vi.mocked(api.buyerProfiles.save).mockRejectedValueOnce(Object.assign(new Error('stale_version'), { status: 409, body: { error: 'stale_version', current: theirs } }))
    await renderBuyer()
    fireEvent.change(screen.getByLabelText('Leads per day'), { target: { value: '600' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Take theirs' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByLabelText('Leads per day')).toHaveValue(250)
  })

  it('a profile read that fails is its own state and does not pretend the profile is empty (L10)', async () => {
    vi.mocked(api.buyerProfiles.get).mockRejectedValue(new Error('API 500'))
    render(<PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('region', { name: 'Buyer profile' })).toHaveTextContent(/could not be read/i))
    expect(screen.queryByLabelText('Leads per day')).toBeNull()
  })

  it('asks the API for this buyer\'s unresolved sales only, shows the API\'s own total, and fetches the next page on Show more (#1457, L16)', async () => {
    const sale = (n: number) => ({ id: `sale-${n}`, partner_id: 'p1', lead_key: `lead-${n}`, kind: 'live', payout_cents: 2190, reserved_at: '2027-09-20T15:30:00.000Z', http_status: 200, result_code: null, status: 'unresolved', partner_configs: { slug: 'tripoint', name: 'Tripoint' } })
    vi.mocked(api.buyerSales.list)
      .mockResolvedValueOnce({ entries: [sale(1)], total: 3, page: 1, limit: 100 })
      .mockResolvedValueOnce({ entries: [sale(2), sale(3)], total: 3, page: 2, limit: 100 })
    await renderBuyer()
    await waitFor(() => expect(api.buyerSales.list).toHaveBeenCalledWith({ status: 'unresolved', page: 1, limit: 100, partner_id: 'p1' }))
    expect(await screen.findByText('Showing 1 of 3 unresolved sales.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }))
    await waitFor(() => expect(api.buyerSales.list).toHaveBeenLastCalledWith({ status: 'unresolved', page: 2, limit: 100, partner_id: 'p1' }))
    // The lead key cell, so the count is of this list's rows and not of every table on the page.
    await waitFor(() => expect(screen.getAllByText(/^lead-\d$/)).toHaveLength(3))
    expect(screen.queryByText(/Showing/)).toBeNull()
  })

  it('shows the usage panel with the other sellers named, and settles an unresolved sale through the API with its outcome on the row', async () => {
    vi.mocked(api.buyerSales.list).mockResolvedValue({
      entries: [{ id: 'sale-1', partner_id: 'p1', lead_key: 'lead-1', kind: 'live', payout_cents: 2190, reserved_at: '2027-09-20T15:30:00.000Z', http_status: 200, result_code: null, status: 'unresolved', partner_configs: { slug: 'tripoint', name: 'Tripoint' } }],
      total: 1, page: 1, limit: 100,
    })
    vi.mocked(api.buyerSales.settle).mockResolvedValue({ entry: { status: 'released' }, mirrored: true })
    await renderBuyer()
    expect(screen.getByText(/Main Flow also sells to Tripoint/)).toBeInTheDocument()
    const row = (await screen.findByText('lead-1')).closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: /free the slot/i }))
    fireEvent.click(within(row).getByRole('button', { name: /^confirm/i }))
    await waitFor(() => expect(api.buyerSales.settle).toHaveBeenCalledWith('sale-1', 'released'))
    await waitFor(() => expect(within(row).getByRole('status')).toHaveTextContent(/Released\. The slot is free\./))
  })

  it('a new partner has no profile to edit yet and says so', () => {
    render(<PartnerForm onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('region', { name: 'Buyer profile' })).toHaveTextContent(/save the partner first/i)
    expect(api.buyerProfiles.get).not.toHaveBeenCalled()
  })
})
