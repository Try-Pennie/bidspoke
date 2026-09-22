/**
 * The history list (#1412, L46): one entry per save, who and when, each changed
 * path old to new in the form's own labels.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BuyerProfileHistory, type HistoryEntry } from '../BuyerProfileHistory'

const entries: HistoryEntry[] = [
  { changed_at: '2027-09-20T15:30:00.000Z', changed_by: 'Geoff', action: 'updated', changes: { daily_lead_cap: { old: 250, new: 500 }, 'tiers[engine:30000]': { old: null, new: { population: 'engine', debt_from: 30000, debt_to: null, multiplier: 0.001 } } } },
  { changed_at: '2027-09-19T10:00:00.000Z', changed_by: null, action: 'created', changes: { is_enabled: { old: null, new: false } } },
]

describe('BuyerProfileHistory', () => {
  it('renders one entry per save, newest first, with who and when', () => {
    render(<BuyerProfileHistory entries={entries} />)
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent(/Geoff/)
    expect(items[0]).toHaveTextContent(/updated/)
    expect(items[1]).toHaveTextContent(/created/)
  })

  it('names each changed path in the form\'s words, old to new', () => {
    render(<BuyerProfileHistory entries={entries} />)
    expect(screen.getByText('Leads per day: 250 to 500')).toBeInTheDocument()
    expect(screen.getByText(/Engine tier from \$30,000: none to 0\.001 with no upper bound/)).toBeInTheDocument()
  })

  it('an empty history is a sentence, not a blank', () => {
    render(<BuyerProfileHistory entries={[]} />)
    expect(screen.getByText(/never been saved/i)).toBeInTheDocument()
  })
})
