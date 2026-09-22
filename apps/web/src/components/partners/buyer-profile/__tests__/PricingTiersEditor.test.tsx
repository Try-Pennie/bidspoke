/**
 * The pricing tiers editor (#1412): one ladder per WIRED population with
 * inputs, every other population named as not yet in use with no inputs (L46,
 * L703), the multiplier ceiling from the shared vocabulary, and Geoff's worked
 * example stated once as the domain explanation. Each ladder is a table whose
 * Debt from, Debt to and Multiplier headers are said once (L579).
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
  it('offers inputs for the wired population only and names the others as not yet in use', () => {
    render(<PricingTiersEditor value={tiers} onChange={() => {}} />)
    const engine = screen.getByRole('group', { name: /engine/i })
    expect(within(engine).getAllByLabelText(/multiplier/i)).toHaveLength(2)
    expect(within(engine).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Debt from', 'Debt to', 'Multiplier', 'Remove'])
    for (const other of ['Main Flow', 'Lead Economy']) {
      const region = screen.getByText(new RegExp(other, 'i')).closest('[data-population]') as HTMLElement
      expect(region).toHaveTextContent(/not yet in use/i)
      expect(within(region).queryAllByRole('spinbutton')).toHaveLength(0)
    }
  })

  it('shows an open ended top tier as an empty upper bound and emits null for it', () => {
    const onChange = vi.fn()
    render(<PricingTiersEditor value={tiers} onChange={onChange} />)
    const uppers = screen.getAllByLabelText(/debt to/i)
    expect(uppers[1]).toHaveValue(null)
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

  it('states the worked example once and the ceiling once', () => {
    render(<PricingTiersEditor value={tiers} onChange={() => {}} />)
    expect(screen.getAllByText(/\$18,250 of debt at 0\.0012 pays \$21\.90/i)).toHaveLength(1)
    expect(screen.getAllByText(/never above 1/i)).toHaveLength(1)
  })

  it('renders a tier error beside the tier it names', () => {
    render(<PricingTiersEditor value={tiers} onChange={() => {}} errors={{ 'tiers[engine:30000]': 'This tier overlaps the one before it.' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('This tier overlaps the one before it.')
  })
})
