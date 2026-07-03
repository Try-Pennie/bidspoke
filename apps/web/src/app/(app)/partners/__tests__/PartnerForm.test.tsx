import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/lib/api', () => ({
  api: {
    partnerUuids: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    partnerBidConfigs: { list: vi.fn() },
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
  bid_mode: 'commit',
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
