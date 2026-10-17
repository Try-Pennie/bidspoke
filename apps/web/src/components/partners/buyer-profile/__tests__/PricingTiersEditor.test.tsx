/**
 * The pricing tiers editor (#1412): one ladder per WIRED population with
 * inputs, every other population named in one line with no inputs (L46,
 * L703). Each ladder is a table whose Debt from, Debt to and Multiplier
 * headers are said once (L579). Since #2325 (PM-22) it is drawn as the design
 * draws it: "Engine leads" over one table, debt in money boxes, a short hint
 * and one line naming the populations not priced here yet; the worked example
 * and the Salesforce band arithmetic are gone.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { ProfileTierDocument } from '@bidspoke/buyer-profile'
import { PricingTiersEditor } from '../PricingTiersEditor'

const tiers: ProfileTierDocument[] = [
  { population: 'engine', debt_from: 15000, debt_to: 30000, multiplier: 0.0012 },
  { population: 'engine', debt_from: 30000, debt_to: null, multiplier: 0.001 },
]

describe('PricingTiersEditor', () => {
  it('offers inputs for the wired population only, headed by its leads, and names the others in one line', () => {
    render(<PricingTiersEditor value={tiers} onChange={() => {}} />)
    const engine = screen.getByRole('group', { name: 'Engine leads' })
    expect(within(engine).getAllByLabelText(/multiplier/i)).toHaveLength(2)
    expect(within(engine).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Debt from', 'Debt to', 'Multiplier', 'Remove'])
    expect(screen.getAllByRole('table')).toHaveLength(1)
    expect(screen.getByText('Main Flow and Lead Economy are not priced here yet: no workflow sells those leads through buyer selection.')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /main flow|lead economy/i })).toBeNull()
  })

  it('debt reads as dollars, and an open ended top tier is an empty box reading No upper bound that emits null', () => {
    const onChange = vi.fn()
    render(<PricingTiersEditor value={tiers} onChange={onChange} />)
    expect(screen.getByLabelText('Debt from, tier 15,000 to 30,000')).toHaveValue('15,000')
    const uppers = screen.getAllByLabelText(/debt to/i)
    expect(uppers[1]).toHaveValue('')
    expect(uppers[1]).toHaveAttribute('placeholder', 'No upper bound')
    fireEvent.change(uppers[0], { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith([{ ...tiers[0], debt_to: null }, tiers[1]])
  })

  it('adds a tier for the population starting where the last one ends, and removes one by name', () => {
    const onChange = vi.fn()
    render(<PricingTiersEditor value={[tiers[0]]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /add tier/i }))
    expect(onChange).toHaveBeenLastCalledWith([tiers[0], { population: 'engine', debt_from: 30000, debt_to: null, multiplier: 0 }])
    fireEvent.click(screen.getByRole('button', { name: /remove tier 15,000 to 30,000/i }))
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('says the pricing rule once in a short hint, with no worked example', () => {
    render(<PricingTiersEditor value={tiers} onChange={() => {}} />)
    expect(screen.getAllByText('A lead pays its debt times the multiplier. Debt to is not included, so the next tier starts there.')).toHaveLength(1)
    expect(screen.queryByText(/18,250/)).toBeNull()
  })

  it('renders a tier error beside the tier it names', () => {
    render(<PricingTiersEditor value={tiers} onChange={() => {}} errors={{ 'tiers[engine:30000]': 'This tier overlaps the one before it.' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('This tier overlaps the one before it.')
  })
})
