import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('@/lib/api', () => ({
  api: {
    partnerBidConfigs: {
      get: vi.fn(),
      sync: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
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

  it('a delete with no answer re-reads the matrices: still there, it says so and offers the delete again', async () => {
    vi.mocked(api.partnerBidConfigs.delete).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([config])
    const { dialog, onConfigsChange } = await openDelete()
    fireEvent.click(screen.getByRole('button', { name: 'Delete matrix' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The delete got no answer, and the matrix is still there. Delete it again, or keep it.')
    expect(api.partnerBidConfigs.list).toHaveBeenCalledWith('p-1')
    expect(onConfigsChange).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('button', { name: 'Delete matrix' })).toBeEnabled()
  })

  it('a delete with no answer whose matrix is gone on the re-read counts as deleted', async () => {
    vi.mocked(api.partnerBidConfigs.delete).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.mocked(api.partnerBidConfigs.list).mockResolvedValue([])
    const { onConfigsChange } = await openDelete()
    fireEvent.click(screen.getByRole('button', { name: 'Delete matrix' }))
    await waitFor(() => expect(onConfigsChange).toHaveBeenCalledWith([]))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('a delete with no answer and a re-read that fails says it may or may not be deleted, never that nothing was (L11)', async () => {
    vi.mocked(api.partnerBidConfigs.delete).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.mocked(api.partnerBidConfigs.list).mockRejectedValue(new TypeError('Failed to fetch'))
    const { dialog } = await openDelete()
    fireEvent.click(screen.getByRole('button', { name: 'Delete matrix' }))
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent(/may or may not be deleted/)
    expect(alert).not.toHaveTextContent(/Not deleted/)
  })

  it('a back gesture while the delete is in flight keeps the dialog until the delete answers, so its outcome is never hidden', async () => {
    let finish: () => void = () => {}
    vi.mocked(api.partnerBidConfigs.delete).mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ ok: true }) }))
    const { onConfigsChange } = await openDelete()
    fireEvent.click(screen.getByRole('button', { name: 'Delete matrix' }))
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    finish()
    await waitFor(() => expect(onConfigsChange).toHaveBeenCalledWith([]))
    expect(screen.queryByRole('alertdialog')).toBeNull()
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

  it('after a delete the next matrix shows its own rows, never the deleted one\'s, whichever way the delete was confirmed', async () => {
    const second = { ...config, id: 'cfg-2', name: 'sofi spare', is_default: false } as unknown as PartnerBidConfig
    const secondRows = [rows[0], rows[1], { ...rows[1], id: 'r3', row_low: 20000 }]
    for (const confirmed of ['answered', 'gone on re-read'] as const) {
      vi.mocked(api.partnerBidConfigs.get).mockImplementation(async (id: string) => ({ config: id === 'cfg-1' ? config : second, rows: id === 'cfg-1' ? rows : secondRows }) as never)
      if (confirmed === 'answered') vi.mocked(api.partnerBidConfigs.delete).mockResolvedValueOnce({ ok: true })
      else {
        vi.mocked(api.partnerBidConfigs.delete).mockRejectedValueOnce(new TypeError('Failed to fetch'))
        vi.mocked(api.partnerBidConfigs.list).mockResolvedValueOnce([second])
      }
      function Host() {
        const [configs, setConfigs] = useState([config, second])
        return <BidMatrixViewer partnerId="p-1" partnerSlug="sofi" configs={configs} onConfigsChange={setConfigs} />
      }
      const { unmount } = render(<Host />)
      await screen.findByText('Standard rows (2)')
      fireEvent.click(screen.getByRole('button', { name: 'Delete this matrix' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Delete matrix' }))
      expect(await screen.findByText('Standard rows (3)'), confirmed).toBeInTheDocument()
      expect(screen.queryByText('Standard rows (2)')).toBeNull()
      expect(screen.queryByRole('alertdialog')).toBeNull()
      unmount()
    }
  })
})

// #2217: a rows read that failed rendered the empty state, "No rows yet", so a
// load failure read as a matrix with no rows (L10). The read now has three
// states of its own: loading, failed with Try again, and empty.
describe('BidMatrixViewer: the rows read has loading, failed and empty states (#2217)', () => {
  const rows = [
    { id: 'r1', config_id: 'cfg-1', is_sell_off: false, row_low: 0, row_high: 9999, range_low: 600, range_high: 699, bid_amount: 10 },
  ]

  it('while the read is in flight it says it is loading, never that there are no rows', async () => {
    vi.mocked(api.partnerBidConfigs.get).mockImplementation(() => new Promise(() => {}))
    renderViewer()
    expect(await screen.findByRole('status', { name: 'Loading the matrix rows' })).toBeInTheDocument()
    expect(screen.queryByText(/No rows yet/)).toBeNull()
  })

  it('a rejected read shows the error and why, never "No rows yet", and Try again reads again', async () => {
    vi.mocked(api.partnerBidConfigs.get).mockRejectedValueOnce(Object.assign(new Error('partner bid config read failed'), { status: 500 }))
    vi.mocked(api.partnerBidConfigs.get).mockResolvedValueOnce({ config, rows } as never)
    renderViewer()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("This matrix's rows could not be loaded.")
    expect(alert).toHaveTextContent('partner bid config read failed')
    expect(alert).toHaveTextContent('Nothing has changed.')
    expect(screen.queryByText(/No rows yet/)).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Standard rows (1)')).toBeInTheDocument()
    expect(api.partnerBidConfigs.get).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a read that ran out of time says the server did not answer within 30 seconds', async () => {
    vi.mocked(api.partnerBidConfigs.get).mockRejectedValue(Object.assign(new Error('Timed out after 30s. It may still be processing. Check execution history before retrying.'), { timedOut: true }))
    renderViewer()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The server did not answer within 30 seconds.')
    expect(alert).not.toHaveTextContent(/execution history/)
  })

  it('a read that answers with no rows is the empty state', async () => {
    renderViewer()
    expect(await screen.findByText(/No rows yet/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// #2217: deleting the matrix the partner's resolver points at left
// bid_config_id naming the deleted matrix, and the selectedConfigId effect put
// the deleted id back on screen. The page draft is now cleared to "No matrix",
// so the save sends it and the unsaved state shows it.
describe('BidMatrixViewer: deleting the matrix the partner uses (#2217)', () => {
  const second = { ...config, id: 'cfg-2', name: 'sofi spare', is_default: false } as unknown as PartnerBidConfig

  /** Wired the way PartnerForm wires it: the resolver config is the page draft. */
  function Host({ initial, onDraft }: { initial: string | null; onDraft: (cfg: Record<string, unknown>) => void }) {
    const [configs, setConfigs] = useState([config, second])
    const [resolverConfig, setResolverConfig] = useState<Record<string, unknown>>({ bid_config_id: initial })
    return (
      <BidMatrixViewer
        partnerId="p-1"
        partnerSlug="sofi"
        configs={configs}
        onConfigsChange={setConfigs}
        selectedConfigId={typeof resolverConfig.bid_config_id === 'string' ? resolverConfig.bid_config_id : undefined}
        onSelectConfig={(id) => { const next = { ...resolverConfig, bid_config_id: id }; setResolverConfig(next); onDraft(next) }}
      />
    )
  }

  async function deleteShown() {
    fireEvent.click(screen.getByRole('button', { name: 'Delete this matrix' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete matrix' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  }

  it('clears the draft to no matrix, and never shows or reads the deleted matrix again', async () => {
    vi.mocked(api.partnerBidConfigs.delete).mockResolvedValue({ ok: true })
    const onDraft = vi.fn()
    render(<Host initial="cfg-1" onDraft={onDraft} />)
    await screen.findByText(/No rows yet/)
    await deleteShown()
    expect(onDraft).toHaveBeenLastCalledWith({ bid_config_id: null })
    expect(screen.getByRole('combobox', { name: 'Matrix shown' })).toHaveTextContent('No matrix')
    expect(screen.queryByText(/no longer available/)).toBeNull()
    // The read before the delete is the only read of cfg-1: nothing reads the deleted matrix after it.
    expect(vi.mocked(api.partnerBidConfigs.get).mock.calls.filter(([id]) => id === 'cfg-1')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Delete this matrix' })).toBeDisabled()
  })

  it('deleting a matrix the partner does not use leaves the draft alone', async () => {
    vi.mocked(api.partnerBidConfigs.delete).mockResolvedValue({ ok: true })
    const onDraft = vi.fn()
    render(<Host initial={null} onDraft={onDraft} />)
    await screen.findByText(/No rows yet/)
    await deleteShown()
    expect(onDraft).not.toHaveBeenCalled()
  })
})
