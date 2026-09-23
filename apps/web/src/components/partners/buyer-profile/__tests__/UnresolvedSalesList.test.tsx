/**
 * The unresolved list (#1412, L269, L180): every sale nobody could classify,
 * with its own settle controls, each confirmation naming the specific
 * consequence of that row (counts as sold to this buyer for this amount today,
 * against frees one slot), and the outcome of a settle shown on the row.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { UnresolvedSalesList, type UnresolvedSale } from '../UnresolvedSalesList'

const rows: UnresolvedSale[] = [
  { id: 'sale-1', lead_key: 'lead-1', kind: 'live', payout_cents: 2190, reserved_at: '2027-09-20T15:30:00.000Z', http_status: 200, result_code: null, partner_name: 'Tripoint' },
  { id: 'sale-2', lead_key: 'lead-2', kind: 'live', payout_cents: 1800, reserved_at: '2027-09-20T16:02:00.000Z', http_status: 504, result_code: null, partner_name: 'Tripoint' },
]

describe('UnresolvedSalesList', () => {
  it('renders one row per sale with the lead, the payout, when it was reserved and what the buyer answered', () => {
    render(<UnresolvedSalesList rows={rows} total={2} onSettle={vi.fn()} outcomes={{}} />)
    const items = screen.getAllByRole('row').slice(1)
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('lead-1')
    expect(items[0]).toHaveTextContent('$21.90')
    expect(items[0]).toHaveTextContent('HTTP 200, no rule matched')
    expect(items[1]).toHaveTextContent('HTTP 504')
  })

  it('a confirmation names the consequence of the row it is on, then settles that row', async () => {
    const onSettle = vi.fn().mockResolvedValue(undefined)
    render(<UnresolvedSalesList rows={rows} total={2} onSettle={onSettle} outcomes={{}} />)
    const first = screen.getAllByRole('row')[1]
    fireEvent.click(within(first).getByRole('button', { name: /count as sold/i }))
    expect(within(first).getByText('Counts as sold to Tripoint for $21.90 today.')).toBeInTheDocument()
    fireEvent.click(within(first).getByRole('button', { name: /^confirm/i }))
    expect(onSettle).toHaveBeenCalledWith('sale-1', 'accepted')

    const second = screen.getAllByRole('row')[2]
    fireEvent.click(within(second).getByRole('button', { name: /free the slot/i }))
    expect(within(second).getByText('Frees one slot and counts nothing.')).toBeInTheDocument()
    fireEvent.click(within(second).getByRole('button', { name: /^confirm/i }))
    expect(onSettle).toHaveBeenCalledWith('sale-2', 'released')
  })

  it('offers the rest when the total is above the rows shown, and asks for them once (#1457)', () => {
    const onMore = vi.fn()
    render(<UnresolvedSalesList rows={rows} total={5} onSettle={vi.fn()} outcomes={{}} onMore={onMore} />)
    expect(screen.getByText('Showing 2 of 5 unresolved sales.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show 3 more' }))
    expect(onMore).toHaveBeenCalledTimes(1)
  })

  it('says it is loading the rest while more rows are on their way, and offers nothing when every row is shown', () => {
    const loading = render(<UnresolvedSalesList rows={rows} total={5} onSettle={vi.fn()} outcomes={{}} onMore={vi.fn()} loadingMore />)
    expect(screen.getByRole('button', { name: /show 3 more/i })).toBeDisabled()
    loading.unmount()
    render(<UnresolvedSalesList rows={rows} total={2} onSettle={vi.fn()} outcomes={{}} onMore={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /more/i })).toBeNull()
  })

  it('cancelling a confirmation settles nothing', () => {
    const onSettle = vi.fn()
    render(<UnresolvedSalesList rows={rows} total={2} onSettle={onSettle} outcomes={{}} />)
    const first = screen.getAllByRole('row')[1]
    fireEvent.click(within(first).getByRole('button', { name: /count as sold/i }))
    fireEvent.click(within(first).getByRole('button', { name: /cancel/i }))
    expect(onSettle).not.toHaveBeenCalled()
    expect(within(first).queryByText(/Counts as sold/)).toBeNull()
  })

  it('shows each row\'s own outcome: working, done with what happened, failed with why', () => {
    render(
      <UnresolvedSalesList
        rows={rows}
        total={2}
        onSettle={vi.fn()}
        outcomes={{
          'sale-1': { kind: 'working', label: 'Settling', startedAt: 0, now: 2_000 },
          'sale-2': { kind: 'failed', message: 'The buyer ledger did not answer, so nothing was settled.' },
        }}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent(/Settling/)
    expect(screen.getByRole('alert')).toHaveTextContent(/did not answer/)
  })

  it('a healthy day is a positive sentence, and a longer queue says how many more there are', () => {
    const { rerender } = render(<UnresolvedSalesList rows={[]} total={0} onSettle={vi.fn()} outcomes={{}} />)
    expect(screen.getByText(/nothing waiting on a person/i)).toBeInTheDocument()
    rerender(<UnresolvedSalesList rows={rows} total={23} onSettle={vi.fn()} outcomes={{}} />)
    expect(screen.getByText(/showing 2 of 23/i)).toBeInTheDocument()
  })
})
