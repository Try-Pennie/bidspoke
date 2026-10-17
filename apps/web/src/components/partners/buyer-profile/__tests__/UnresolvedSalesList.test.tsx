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
  // #2325, PM-22: cards like the held clicks, with a lead sentence, each button
  // followed by what it does before it is pressed, Free the slot destructive at rest.
  it('renders a card per sale under a lead sentence: the lead, when it was reserved, the payout and what the buyer answered', () => {
    render(<UnresolvedSalesList rows={rows} total={2} onSettle={vi.fn()} outcomes={{}} />)
    expect(screen.getByText('2 sales have no outcome. Each slot stays reserved until a person settles it.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('lead-1')
    expect(items[0]).toHaveTextContent('$21.90')
    expect(items[0]).toHaveTextContent('Tripoint answered HTTP 200, no rule matched.')
    expect(items[1]).toHaveTextContent('Tripoint answered HTTP 504.')
  })

  it('says when each slot was reserved in the profile\'s display zone, naming it', () => {
    const { rerender } = render(<UnresolvedSalesList rows={[rows[0]]} total={1} onSettle={vi.fn()} outcomes={{}} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('Sep 20, 11:30 AM EDT')
    rerender(<UnresolvedSalesList rows={[rows[0]]} total={1} onSettle={vi.fn()} outcomes={{}} zone="America/Los_Angeles" />)
    expect(screen.getByRole('listitem')).toHaveTextContent('Sep 20, 8:30 AM PDT')
    // An unreadable time is shown as given, never as a made up date (formatInZone's own guard).
    rerender(<UnresolvedSalesList rows={[{ ...rows[0], reserved_at: 'undefined' }]} total={1} onSettle={vi.fn()} outcomes={{}} />)
    expect(within(screen.getByRole('listitem')).getByText('undefined')).toBeInTheDocument()
  })

  it('says what each button does before it is pressed, and Free the slot looks destructive', () => {
    render(<UnresolvedSalesList rows={[rows[0]]} total={1} onSettle={vi.fn()} outcomes={{}} />)
    expect(screen.getByText('1 sale has no outcome. Its slot stays reserved until a person settles it.')).toBeInTheDocument()
    expect(screen.getByText('Tripoint has it. Counts as sold for $21.90 today.')).toBeInTheDocument()
    expect(screen.getByText('Tripoint does not have it. Frees one slot and counts nothing.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Free the slot' }).className).toMatch(/btn-danger/)
    expect(screen.getByRole('button', { name: 'Count as sold' }).className).not.toMatch(/btn-danger/)
  })

  it('a sale no answer arrived for says so in a sentence of its own', () => {
    render(<UnresolvedSalesList rows={[{ ...rows[0], http_status: null }]} total={1} onSettle={vi.fn()} outcomes={{}} />)
    expect(screen.getByText('No answer arrived from Tripoint.')).toBeInTheDocument()
  })

  it('a confirmation names the consequence of the card it is on, then settles that sale', async () => {
    const onSettle = vi.fn().mockResolvedValue(undefined)
    render(<UnresolvedSalesList rows={rows} total={2} onSettle={onSettle} outcomes={{}} />)
    const first = screen.getAllByRole('listitem')[0]
    fireEvent.click(within(first).getByRole('button', { name: /count as sold/i }))
    expect(within(first).getByText('Counts as sold to Tripoint for $21.90 today.')).toBeInTheDocument()
    fireEvent.click(within(first).getByRole('button', { name: /^confirm/i }))
    expect(onSettle).toHaveBeenCalledWith('sale-1', 'accepted')

    const second = screen.getAllByRole('listitem')[1]
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
    const first = screen.getAllByRole('listitem')[0]
    fireEvent.click(within(first).getByRole('button', { name: /count as sold/i }))
    fireEvent.click(within(first).getByRole('button', { name: /cancel/i }))
    expect(onSettle).not.toHaveBeenCalled()
    expect(within(first).queryByText(/^Counts as sold/)).toBeNull()
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
