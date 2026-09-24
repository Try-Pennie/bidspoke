/**
 * The usage panel (#1412): the counted total against each cap with its
 * breakdown (accepted, in flight, unresolved), from the same counted() the
 * refusal uses (L16); a positive statement on a healthy day (L610); the scope
 * stated with the other sellers named beside their count (L582, L287); and a
 * ledger that could not be read shown as unreadable, never as zeros (L633).
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BuyerUsagePanel, type BuyerUsage } from '../BuyerUsagePanel'
import type { CapsValue } from '../CapsGrid'

const usage: BuyerUsage = {
  sold_on: 'offer',
  et_day: '2027-09-20',
  hour_bucket: 505_935,
  hour: { leads: 7, spend_cents: 15_330 },
  day: { leads: 42, spend_cents: 91_980, by_status: { reserved: 1, accepted: 40, declined: 5, released: 2, unresolved: 1 } },
  counted_populations: ['engine'],
  outside_wins_today: 3,
  unmeasured: [],
}
const caps: CapsValue = { hourly_lead_cap: null, daily_lead_cap: 500, hourly_spend_cap_cents: null, daily_spend_cap_cents: 100_000 }

describe('BuyerUsagePanel', () => {
  it('shows each capped quantity as counted against its cap, and an uncapped one as counted with no cap', () => {
    render(<BuyerUsagePanel usage={usage} error={null} caps={caps} otherSellers={[]} partnerName="Tripoint" />)
    expect(screen.getByText('42 of 500 leads today')).toBeInTheDocument()
    expect(screen.getByText('$919.80 of $1,000.00 today')).toBeInTheDocument()
    expect(screen.getByText('7 leads this hour, no cap')).toBeInTheDocument()
  })

  it('shows the breakdown the total is made of', () => {
    render(<BuyerUsagePanel usage={usage} error={null} caps={caps} otherSellers={[]} partnerName="Tripoint" />)
    expect(screen.getByText(/40 accepted, 1 in flight, 1 unresolved/)).toBeInTheDocument()
  })

  it('states a healthy day positively when nothing is near a cap, and says so when one is', () => {
    const roomy: CapsValue = { ...caps, daily_spend_cap_cents: 500_000 }
    const { unmount } = render(<BuyerUsagePanel usage={usage} error={null} caps={roomy} otherSellers={[]} partnerName="Tripoint" />)
    expect(screen.getByText(/room under every cap/i)).toBeInTheDocument()
    unmount()
    // $919.80 of $1,000.00 is within reach of the daily spend cap.
    render(<BuyerUsagePanel usage={usage} error={null} caps={caps} otherSellers={[]} partnerName="Tripoint" />)
    expect(screen.getByText(/a cap is within reach today/i)).toBeInTheDocument()
  })

  it('says which day the counts are for, without restating the time zone the caps already state (L605)', () => {
    render(<BuyerUsagePanel usage={usage} error={null} caps={caps} otherSellers={[]} partnerName="Tripoint" />)
    expect(screen.getByText(/Counted for 2027-09-20/)).toBeInTheDocument()
    expect(screen.queryByText(/eastern/i)).toBeNull()
  })

  it('names the other sellers beside their count when there are any, and says nothing about them otherwise', () => {
    const { rerender } = render(<BuyerUsagePanel usage={usage} error={null} caps={caps} otherSellers={[{ id: 'wf', name: 'Main Flow' }]} partnerName="Tripoint" />)
    expect(screen.getByText(/Main Flow also sells to Tripoint\. Those 3 sales today are not counted here\./)).toBeInTheDocument()
    rerender(<BuyerUsagePanel usage={usage} error={null} caps={caps} otherSellers={[]} partnerName="Tripoint" />)
    expect(screen.queryByText(/also sells to/)).toBeNull()
  })

  it('an unreadable ledger is its own state with no numbers, and an unmeasured count is named', () => {
    const { rerender } = render(<BuyerUsagePanel usage={null} error="The buyer ledger did not answer, so the counts cannot be shown." caps={caps} otherSellers={[]} partnerName="Tripoint" />)
    expect(screen.getByRole('alert')).toHaveTextContent(/did not answer/)
    expect(screen.queryByText(/of 500 leads/)).toBeNull()
    rerender(<BuyerUsagePanel usage={{ ...usage, outside_wins_today: null, unmeasured: ['outside_wins_today'] }} error={null} caps={caps} otherSellers={[{ id: 'wf', name: 'Main Flow' }]} partnerName="Tripoint" />)
    expect(screen.getByText(/Main Flow also sells to Tripoint\. Today's count of those sales could not be read\./)).toBeInTheDocument()
  })
})
