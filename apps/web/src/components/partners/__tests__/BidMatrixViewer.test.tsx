import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

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

// #2134: deleting a matrix was the browser's bare confirm(), which said nothing
// about what goes with it. It is now the one Dialog shell, whose consequence is
// derived from what is stored (L180), and every incidental dismissal keeps it.
describe('BidMatrixViewer: deleting a matrix (#2134)', () => {
  const rows = [
    { id: 'r1', config_id: 'cfg-1', is_sell_off: false, row_low: 0, row_high: 9999, range_low: 600, range_high: 699, bid_amount: 10 },
    { id: 'r2', config_id: 'cfg-1', is_sell_off: false, row_low: 10000, row_high: null, range_low: 600, range_high: 699, bid_amount: 20 },
  ]

  async function openDelete(onConfigsChange = vi.fn()) {
    vi.mocked(api.partnerBidConfigs.get).mockResolvedValue({ config, rows } as never)
    render(<BidMatrixViewer partnerId="p-1" partnerSlug="sofi" configs={[config]} onConfigsChange={onConfigsChange} />)
    await screen.findByText('Standard rows (2)')
    fireEvent.click(screen.getByRole('button', { name: 'Delete this matrix' }))
    return { dialog: await screen.findByRole('alertdialog', { name: 'Delete matrix "sofi default"?' }), onConfigsChange }
  }

  it('names the matrix and its row count, and says what comes back and what does not', async () => {
    const { dialog } = await openDelete()
    expect(dialog).toHaveAccessibleDescription('Its 2 rows and its change history are deleted with it. Salesforce still holds the rows, so adding a matrix and syncing brings them back; the history does not come back.')
    expect(screen.getByRole('button', { name: 'Keep matrix' })).toHaveFocus()
  })

  it('Escape deletes nothing', async () => {
    const { dialog, onConfigsChange } = await openDelete()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.partnerBidConfigs.delete).not.toHaveBeenCalled()
    expect(onConfigsChange).not.toHaveBeenCalled()
  })

  it('Delete matrix deletes it and takes it off the list', async () => {
    vi.mocked(api.partnerBidConfigs.delete).mockResolvedValue({ ok: true })
    const { onConfigsChange } = await openDelete()
    fireEvent.click(screen.getByRole('button', { name: 'Delete matrix' }))
    await waitFor(() => expect(onConfigsChange).toHaveBeenCalledWith([]))
    expect(api.partnerBidConfigs.delete).toHaveBeenCalledWith('cfg-1')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('a delete the server refuses says nothing was deleted, in the dialog, and keeps the matrix', async () => {
    vi.mocked(api.partnerBidConfigs.delete).mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }))
    const { dialog, onConfigsChange } = await openDelete()
    fireEvent.click(screen.getByRole('button', { name: 'Delete matrix' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/^Not deleted:/)
    expect(onConfigsChange).not.toHaveBeenCalled()
  })

  it('a delete with no answer says it may or may not have happened, never that nothing was deleted (L11)', async () => {
    vi.mocked(api.partnerBidConfigs.delete).mockRejectedValue(new TypeError('Failed to fetch'))
    const { dialog } = await openDelete()
    fireEvent.click(screen.getByRole('button', { name: 'Delete matrix' }))
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent(/may or may not be deleted/)
    expect(alert).not.toHaveTextContent(/Not deleted/)
  })

  it('two presses before the first one renders send one delete', async () => {
    let finish: () => void = () => {}
    vi.mocked(api.partnerBidConfigs.delete).mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ ok: true }) }))
    await openDelete()
    const button = screen.getByRole('button', { name: 'Delete matrix' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(api.partnerBidConfigs.delete).toHaveBeenCalledTimes(1)
    finish()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('when the rows could not be read, the consequence does not claim a count', async () => {
    vi.mocked(api.partnerBidConfigs.get).mockRejectedValue(new Error('API 500'))
    render(<BidMatrixViewer partnerId="p-1" partnerSlug="sofi" configs={[config]} onConfigsChange={vi.fn()} />)
    await waitFor(() => expect(api.partnerBidConfigs.get).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Delete this matrix' }))
    expect(await screen.findByRole('alertdialog')).toHaveAccessibleDescription(/^Its rows and its change history are deleted with it\./)
  })
})
