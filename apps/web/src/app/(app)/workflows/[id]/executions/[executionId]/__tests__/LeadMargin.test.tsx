/**
 * The per-lead margin panel (#1160).
 *
 * Two numbers that run in OPPOSITE directions: winning_bid_cents is money in,
 * what a buyer paid us for the lead, and quoted_rate_cents is money out, what we
 * quoted the source that sent it. A reader seeing two dollar figures side by
 * side will otherwise take them for comparable amounts of the same thing, so the
 * surface has to say which is which rather than leave it to be inferred.
 *
 * An absent record and a lead that earned nothing are different states and must
 * read differently: executions are kept 7 days and lead_sightings roughly two,
 * so an execution in that gap has no figures at all and must not show a zero.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LeadMargin, marginCents } from '../LeadMargin'

describe('marginCents', () => {
  it('is the buyer bid less the quote', () => {
    expect(marginCents(333, 216)).toBe(117)
  })

  it('is negative when we quoted more than the buyer paid', () => {
    expect(marginCents(333, 400)).toBe(-67)
  })

  it('is zero when they match, which is not the same as unknown', () => {
    expect(marginCents(333, 333)).toBe(0)
  })

  it('is unknown when either side is missing, never treating the gap as zero', () => {
    // Treating an absent quote as zero would report the whole bid as profit.
    expect(marginCents(333, null)).toBeNull()
    expect(marginCents(null, 216)).toBeNull()
    expect(marginCents(null, null)).toBeNull()
  })
})

describe('LeadMargin panel', () => {
  it('renders nothing at all when there is no sighting record', () => {
    const { container } = render(<LeadMargin economics={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows both figures and the difference', () => {
    render(<LeadMargin economics={{ quoted_rate_cents: 216, winning_bid_cents: 333, margin_cents: 117, winning_partner_slug: 'lendswift' }} />)
    expect(screen.getByText('$3.33')).toBeInTheDocument()
    expect(screen.getByText('$2.16')).toBeInTheDocument()
    expect(screen.getByText('$1.17')).toBeInTheDocument()
  })

  it('says which way each number runs', () => {
    render(<LeadMargin economics={{ quoted_rate_cents: 216, winning_bid_cents: 333, margin_cents: 117, winning_partner_slug: 'lendswift' }} />)
    // Not "bid" and "rate" side by side: the direction is the whole point.
    expect(screen.getByText(/paid us/i)).toBeInTheDocument()
    expect(screen.getByText(/we quoted/i)).toBeInTheDocument()
  })

  it('names the buyer that paid, so the figure is attributable', () => {
    render(<LeadMargin economics={{ quoted_rate_cents: 216, winning_bid_cents: 333, margin_cents: 117, winning_partner_slug: 'lendswift' }} />)
    expect(screen.getByText(/lendswift/i)).toBeInTheDocument()
  })

  it('shows a negative margin as a loss rather than as a bare number', () => {
    render(<LeadMargin economics={{ quoted_rate_cents: 400, winning_bid_cents: 333, margin_cents: -67, winning_partner_slug: 'gigfi' }} />)
    expect(screen.getByText('-$0.67')).toBeInTheDocument()
  })

  it('says a missing figure is not recorded, rather than showing a zero', () => {
    render(<LeadMargin economics={{ quoted_rate_cents: null, winning_bid_cents: 333, margin_cents: null, winning_partner_slug: 'lendswift' }} />)
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
    expect(screen.getAllByText(/not recorded/i).length).toBeGreaterThan(0)
  })

  it('renders when the lead genuinely earned nothing, distinct from having no record', () => {
    render(<LeadMargin economics={{ quoted_rate_cents: 0, winning_bid_cents: 0, margin_cents: 0, winning_partner_slug: null }} />)
    expect(screen.getAllByText('$0.00').length).toBeGreaterThan(0)
  })
})
