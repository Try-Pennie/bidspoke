import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/lib/api', () => ({
  api: {
    partnerBidConfigs: {
      get: vi.fn(),
      sync: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  },
}))

import { BidMatrixViewer } from '../BidMatrixViewer'
import { api } from '@/lib/api'
import type { PartnerBidConfig } from '@/lib/api'

const config = {
  id: 'cfg-1',
  name: 'sofi default',
  is_default: true,
  is_active: true,
  sync_source: 'salesforce',
  last_synced_at: '2026-06-19T00:00:00Z',
  last_sync_error: null,
  dimensions: [
    { name: 'vantage_score', payload_field: 'vantage_score', column: 'range' },
    { name: 'debt_amount', payload_field: 'debt_amount', column: 'row' },
  ],
} as unknown as PartnerBidConfig

function renderViewer() {
  return render(
    <BidMatrixViewer
      partnerId="p-1"
      partnerSlug="sofi"
      configs={[config]}
      onConfigsChange={vi.fn()}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.partnerBidConfigs.get).mockResolvedValue({ config, rows: [] } as never)
})

describe('BidMatrixViewer — sync problems (#208)', () => {
  it('surfaces overlap/gap problems returned by a manual Sync now', async () => {
    vi.mocked(api.partnerBidConfigs.sync).mockResolvedValue({
      config_id: 'cfg-1', config_slug: 'sofi', rows_fetched: 3,
      rows_upserted: 3, rows_deleted: 0, last_synced_at: '2026-06-19T01:00:00Z',
      problems: [
        { kind: 'overlap', axis: 'range', is_sell_off: false, detail: 'score 700-719 overlaps 710-729' },
        { kind: 'gap', axis: 'range', is_sell_off: false, detail: 'no coverage for score between 740 and 759' },
      ],
    } as never)

    renderViewer()
    fireEvent.click(await screen.findByRole('button', { name: /Sync now/ }))

    expect(await screen.findByText(/700-719 overlaps 710-729/)).toBeInTheDocument()
    expect(screen.getByText(/no coverage for score between 740 and 759/)).toBeInTheDocument()
  })

  it('shows no problem banner when the sync comes back clean', async () => {
    vi.mocked(api.partnerBidConfigs.sync).mockResolvedValue({
      config_id: 'cfg-1', config_slug: 'sofi', rows_fetched: 3,
      rows_upserted: 3, rows_deleted: 0, last_synced_at: '2026-06-19T01:00:00Z',
      problems: [],
    } as never)

    renderViewer()
    fireEvent.click(await screen.findByRole('button', { name: /Sync now/ }))
    await waitFor(() => expect(api.partnerBidConfigs.sync).toHaveBeenCalled())
    expect(screen.queryByText(/overlap|no coverage/i)).not.toBeInTheDocument()
  })
})
