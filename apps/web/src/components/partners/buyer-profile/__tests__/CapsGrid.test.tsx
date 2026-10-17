/**
 * The caps grid (#1412): four caps, an empty box is no cap (null, never 0), spend
 * caps are typed in dollars and stored in cents, and the grid states its scope
 * once from the wired populations (L582, L287).
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CapsGrid, type CapsValue } from '../CapsGrid'

const none: CapsValue = { hourly_lead_cap: null, daily_lead_cap: null, hourly_spend_cap_cents: null, daily_spend_cap_cents: null }

describe('CapsGrid', () => {
  // #2325: an offer buyer's caps are a table, Leads and Spend by Per hour and Per
  // day; spend is a money box ("$" beside it, grouped at rest), so it reads text.
  it('renders four labelled controls in a table, empty when there is no cap, reading No cap', () => {
    render(<CapsGrid value={none} onChange={() => {}} />)
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Leads', 'Spend'])
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Per hour', 'Per day'])
    for (const label of ['Leads per hour', 'Leads per day']) expect(screen.getByLabelText(label)).toHaveValue(null)
    for (const label of ['Spend per hour', 'Spend per day']) expect(screen.getByLabelText(label)).toHaveValue('')
    for (const label of ['Leads per hour', 'Leads per day', 'Spend per hour', 'Spend per day']) expect(screen.getByLabelText(label)).toHaveAttribute('placeholder', 'No cap')
  })

  it('shows spend caps in dollars and emits cents', () => {
    const onChange = vi.fn()
    render(<CapsGrid value={{ ...none, daily_spend_cap_cents: 1_000_000 }} onChange={onChange} />)
    expect(screen.getByLabelText('Spend per day')).toHaveValue('10,000')
    fireEvent.change(screen.getByLabelText('Spend per hour'), { target: { value: '1250.50' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...none, daily_spend_cap_cents: 1_000_000, hourly_spend_cap_cents: 125_050 })
  })

  it('clearing a box emits null for that cap, never zero', () => {
    const onChange = vi.fn()
    render(<CapsGrid value={{ ...none, daily_lead_cap: 500 }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Leads per day'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith(none)
  })

  // #2325: the note is the design's: the "$" beside each spend box says the unit.
  it('states the scope and the empty rule once each, not once per box (L605)', () => {
    render(<CapsGrid value={none} onChange={() => {}} />)
    expect(screen.getByText('An empty box is no cap. Counts Engine leads sold through buyer selection. Hours and days are Eastern.')).toBeInTheDocument()
    expect(screen.getAllByText(/empty/i)).toHaveLength(1)
    expect(screen.getAllByText('$')).toHaveLength(2)
  })

  // #1541: a click buyer is capped by clicks per day and by nothing else.
  it('for a click buyer renders only the daily cap, labelled clicks per day, with no buyer selection scope or dollars', () => {
    const onChange = vi.fn()
    render(<CapsGrid value={{ ...none, daily_lead_cap: 50 }} onChange={onChange} soldOn="click" />)
    expect(screen.getByLabelText('Clicks per day')).toHaveValue(50)
    for (const label of ['Leads per hour', 'Leads per day', 'Spend per hour', 'Spend per day']) expect(screen.queryByLabelText(label)).toBeNull()
    expect(screen.queryByText(/buyer selection/i)).toBeNull()
    expect(screen.queryByText(/dollars/i)).toBeNull()
    fireEvent.change(screen.getByLabelText('Clicks per day'), { target: { value: '60' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...none, daily_lead_cap: 60 })
  })

  // #2324, PM-21: the click buyer's cap as the settled design draws it, a narrow
  // box with the count beside it and one hint naming the buyer. The old note
  // ("Once the clicks in a day reach it...") is gone.
  it('a click buyer\'s box is narrow, with the count beside it and one hint naming the buyer', () => {
    render(<CapsGrid value={{ ...none, daily_lead_cap: 50 }} onChange={() => {}} soldOn="click" partnerName="Liberty1" meter={<span>11 of 50 clicks today</span>} zone="America/New_York" nowMs={Date.parse('2026-01-15T03:00:00.000Z')} />)
    expect(screen.getByText('Empty means Liberty1 is not offered at all. The count resets at 3:00 AM Eastern time.')).toBeInTheDocument()
    expect(screen.getByText('11 of 50 clicks today')).toBeInTheDocument()
    expect(screen.getByLabelText('Clicks per day')).toHaveClass('w-[7.5rem]')
    expect(screen.queryByText(/once the clicks in a day reach it/i)).toBeNull()
  })

  // #2143, PM-10: the reset is said in the profile's display zone, at the hour it
  // falls on the night it happens. These nows are the evening before, Pacific.
  it.each([
    ['America/New_York', '2026-01-15T03:00:00.000Z', 'The count resets at 3:00 AM Eastern time.'],
    ['America/New_York', '2026-03-08T03:00:00.000Z', 'The count resets at 4:00 AM Eastern time.'],
    ['America/New_York', '2026-11-01T03:00:00.000Z', 'The count resets at 2:00 AM Eastern time.'],
    ['America/Denver', '2026-03-08T03:00:00.000Z', 'The count resets at 1:00 AM Mountain time.'],
    ['America/Los_Angeles', '2026-07-15T03:00:00.000Z', 'The count resets at midnight Pacific time.'],
  ] as const)('a click buyer\'s note says when the count resets, in %s at %s', (zone, now, sentence) => {
    render(<CapsGrid value={{ ...none, daily_lead_cap: 50 }} onChange={() => {}} soldOn="click" zone={zone} nowMs={Date.parse(now)} />)
    expect(screen.getByText(new RegExp(sentence.replace(/\./g, '\\.')))).toBeInTheDocument()
    expect(screen.queryByText(/midnight to midnight Pacific/)).toBeNull()
  })

  it('an offer buyer\'s note says when its day starts, in the display zone', () => {
    render(<CapsGrid value={none} onChange={() => {}} zone="America/Los_Angeles" nowMs={0} />)
    expect(screen.getByText(/A day runs from 9:00 PM to 9:00 PM Pacific time, starting the evening before\./)).toBeInTheDocument()
    expect(screen.queryByText(/Eastern time/)).toBeNull()
  })

  it('renders a field error beside the control it names', () => {
    render(<CapsGrid value={{ ...none, hourly_lead_cap: 600, daily_lead_cap: 500 }} onChange={() => {}} errors={{ hourlyLeadCap: 'Hourly cap is above the daily cap.' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Hourly cap is above the daily cap.')
    expect(screen.getByLabelText('Leads per hour')).toHaveAttribute('aria-describedby', expect.stringContaining('error'))
  })
})
