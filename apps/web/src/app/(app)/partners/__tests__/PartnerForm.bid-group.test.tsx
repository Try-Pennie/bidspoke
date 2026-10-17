/**
 * The Bid Group tab as the settled design draws it (PM-23, #2326, frame 18 of
 * docs/design/partners-page.html and its resolverSections, requestResponseSections,
 * LIMITS, CIRCUIT and CLASSIFY builders at their final settings).
 *
 * Read from the rendered form: the section order, what each section holds, and
 * what a change in the minutes boxes saves (the store keeps seconds).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
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
import type { Partner } from '@/lib/api'

// AmOne as the recorded fixture holds it: a Partner API buyer reading its bid at
// data.bid, with one extraction and the circuit breaker at its defaults.
const amone = {
  id: 'p1', organization_id: 'org-1', name: 'AmOne', slug: 'amone', api_endpoint: 'https://am-one-proxy.trypennie.dev/leads/ping', cf_secret_key: 'AMONE_PROXY_SECRET', daily_cap: null, min_bid: null,
  bid_formula: null, bid_resolver_type: 'api', bid_resolver_config: { bid_path: 'data.bid' }, outbound_field_mapping: null,
  bid_comparison_source: 'auto', extra_extraction: { clickUrl: 'data.ClickThrough_url' }, last_probe_response: null, dedup_endpoint: null, response_classification: null,
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

async function openBidGroup(partner: Partner = amone) {
  const onSave = vi.fn().mockResolvedValue({ partner: { ...partner, version: 4 }, profile: null, copyWarning: null })
  const view = render(<PartnerForm partner={partner} onSave={onSave} onCancel={vi.fn()} />)
  await userEvent.click(await screen.findByRole('tab', { name: /^Bid Group/ }))
  const panel = view.container.querySelector<HTMLElement>('[role="tabpanel"][id$="-content-bid_group"]')!
  return { onSave, panel }
}
const save = () => fireEvent.click(document.querySelector('button[type="submit"]')!)
const headings = (panel: HTMLElement) => [...panel.querySelectorAll('h3')].map((h) => h.textContent)
const sectionOf = (panel: HTMLElement, title: string) => [...panel.querySelectorAll('section')].find((s) => s.querySelector('h3')?.textContent === title)!

describe('the Bid Group tab as designed (PM-23, #2326)', () => {
  it('draws its sections in the designed order', async () => {
    const { panel } = await openBidGroup()
    expect(headings(panel)).toEqual(['Bids in', 'Endpoint', 'Resolver', 'Bid amount', 'Request', 'Response', 'Limits', 'Circuit breaker', 'Errors', 'Confirmation window'])
  })

  it('Endpoint holds the address and secret side by side, then the duplicate check address with its meaning', async () => {
    const { panel } = await openBidGroup()
    const endpoint = within(sectionOf(panel, 'Endpoint'))
    expect(endpoint.getByLabelText('Address')).toHaveValue('https://am-one-proxy.trypennie.dev/leads/ping')
    expect(endpoint.getByLabelText('Secret')).toHaveValue('AMONE_PROXY_SECRET')
    // Side by side: the two fields share one row.
    expect(endpoint.getByLabelText('Address').closest('.endpoint-row')).toBe(endpoint.getByLabelText('Secret').closest('.endpoint-row'))
    const dedup = endpoint.getByLabelText('Duplicate check address')
    expect(dedup).toHaveAttribute('placeholder', 'None. Every lead is bid on.')
    expect(dedup).toHaveAccessibleDescription('Before each bid, Bidspoke asks this address whether the lead was already sold to the partner, and skips the bid if it was.')
  })

  it('the missing credential is red under the secret, in the designed words', async () => {
    const warning = "AMONE_PROXY_SECRET is not set as a Worker secret, so AmOne's next bid will fail. An engineer adds it in Cloudflare."
    const { panel } = await openBidGroup({ ...amone, credential_warning: warning })
    const endpoint = within(sectionOf(panel, 'Endpoint'))
    expect(endpoint.getByLabelText('Secret')).toHaveAccessibleDescription(warning)
    expect(endpoint.getByText(warning)).toHaveClass('field-error')
  })

  it('a resolver that makes no call keeps the warning and the duplicate check in Endpoint, without the address boxes', async () => {
    const warning = "AMONE_PROXY_SECRET is not set as a Worker secret. An engineer adds it in Cloudflare before AmOne is turned on."
    const { panel } = await openBidGroup({ ...amone, bid_resolver_type: 'formula', credential_warning: warning })
    const endpoint = within(sectionOf(panel, 'Endpoint'))
    expect(endpoint.getByText(warning)).toBeVisible()
    expect(endpoint.getByLabelText('Duplicate check address')).toBeVisible()
    expect(endpoint.queryByLabelText('Address')).not.toBeInTheDocument()
  })

  it('Resolver offers Partner API, Matrix lookup and No call', async () => {
    const { panel } = await openBidGroup()
    const group = within(sectionOf(panel, 'Resolver')).getByRole('radiogroup', { name: 'Resolver' })
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Partner API', 'Matrix lookup', 'No call'])
    expect(within(group).getByRole('radio', { name: 'Partner API' })).toHaveAttribute('aria-checked', 'true')
  })

  it('Bid amount is its own row: Response, Tier multiplier or Formula, with what each means', async () => {
    const { panel } = await openBidGroup()
    const amount = within(sectionOf(panel, 'Bid amount'))
    const group = amount.getByRole('radiogroup', { name: 'Bid amount' })
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Response', 'Tier multiplier', 'Formula'])
    expect(amount.getByText("Bidspoke reads the bid from the partner's response.")).toBeVisible()
    expect(amount.getByLabelText('Where the bid is in the response')).toHaveValue('data.bid')
  })

  it('Request and Response are two rows, each with a plain line, and the sample answer sits under Extract', async () => {
    const { panel } = await openBidGroup()
    const request = within(sectionOf(panel, 'Request'))
    expect(request.getByRole('heading', { name: 'Field mapping' })).toBeVisible()
    expect(request.getByText('No field is renamed before it is sent to AmOne.')).toBeVisible()
    const response = sectionOf(panel, 'Response')
    const subheads = [...response.querySelectorAll('h4')].map((h) => h.textContent)
    expect(subheads).toEqual(['Extract', 'Sample answer'])
    expect(within(response).getByText('Later steps read it as extra.clickUrl.')).toBeVisible()
    expect(within(response).getByText('Paste an answer from AmOne and the paths in it are offered as you type an extraction. Not used when bidding.')).toBeVisible()
    expect(within(response).getByRole('columnheader', { name: 'Where it is in the response' })).toBeInTheDocument()
  })

  it('Limits say No limit and None when empty, with one line for both', async () => {
    const { panel } = await openBidGroup()
    const limits = within(sectionOf(panel, 'Limits'))
    const line = 'The cap counts every bid a Bid Group asks this partner for in a day. A bid under the minimum is treated as a decline.'
    expect(limits.getByLabelText('Daily attempt cap')).toHaveAttribute('placeholder', 'No limit')
    expect(limits.getByLabelText('Minimum bid')).toHaveAttribute('placeholder', 'None')
    expect(limits.getByLabelText('Daily attempt cap')).toHaveAccessibleDescription(line)
    expect(limits.getByLabelText('Minimum bid')).toHaveAccessibleDescription(line)
    expect(limits.getAllByText(line)).toHaveLength(1)
  })

  it('Circuit breaker reads On, with Errors, Within and Pause for in minutes, and one line', async () => {
    const { panel } = await openBidGroup()
    const circuit = within(sectionOf(panel, 'Circuit breaker'))
    expect(circuit.getByText('On')).toBeVisible()
    expect(circuit.getByLabelText('Errors')).toHaveValue(5)
    expect(circuit.getByLabelText('Within')).toHaveValue(1)
    expect(circuit.getByLabelText('Pause for')).toHaveValue(5)
    expect(circuit.getAllByText('minutes')).toHaveLength(2)
    expect(circuit.getByText('Too many failed calls in a short time stop bids to AmOne for a while, then it is tried again on its own.')).toBeVisible()
  })

  it('minutes typed into the circuit breaker save as the seconds the store keeps', async () => {
    const { panel, onSave } = await openBidGroup()
    const circuit = within(sectionOf(panel, 'Circuit breaker'))
    fireEvent.change(circuit.getByLabelText('Within'), { target: { value: '2' } })
    fireEvent.change(circuit.getByLabelText('Pause for'), { target: { value: '0.5' } })
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toEqual({ circuit_window_seconds: 120, circuit_cooldown_seconds: 30 })
  })

  it('the error rules are headed Errors', async () => {
    const { panel } = await openBidGroup()
    expect(within(sectionOf(panel, 'Errors')).getByText('Retry when any of')).toBeVisible()
    expect(headings(panel)).not.toContain('Response classification')
  })
})
