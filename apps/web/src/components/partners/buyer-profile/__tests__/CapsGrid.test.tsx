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
  it('renders four labelled controls, empty when there is no cap', () => {
    render(<CapsGrid value={none} onChange={() => {}} />)
    for (const label of ['Leads per hour', 'Leads per day', 'Spend per hour', 'Spend per day']) {
      expect(screen.getByLabelText(label)).toHaveValue(null)
    }
  })

  it('shows spend caps in dollars and emits cents', () => {
    const onChange = vi.fn()
    render(<CapsGrid value={{ ...none, daily_spend_cap_cents: 1_000_000 }} onChange={onChange} />)
    expect(screen.getByLabelText('Spend per day')).toHaveValue(10000)
    fireEvent.change(screen.getByLabelText('Spend per hour'), { target: { value: '1250.50' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...none, daily_spend_cap_cents: 1_000_000, hourly_spend_cap_cents: 125_050 })
  })

  it('clearing a box emits null for that cap, never zero', () => {
    const onChange = vi.fn()
    render(<CapsGrid value={{ ...none, daily_lead_cap: 500 }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Leads per day'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith(none)
  })

  it('states the scope, the unit and the empty rule once each, not once per box (L605)', () => {
    render(<CapsGrid value={none} onChange={() => {}} />)
    expect(screen.getAllByText(/counts sales made through buyer selection: engine/i)).toHaveLength(1)
    expect(screen.getAllByText(/empty/i)).toHaveLength(1)
    expect(screen.getAllByText(/dollars/i)).toHaveLength(1)
  })

  it('renders a field error beside the control it names', () => {
    render(<CapsGrid value={{ ...none, hourly_lead_cap: 600, daily_lead_cap: 500 }} onChange={() => {}} errors={{ hourlyLeadCap: 'Hourly cap is above the daily cap.' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Hourly cap is above the daily cap.')
    expect(screen.getByLabelText('Leads per hour')).toHaveAttribute('aria-describedby', expect.stringContaining('error'))
  })
})
