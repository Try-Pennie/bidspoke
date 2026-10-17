/**
 * The partner form on the shared controls (#2137, #1458). PartnerForm's own
 * Field, Input and Toggle are gone: its number boxes are NumberInput and its
 * switches the Radix Toggle. The form keeps the numbers as the text it loaded
 * (partner-draft.ts parses them on save), so this proves the save payload is
 * unchanged by the move: numbers arrive as numbers, an emptied box as null, a
 * switch as a boolean, and only the fields touched are sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('@/lib/api', () => ({
  api: {
    partners: { usage: () => Promise.resolve({ bid_group: [], partner_bid: [], latency_gate: [] }), workflowValues: () => Promise.resolve({ partner: { id: 'p', slug: 'p' }, values: [], searched: { workflows: 0, with_constants_node: 0 } }) },
    partnerUuids: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    partnerBidConfigs: { list: vi.fn() },
    buyerProfiles: { get: vi.fn(), usage: vi.fn() },
    buyerSales: { list: vi.fn(), settle: vi.fn() },
  },
}))

import PartnerForm from '../PartnerForm'
import { api } from '@/lib/api'
import type { Partner } from '@/lib/api'

const partner: Partner = {
  id: 'p1', organization_id: 'org-1', name: 'M1', slug: 'm1', api_endpoint: null, cf_secret_key: null, daily_cap: null, min_bid: 0.5,
  bid_formula: null, bid_resolver_type: 'api', bid_resolver_config: {}, outbound_field_mapping: null,
  bid_comparison_source: 'auto', extra_extraction: null, last_probe_response: null, dedup_endpoint: null, response_classification: null,
  alert_config: null, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 300, circuit_enabled: true,
  confirmation_window_ms: null, is_active: true, priority: 0, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null,
  sub_account_min_bids: null, partner_type: 'buyer', created_at: '', updated_at: '2026-10-15T14:00:00Z', updated_by_email: null, updated_by_name: null,
  version: 3,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.partnerUuids.list).mockResolvedValue([])
  vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([])
  vi.mocked(api.buyerProfiles.get).mockResolvedValue({ profile: null, accept_signals: [], other_sellers: [] })
  vi.mocked(api.buyerProfiles.usage).mockRejectedValue(Object.assign(new Error('usage_unavailable'), { status: 503 }))
  vi.mocked(api.buyerSales.list).mockResolvedValue({ entries: [], total: 0, page: 1, limit: 100 })
})

function renderForm() {
  const onSave = vi.fn().mockResolvedValue({ partner: { ...partner, version: 4 }, profile: null, copyWarning: null })
  render(<PartnerForm partner={partner} onSave={onSave} onCancel={vi.fn()} />)
  return onSave
}
const save = () => fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

// Every tab's panel stays mounted (#2137), so a control on a tab not open is
// found with hidden: true; which tab each is drawn on is tested in partner-tabs.
describe('the partner form on the shared controls (#2137)', () => {
  it('number boxes save numbers, an emptied box saves null, and a switch saves a boolean', async () => {
    const onSave = renderForm()
    expect(screen.getByLabelText('Minimum bid')).toHaveValue(0.5)
    fireEvent.change(screen.getByLabelText('Minimum bid'), { target: { value: '' } })
    fireEvent.change(within(screen.getByRole('region', { name: 'Circuit breaker', hidden: true })).getByLabelText('Errors'), { target: { value: '7' } })
    fireEvent.change(screen.getByLabelText('Confirmation window (ms)'), { target: { value: '5000' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Active', hidden: true }))
    fireEvent.click(screen.getByRole('switch', { name: 'Alert on errors that are retried', hidden: true }))
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const [body] = onSave.mock.calls[0]
    expect(body).toEqual({
      min_bid: null,
      circuit_error_threshold: 7,
      confirmation_window_ms: 5000,
      is_active: false,
      alert_config: { transient_errors: { alert: false }, permanent_errors: { alert: true } },
    })
  })

  it('a sub-account floor typed into the shared boxes saves as a number keyed by its UUID', async () => {
    const onSave = renderForm()
    // #2327: the floors' add link is named for what it adds, as the design draws it.
    fireEvent.click(screen.getByRole('button', { name: 'Add sub-account', hidden: true }))
    fireEvent.change(screen.getByLabelText('Sub-account UUID, floor 1'), { target: { value: '22222222-2222-2222-2222-222222222222' } })
    fireEvent.change(screen.getByLabelText('Minimum bid, floor 1'), { target: { value: '1.25' } })
    save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toEqual({ sub_account_min_bids: { '22222222-2222-2222-2222-222222222222': 1.25 } })
  })

  it('the switches are Radix switches with the shared class, and Does is two shared checkboxes', () => {
    renderForm()
    for (const name of ['Active', 'Circuit breaker', 'Alert on errors that are retried', 'Alert on errors that are not retried']) {
      expect(screen.getByRole('switch', { name, hidden: true })).toHaveClass('toggle')
    }
    // What a partner does is two boxes now (#2323), not a radio group.
    expect(screen.getByRole('checkbox', { name: 'Buys leads', hidden: true })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Buys leads', hidden: true })).toBeChecked()
  })
})
