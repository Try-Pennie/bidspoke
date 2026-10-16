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

describe('click delivery in the history (#1639)', () => {
  it('shows a moved route and a changed success reply with old and new values, keyed as save_buyer_profile writes them', () => {
    render(<BuyerProfileHistory entries={[{
      changed_at: '2027-09-29T20:00:00.000Z', changed_by: 'Dan', action: 'updated',
      changes: {
        'click_delivery.routes[DV1]': { old: { url: 'https://a.example/dv1', states: ['OR', 'WA'] }, new: { url: 'https://b.example/dv1', states: ['OR', 'WA'] } },
        'click_delivery.success_pattern': { old: null, new: '(?<id>\\w+)' },
      },
    }]} />)
    expect(screen.getByText('Route DV1: https://a.example/dv1 for OR, WA to https://b.example/dv1 for OR, WA')).toBeInTheDocument()
    expect(screen.getByText('Success reply: none to (?<id>\\w+)')).toBeInTheDocument()
  })
})

describe('rows as audit_log holds them (#1672)', () => {
  it('reads the dotted paths buyer_profile_flatten writes, from a real hours move and a real pricing edit', () => {
    render(<BuyerProfileHistory entries={[{
      changed_at: '2026-10-01T23:32:19.553Z', changed_by: 'Dan', action: 'updated',
      changes: {
        'windows.1.660': { old: 1260, new: null },
        'windows.1.540': { old: null, new: 1260 },
        'tiers.engine.10000.multiplier': { old: null, new: 0.0009 },
        'tiers.engine.10000.debt_to': { old: null, new: 12500 },
      },
    }]} />)
    expect(screen.getByText('Monday hours from 11:00 AM: open until 9:00 PM to none')).toBeInTheDocument()
    expect(screen.getByText('Monday hours from 9:00 AM: none to open until 9:00 PM')).toBeInTheDocument()
    expect(screen.getByText('Engine tier from $10,000 multiplier: none to 0.0009')).toBeInTheDocument()
    expect(screen.getByText('Engine tier from $10,000 upper bound: none to $12,500.00')).toBeInTheDocument()
  })
})

describe('bookkeeping keys beside the paths (#2133)', () => {
  it('shows the changed paths of a page save and of a legacy route save, and never their _actor or _route keys as fields', () => {
    render(<BuyerProfileHistory entries={[
      { changed_at: '2027-10-16T15:00:00.000Z', changed_by: 'Dan', action: 'updated', changes: { daily_lead_cap: { old: 250, new: 500 }, _actor: { name: 'Dan Wright', email: 'dan@example.test' } } as unknown as HistoryEntry['changes'] },
      { changed_at: '2027-10-16T14:00:00.000Z', changed_by: 'Dan', action: 'updated', changes: { daily_lead_cap: { old: 100, new: 250 }, _route: 'legacy_buyer_profile' } as unknown as HistoryEntry['changes'] },
    ]} />)
    expect(screen.getByText('Leads per day: 250 to 500')).toBeInTheDocument()
    expect(screen.getByText('Leads per day: 100 to 250')).toBeInTheDocument()
    expect(screen.queryByText(/_actor|_route|legacy_buyer_profile/)).toBeNull()
    // One line for who and when, one for the one changed path.
    expect(screen.getAllByRole('listitem').map((li) => li.querySelectorAll('p').length)).toEqual([2, 2])
  })
})
