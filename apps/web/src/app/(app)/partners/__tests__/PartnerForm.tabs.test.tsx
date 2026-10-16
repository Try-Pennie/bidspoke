/**
 * The partner form's tabs (#2137, PM-1, PM-12): only the tabs that apply, the
 * Bid Group tab's three states while its usage read runs, fails or finds
 * nothing, the confirmation window offered before any gate exists, the tab the
 * URL asks for, and problems marked on the tab holding them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/api', () => ({
  api: {
    partners: { usage: vi.fn() },
    partnerUuids: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    partnerBidConfigs: { list: vi.fn() },
    buyerProfiles: { get: vi.fn(), history: vi.fn(), usage: vi.fn() },
    buyerSales: { list: vi.fn(), settle: vi.fn() },
  },
}))

import PartnerForm from '../PartnerForm'
import { api } from '@/lib/api'
import type { Partner, PartnerUsage } from '@/lib/api'

const partner: Partner = {
  id: 'p1', organization_id: 'org-1', name: 'Acme', slug: 'acme', api_endpoint: null, cf_secret_key: null, daily_cap: null, min_bid: null,
  bid_formula: null, bid_resolver_type: 'api', bid_resolver_config: {}, outbound_field_mapping: null, bid_mode: 'commit',
  bid_comparison_source: 'auto', extra_extraction: null, last_probe_response: null, dedup_endpoint: null, response_classification: null,
  alert_config: null, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 300, circuit_enabled: true,
  confirmation_window_ms: null, is_active: true, priority: 0, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null,
  sub_account_min_bids: null, partner_type: 'buyer', created_at: '', updated_at: '2026-10-13T18:05:00Z', updated_by_email: null, updated_by_name: 'Editor A',
  version: 3,
}
const NONE: PartnerUsage = { bid_group: [], partner_bid: [], latency_gate: [] }
const step = (over: Record<string, unknown> = {}) => ({ workflow_id: 'w', workflow_name: 'Main Flow (v2)', is_active: false, node_id: 'n', ...over })
const names = new Map([['p1', 'Acme'], ['p2', 'Tripoint']])

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.partners.usage).mockResolvedValue(NONE)
  vi.mocked(api.partnerUuids.list).mockResolvedValue([])
  vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([])
  vi.mocked(api.buyerProfiles.get).mockResolvedValue({ profile: null, accept_signals: [], other_sellers: [] })
  vi.mocked(api.buyerProfiles.history).mockResolvedValue({ entries: [] })
  vi.mocked(api.buyerProfiles.usage).mockRejectedValue(new Error('not read here'))
  vi.mocked(api.buyerSales.list).mockResolvedValue({ entries: [], total: 0, page: 1, limit: 100 })
})

const tabs = () => screen.getAllByRole('tab').map((t) => t.textContent)

describe('the Bid Group tab and its usage read (#2137)', () => {
  it('a partner named only in a switched off workflow shows Bid Group, saying which workflow and who is asked', async () => {
    vi.mocked(api.partners.usage).mockResolvedValue({ ...NONE, bid_group: [{ ...step(), mode: 'highest_bid', partner_ids: ['p2', 'p1'] }] })
    render(<PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} partnerNames={names} />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Bid Group' }))
    expect(screen.getByText('Main Flow (v2) (switched off). On each lead, Tripoint and Acme are both asked for a bid, and the higher bid wins.')).toBeVisible()
    expect(api.partners.usage).toHaveBeenCalledWith('p1')
  })

  it('a partner nothing names has no Bid Group tab until Set up for Bid Group, which says no workflow uses it', async () => {
    render(<PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} />)
    await waitFor(() => expect(api.partners.usage).toHaveBeenCalled())
    await waitFor(() => expect(tabs()).toEqual(['Partner', 'Buyer profile', 'Workflow values', 'History']))
    await userEvent.click(screen.getByRole('tab', { name: 'Partner' }))
    await userEvent.click(screen.getByRole('button', { name: 'Set up for Bid Group' }))
    expect(tabs()).toEqual(['Partner', 'Buyer profile', 'Bid Group', 'Workflow values', 'History'])
    expect(screen.getByRole('tab', { name: 'Bid Group' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText("No workflow's Bid Group names Acme, so nothing on this tab is used.")).toBeVisible()
  })

  it('a rejected usage read shows the tab with its error and a retry, never a missing tab', async () => {
    vi.mocked(api.partners.usage).mockRejectedValueOnce(Object.assign(new Error('Service unavailable'), { status: 503 }))
    render(<PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Bid Group' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not check which workflows use this partner. Try again.')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(api.partners.usage).toHaveBeenCalledTimes(2))
  })

  it('while the read runs the tab says so, never that no workflow names the partner', async () => {
    vi.mocked(api.partners.usage).mockReturnValue(new Promise(() => {}))
    render(<PartnerForm partner={{ ...partner, min_bid: 3.08 }} onSave={vi.fn()} onCancel={vi.fn()} />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Bid Group' }))
    expect(screen.getByRole('status')).toHaveTextContent('Checking which workflows use this partner')
    expect(screen.queryByText(/No workflow's Bid Group/)).toBeNull()
  })

  it('reads the bid matrices only once the Bid Group tab applies', async () => {
    render(<PartnerForm partner={{ ...partner, partner_type: 'source' }} onSave={vi.fn()} onCancel={vi.fn()} />)
    await waitFor(() => expect(api.partners.usage).toHaveBeenCalled())
    await waitFor(() => expect(tabs()).toEqual(['Partner', 'Workflow values', 'History']))
    expect(api.partnerBidConfigs.list).not.toHaveBeenCalled()
  })

  it('a minimum bid alone shows the tab, and says that is why', async () => {
    render(<PartnerForm partner={{ ...partner, min_bid: 3.08 }} onSave={vi.fn()} onCancel={vi.fn()} />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Bid Group' }))
    expect(await screen.findByText("No workflow's Bid Group names Acme, so nothing on this tab is used. It shows because a Bid Group setting is filled in.")).toBeVisible()
  })
})

describe('the confirmation window (L630)', () => {
  it('a partner named by no workflow can set it up and save it', async () => {
    const onSave = vi.fn().mockResolvedValue({ partner: { ...partner, version: 4 }, profile: null, copyWarning: null })
    render(<PartnerForm partner={partner} onSave={onSave} onCancel={vi.fn()} />)
    await waitFor(() => expect(api.partners.usage).toHaveBeenCalled())
    await userEvent.click(screen.getByRole('tab', { name: 'Partner' }))
    await userEvent.click(screen.getByRole('button', { name: 'Set up for Bid Group' }))
    expect(screen.getByText('Used only by a Latency Gate step. No workflow has one for Acme.')).toBeVisible()
    expect(screen.queryByLabelText('Confirmation window (ms)')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Set up a confirmation window/ }))
    fireEvent.change(screen.getByLabelText('Confirmation window (ms)'), { target: { value: '5000' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toEqual({ confirmation_window_ms: 5000 })
  })

  it('shows the field when a Latency Gate names the partner', async () => {
    vi.mocked(api.partners.usage).mockResolvedValue({ ...NONE, partner_bid: [step({ is_active: true, workflow_name: 'Lead Economy' })], latency_gate: [step({ is_active: true, workflow_name: 'Lead Economy' })] })
    render(<PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Bid Group' }))
    expect(screen.getByLabelText('Confirmation window (ms)')).toBeVisible()
    expect(screen.getByText('Lead Economy, in a Partner Bid step.')).toBeVisible()
  })
})

describe('the tab a partner opens on, and the URL (#2137)', () => {
  it('a buyer opens on its buyer profile, and a tab press is reported for the URL', async () => {
    const onTabChange = vi.fn()
    render(<PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} onTabChange={onTabChange} />)
    expect(screen.getByRole('tab', { name: 'Buyer profile' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(onTabChange).toHaveBeenLastCalledWith('history')
  })

  it('a tab in the URL wins', () => {
    render(<PartnerForm partner={partner} requestedTab="workflow_values" onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('tab', { name: 'Workflow values' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Click URL')).toBeVisible()
  })

  it('a tab the partner does not show falls back to the first tab, and the URL is corrected', async () => {
    const onTabChange = vi.fn()
    render(<PartnerForm partner={{ ...partner, partner_type: 'source' }} requestedTab="buyer_profile" onSave={vi.fn()} onCancel={vi.fn()} onTabChange={onTabChange} />)
    expect(screen.getByRole('tab', { name: 'Partner' })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(onTabChange).toHaveBeenCalledWith('partner'))
  })

  it('a Bid Group asked for by the URL stays while the read runs, and falls back once it finds nothing', async () => {
    let answer!: (u: PartnerUsage) => void
    vi.mocked(api.partners.usage).mockReturnValue(new Promise((res) => { answer = res }))
    const onTabChange = vi.fn()
    render(<PartnerForm partner={partner} requestedTab="bid_group" onSave={vi.fn()} onCancel={vi.fn()} onTabChange={onTabChange} />)
    expect(screen.getByRole('tab', { name: 'Bid Group' })).toHaveAttribute('aria-selected', 'true')
    answer(NONE)
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Partner' })).toHaveAttribute('aria-selected', 'true'))
    expect(onTabChange).toHaveBeenLastCalledWith('partner')
  })

  it('every panel stays mounted with exactly one visible', () => {
    const { container } = render(<PartnerForm partner={{ ...partner, min_bid: 1 }} onSave={vi.fn()} onCancel={vi.fn()} />)
    const panels = [...container.querySelectorAll('[role="tabpanel"]')]
    expect(panels.length).toBe(5)
    expect(panels.filter((p) => !p.hasAttribute('hidden'))).toHaveLength(1)
  })
})

describe('problems open where they are (PM-12)', () => {
  it('a refused field marks its tab, and Show me opens it', async () => {
    const onSave = vi.fn().mockRejectedValue(Object.assign(new Error('refused'), { status: 422, body: { error: 'click_url_has_no_prospect_id', message: 'The click URL needs {prospect_id}.', errors: [{ code: 'click_url_has_no_prospect_id', path: 'clickUrl', field: 'click_url', message: 'The click URL needs {prospect_id}.' }] } }))
    const onProblemChange = vi.fn()
    render(<PartnerForm partner={partner} onSave={onSave} onCancel={vi.fn()} onProblemChange={onProblemChange} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Partner' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Acme 2' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    const tab = await screen.findByRole('tab', { name: 'Workflow values, has a problem' })
    expect(onProblemChange).toHaveBeenLastCalledWith(true)
    await userEvent.click(screen.getByRole('button', { name: 'Show me: the Workflow values tab' }))
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Click URL')).toBeVisible()
  })

  it('a refused path no tab holds is a page level problem, never nothing', async () => {
    const onSave = vi.fn().mockRejectedValue(Object.assign(new Error('refused'), { status: 422, body: { error: 'x', errors: [{ code: 'x', path: 'somethingNew', message: 'Something new is wrong.' }] } }))
    const { container } = render(<PartnerForm partner={partner} onSave={onSave} onCancel={vi.fn()} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Partner' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Acme 2' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(container.querySelectorAll('[data-problem-mark]').length).toBe(1))
    expect(screen.getAllByText('Something new is wrong.').length).toBeGreaterThan(0)
  })
})

describe('History (#2137)', () => {
  it('says when the partner was last saved and by whom, and reads the profile history only once opened', async () => {
    render(<PartnerForm partner={partner} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(api.buyerProfiles.history).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(screen.getByText('Last saved Oct 13, 2:05 PM ET by Editor A.')).toBeVisible()
    await waitFor(() => expect(api.buyerProfiles.history).toHaveBeenCalledWith('p1'))
    expect(await screen.findByText('This profile has never been saved.')).toBeVisible()
  })
})
