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
  confirmation_window_ms: null, is_active: true, priority: 2, sell_off_offer_title: null, sell_off_offer_details: null, click_url: 'https://trypennie.com/portal/tpl',
  external_routing_code: 2, duplicate_signals: [{ field: 'data.createLead.resultCode', in: [1003, 1004, 1020] }],
  sub_account_min_bids: null, partner_type: 'buyer', created_at: '', updated_at: '2027-09-20T15:00:00.000Z', updated_by_email: null, updated_by_name: null,
}

const doc: BuyerProfileDocument = {
  partner_id: 'p1', version: 3, sold_on: 'offer', is_enabled: true, priority: 1, allowed_states: ['TX'],
  debt_min: 15000, debt_max: null, loan_amount_min: null,
  hourly_lead_cap: null, daily_lead_cap: 500, hourly_spend_cap_cents: null, daily_spend_cap_cents: null,
  windows: [{ day_of_week: 1, opens_minute: 0, closes_minute: 1440 }],
  blackout_dates: [],
  tiers: [{ population: 'engine', debt_from: 15000, debt_to: null, multiplier: 0.0012 }],
}

const usage = {
  sold_on: 'offer' as const,
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

  // #1416: the two facts the Engine scripts read from the winner live on the partner
  // record, edited here, saved with it, and required before the profile can be enabled.
  it('saves the Salesforce routing code and the duplicate rules on the partner record, beside the accept rules', async () => {
    const onSave = await renderBuyer()
    expect(screen.getByLabelText('Salesforce routing code')).toHaveValue(2)
    fireEvent.change(screen.getByLabelText('Salesforce routing code'), { target: { value: '4' } })
    const duplicateRows = screen.getAllByRole('group', { name: /duplicate rule/i })
    expect(duplicateRows).toHaveLength(1)
    expect(within(duplicateRows[0]).getByLabelText(/value/i)).toHaveValue('1003,1004,1020')
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toMatchObject({ external_routing_code: 4, duplicate_signals: [{ field: 'data.createLead.resultCode', in: [1003, 1004, 1020] }] })
  })

  it('an enabled profile whose partner has no routing code is refused by the field name, and nothing is saved', async () => {
    const onSave = await renderBuyer()
    fireEvent.change(screen.getByLabelText('Salesforce routing code'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    const outcome = await screen.findByText(/Nothing saved\./)
    expect(outcome).toHaveTextContent('Salesforce routing code: Set the Salesforce routing code on the partner before enabling.')
    expect(onSave).not.toHaveBeenCalled()
    expect(api.buyerProfiles.save).not.toHaveBeenCalled()
  })

  it('a profile the shared validator refuses is not saved on either side, and the errors sit beside their controls', async () => {
    const onSave = await renderBuyer()
    fireEvent.change(screen.getByLabelText('Leads per hour'), { target: { value: '900' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/hourly.*daily/i))
    expect(onSave).not.toHaveBeenCalled()
    expect(api.buyerProfiles.save).not.toHaveBeenCalled()
  })

  it('the refusal beside the Save button names the field by its label and carries the reason, and never says below (#1464, L111, L399)', async () => {
    await renderBuyer()
    fireEvent.change(screen.getByLabelText('Leads per hour'), { target: { value: '900' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    const outcome = await screen.findByText(/Nothing saved\./)
    expect(outcome).toHaveTextContent('Nothing saved. Fix the buyer profile first: Leads per hour: The hourly lead cap is above the daily lead cap.')
    expect(outcome).not.toHaveTextContent(/below/i)
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

  it('a Show more that fails keeps the rows already shown and their controls, and says the rest could not be read beside them', async () => {
    const sale = (n: number) => ({ id: `sale-${n}`, partner_id: 'p1', lead_key: `lead-${n}`, kind: 'live', payout_cents: 2190, reserved_at: '2027-09-20T15:30:00.000Z', http_status: 200, result_code: null, status: 'unresolved', partner_configs: { slug: 'tripoint', name: 'Tripoint' } })
    vi.mocked(api.buyerSales.list)
      .mockResolvedValueOnce({ entries: [sale(1)], total: 3, page: 1, limit: 100 })
      .mockRejectedValueOnce(new Error('API 503'))
    await renderBuyer()
    fireEvent.click(await screen.findByRole('button', { name: 'Show 2 more' }))
    expect(await screen.findByText(/The rest of the unresolved sales could not be read: API 503/)).toBeInTheDocument()
    expect(screen.getByText('lead-1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Count as sold' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show 2 more' })).toBeEnabled()
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

// #1541: a buyer is sold on the offer (through buyer selection) or on the click
// (quoted at the Engine bid, posted to only when the person clicks).
describe('how the buyer is sold', () => {
  const clickDoc: BuyerProfileDocument = { ...doc, sold_on: 'click', priority: null, tiers: [], daily_lead_cap: 50 }

  async function renderWith(profile: BuyerProfileDocument | null, partnerOver: Partial<Partner> = {}) {
    vi.mocked(api.buyerProfiles.get).mockResolvedValue({ profile, accept_signals: [], other_sellers: [] })
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<PartnerForm partner={{ ...partner, ...partnerOver }} onSave={onSave} onCancel={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Sold on' })).toBeInTheDocument())
    return onSave
  }

  it('a partner with no profile yet has no answer chosen, and saving the partner alone does not ask for one', async () => {
    const onSave = await renderWith(null)
    expect(within(screen.getByRole('radiogroup', { name: 'Sold on' })).getAllByRole('radio').map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false'])
    fireEvent.change(screen.getByLabelText('List order'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(api.buyerProfiles.save).not.toHaveBeenCalled()
  })

  it('an edited new profile is refused until the kind is chosen, then saved with it', async () => {
    const onSave = await renderWith(null)
    fireEvent.change(screen.getByLabelText('Leads per day'), { target: { value: '50' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    const outcome = await screen.findByText(/Nothing saved\./)
    expect(outcome).toHaveTextContent('Sold on: Choose whether this buyer is sold on the offer or on the click.')
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'The click' }))
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(api.buyerProfiles.save).toHaveBeenCalledWith('p1', { expected_version: 0, profile: expect.objectContaining({ sold_on: 'click', daily_lead_cap: 50 }) }))
  })

  it('a click buyer shows no priority, pricing, accept rules or ledger counts, and its cap reads clicks per day', async () => {
    vi.mocked(api.buyerProfiles.usage).mockResolvedValue({ sold_on: 'click', count: 17, date: '2027-09-21', day_zone: 'America/Los_Angeles' })
    await renderWith(clickDoc)
    expect(screen.getByRole('radio', { name: 'The click' })).toHaveAttribute('aria-checked', 'true')
    const region = screen.getByRole('region', { name: 'Buyer profile' })
    expect(within(region).queryByLabelText('Priority')).toBeNull()
    expect(within(region).queryByRole('heading', { name: 'Pricing' })).toBeNull()
    expect(within(region).queryByText('Accept when all of')).toBeNull()
    expect(screen.getByLabelText('Clicks per day')).toHaveValue(50)
    for (const label of ['Leads per hour', 'Leads per day', 'Spend per hour', 'Spend per day']) expect(screen.queryByLabelText(label)).toBeNull()
    expect(within(region).queryByText(/as the buyer ledger holds it/)).toBeNull()
  })

  // #1543: the click counter replaces the ledger counts for a click buyer, the
  // same count buyer_click_check stops offering at. The Pacific day is stated
  // once, in the caps note; the panel shows the date and the count (#1557, L605).
  it('a click buyer shows the clicks against its cap for the date counted, and the Pacific day once on the page', async () => {
    vi.mocked(api.buyerProfiles.usage).mockResolvedValue({ sold_on: 'click', count: 17, date: '2027-09-21', day_zone: 'America/Los_Angeles' })
    await renderWith(clickDoc)
    expect(await screen.findByText('17 of 50 clicks on 2027-09-21')).toBeInTheDocument()
    expect(screen.getByText('Room under the cap.')).toBeInTheDocument()
    const region = screen.getByRole('region', { name: 'Buyer profile' })
    expect(within(region).getAllByText(/Pacific/)).toHaveLength(1)
    expect(within(region).getAllByText(/not offered/)).toHaveLength(1)
  })

  it('a click buyer at its cap says the cap is reached', async () => {
    vi.mocked(api.buyerProfiles.usage).mockResolvedValue({ sold_on: 'click', count: 50, date: '2027-09-21', day_zone: 'America/Los_Angeles' })
    await renderWith(clickDoc)
    expect(await screen.findByText('50 of 50 clicks on 2027-09-21')).toBeInTheDocument()
    expect(screen.getByText('The cap is reached.')).toBeInTheDocument()
  })

  // #1557: req() puts the body's error CODE in the message, so these reject with
  // exactly what req() throws, and the page must show the body's sentence.
  it('a click count that cannot be read shows the route\'s sentence, never its code, and no number', async () => {
    vi.mocked(api.buyerProfiles.usage).mockRejectedValue(Object.assign(new Error('click_count_unavailable'), { status: 503, body: { error: 'click_count_unavailable', message: 'The click counter did not answer, so the clicks today cannot be shown.' } }))
    await renderWith(clickDoc)
    expect(await screen.findByText('The click counter did not answer, so the clicks today cannot be shown.')).toHaveAttribute('role', 'alert')
    expect(screen.queryByText(/click_count_unavailable/)).toBeNull()
    expect(screen.queryByText(/ clicks on /)).toBeNull()
  })

  it('an offer buyer whose ledger does not answer shows the route\'s sentence, never its code', async () => {
    vi.mocked(api.buyerProfiles.usage).mockRejectedValue(Object.assign(new Error('usage_unavailable'), { status: 503, body: { error: 'usage_unavailable', message: 'The buyer ledger did not answer, so the counts cannot be shown.' } }))
    await renderWith(doc)
    expect(await screen.findByText('The buyer ledger did not answer, so the counts cannot be shown.')).toBeInTheDocument()
    expect(screen.queryByText(/usage_unavailable/)).toBeNull()
  })

  it('an unsaved change of kind is a neutral not saved yet note, not an error, and reads nothing again', async () => {
    const bare: BuyerProfileDocument = { ...doc, is_enabled: false, tiers: [], hourly_lead_cap: null }
    await renderWith(bare, { accept_signals: [] })
    await waitFor(() => expect(api.buyerProfiles.usage).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('radio', { name: 'The click' }))
    const note = await screen.findByText('The clicks show once the change to the click is saved.')
    expect(note).toHaveAttribute('role', 'status')
    expect(note.className).not.toMatch(/red/)
    // Choosing a kind is not a save, so the usage is not read again.
    expect(api.buyerProfiles.usage).toHaveBeenCalledTimes(1)
  })

  it('a save refused because a live click workflow names the buyer says so in the route\'s words (#1557)', async () => {
    vi.mocked(api.buyerProfiles.usage).mockResolvedValue({ sold_on: 'click', count: 3, date: '2027-09-21', day_zone: 'America/Los_Angeles' })
    const message = 'This buyer is sold on the click in live workflows: Engine Bidding. Nothing was saved. Take it off their click nodes, or switch those workflows off, before selling it on the offer.'
    vi.mocked(api.buyerProfiles.save).mockRejectedValue(Object.assign(new Error('sold_on_in_use'), { status: 409, body: { error: 'sold_on_in_use', message, workflows: [{ id: 'wf-1', name: 'Engine Bidding' }] } }))
    await renderWith({ ...clickDoc, daily_lead_cap: 60 })
    fireEvent.change(screen.getByLabelText('Clicks per day'), { target: { value: '55' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    expect(await screen.findByText(/The buyer profile was not saved: This buyer is sold on the click in live workflows: Engine Bidding/)).toBeInTheDocument()
    expect(screen.queryByText(/sold_on_in_use/)).toBeNull()
  })

  it('an offer buyer with pricing stored cannot be switched, and says why beside the choice', async () => {
    await renderWith(doc)
    const group = screen.getByRole('radiogroup', { name: 'Sold on' })
    expect(group).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'The click' }))
    expect(screen.getByRole('radio', { name: 'The offer' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(/pricing and accept rules are stored/i)).toBeInTheDocument()
  })

  it('an offer buyer with nothing stored that the kind governs can become a click buyer, and the save carries it', async () => {
    const bare: BuyerProfileDocument = { ...doc, is_enabled: false, tiers: [], hourly_lead_cap: null }
    await renderWith(bare, { accept_signals: [] })
    fireEvent.click(screen.getByRole('radio', { name: 'The click' }))
    expect(screen.queryByRole('heading', { name: 'Pricing' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(api.buyerProfiles.save).toHaveBeenCalledWith('p1', { expected_version: 3, profile: expect.objectContaining({ sold_on: 'click' }) }))
  })
})
