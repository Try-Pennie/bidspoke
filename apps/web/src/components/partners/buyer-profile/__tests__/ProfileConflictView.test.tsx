/**
 * The 409 side by side (#1412, L717, L608): the save was refused because the
 * profile changed underneath the person. The view names each field that
 * differs, keeps every edit they typed, and offers two actions. It never
 * discards their edits by instruction.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { BuyerProfileDocument } from '@bidspoke/buyer-profile'
import { ProfileConflictView } from '../ProfileConflictView'

const mine: BuyerProfileDocument = {
  partner_id: 'p', version: 3, sold_on: 'offer', is_enabled: true, priority: 1, allowed_states: ['TX'],
  debt_min: 15000, debt_max: null, loan_amount_min: null,
  hourly_lead_cap: null, daily_lead_cap: 500, hourly_spend_cap_cents: null, daily_spend_cap_cents: null,
  windows: [], blackout_dates: [], tiers: [],
}
const theirs: BuyerProfileDocument = { ...mine, version: 4, daily_lead_cap: 250, allowed_states: ['TX', 'FL'] }

describe('ProfileConflictView', () => {
  it('says who changed it and names each field that differs with both values', () => {
    render(<ProfileConflictView mine={mine} theirs={theirs} changedBy="Geoff" onSaveOverTheirs={() => {}} onTakeTheirs={() => {}} />)
    expect(screen.getByRole('alertdialog', { name: /saved by someone else/i })).toHaveTextContent(/Geoff/)
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/Leads per day.*500.*250/),
      expect.stringMatching(/States.*TX.*FL, TX/),
    ])
  })

  it('offers Save over theirs with the new version and Take theirs with their document', () => {
    const over = vi.fn()
    const take = vi.fn()
    render(<ProfileConflictView mine={mine} theirs={theirs} changedBy={null} onSaveOverTheirs={over} onTakeTheirs={take} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save over theirs' }))
    expect(over).toHaveBeenCalledWith(4)
    fireEvent.click(screen.getByRole('button', { name: 'Take theirs' }))
    expect(take).toHaveBeenCalledWith(theirs)
  })

  it('has no third action that discards the edits', () => {
    render(<ProfileConflictView mine={mine} theirs={theirs} changedBy={null} onSaveOverTheirs={() => {}} onTakeTheirs={() => {}} />)
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Save over theirs', 'Take theirs'])
  })
})
