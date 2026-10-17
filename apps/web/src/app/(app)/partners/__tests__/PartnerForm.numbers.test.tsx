/**
 * The partners page's numbers are judged by the save, not the browser (#2328).
 * A number box used to carry browser limits (step, max), so a value outside
 * them was stopped by the browser's own popup and the save never ran, while
 * one the browser let through was rounded by the page (2.5 saved as 2). Now
 * the form never asks the browser, the shared rule (partnerNumberErrors)
 * refuses before anything is written, the bar names the field and its tab, and
 * the reason sits beside the field.
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
// A number box by its label, as a spinbutton, since "Errors" also names a section.
const box = (label: string) => screen.getByRole('spinbutton', { name: label })
function fieldErrorOf(label: string): HTMLElement | null {
  const describedBy = box(label).getAttribute('aria-describedby') ?? ''
  return describedBy.split(' ').map((id) => document.getElementById(id)).find((el): el is HTMLElement => el?.getAttribute('role') === 'alert') ?? null
}

describe('partner numbers are refused by the save, never the browser (#2328)', () => {
  it('the form never hands its numbers to the browser to judge', async () => {
    await openBidGroup()
    expect(document.querySelector('form')).toHaveAttribute('novalidate')
  })

  it('a fractional daily attempt cap is refused beside its field and in the bar, and nothing is saved', async () => {
    const { onSave } = await openBidGroup()
    fireEvent.change(box('Daily attempt cap'), { target: { value: '2.5' } })
    save()
    expect(await screen.findByText('Nothing saved: fix Daily attempt cap in Bid Group.')).toBeInTheDocument()
    expect(fieldErrorOf('Daily attempt cap')).toHaveTextContent('Daily attempt cap is a whole number, 1 or more.')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('an error count of 0 is refused rather than saved as the default of 5', async () => {
    const { onSave } = await openBidGroup()
    fireEvent.change(box('Errors'), { target: { value: '0' } })
    save()
    expect(await screen.findByText('Nothing saved: fix Errors in Bid Group.')).toBeInTheDocument()
    expect(fieldErrorOf('Errors')).toHaveTextContent('Errors is a whole number, 1 or more.')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('a whole number saves as typed', async () => {
    const { onSave } = await openBidGroup()
    fireEvent.change(box('Daily attempt cap'), { target: { value: '250' } })
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toEqual({ daily_cap: 250 })
  })
})
