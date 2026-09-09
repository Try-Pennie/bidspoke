/**
 * The minimum debt control (#1199).
 *
 * Salesforce books zero Tripoint revenue below $10,000 of debt, and Bidspoke's
 * tiered multiplier had no way to say so, so it priced those leads anyway. The
 * resolver now honours `min_source_value`; this is the control that sets it.
 *
 * Three states have to stay distinct in the config the editor emits: a number is
 * a floor, 0 is a floor of zero (a real answer), and an empty box is NO floor,
 * which is what every partner that does not want one must keep emitting.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TieredMultiplierEditor } from '../TieredMultiplierEditor'

const baseConfig = {
  pricing_mode: 'tiered_multiplier',
  source_field: 'context.finalDebt',
  tiers: [{ above: 12499, multiplier: 0.0012 }],
  default_multiplier: 0.0009,
}

function renderEditor(config: Record<string, unknown> = baseConfig) {
  const onChange = vi.fn()
  render(<TieredMultiplierEditor config={config} onChange={onChange} />)
  return onChange
}

const minimumBox = () => screen.getByLabelText(/minimum/i)

describe('minimum value control (#1199)', () => {
  it('offers a control for the minimum', () => {
    renderEditor()
    expect(minimumBox()).toBeInTheDocument()
  })

  it('shows an empty box when no floor is set, not a zero', () => {
    // A displayed 0 would claim a floor of zero has been chosen, which is a
    // different rule from having none.
    renderEditor()
    expect(minimumBox()).toHaveValue(null)
  })

  it('shows the floor that is already set', () => {
    renderEditor({ ...baseConfig, min_source_value: 10000 })
    expect(minimumBox()).toHaveValue(10000)
  })

  it('emits the floor when one is typed', () => {
    const onChange = renderEditor()
    fireEvent.change(minimumBox(), { target: { value: '10000' } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ min_source_value: 10000 }))
  })

  it('emits a floor of zero as 0, not as no floor', () => {
    const onChange = renderEditor()
    fireEvent.change(minimumBox(), { target: { value: '0' } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ min_source_value: 0 }))
  })

  it('clearing the box removes the floor rather than setting it to zero', () => {
    const onChange = renderEditor({ ...baseConfig, min_source_value: 10000 })
    fireEvent.change(minimumBox(), { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ min_source_value: null }))
  })

  it('keeps the floor when an unrelated field is edited', () => {
    // patch() rebuilds the emitted config from a named list of keys, so a field
    // missing from that list is dropped by any other edit (L510).
    const onChange = renderEditor({ ...baseConfig, min_source_value: 10000 })
    fireEvent.change(screen.getByLabelText(/multiply this field/i), { target: { value: 'context.debt' } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ min_source_value: 10000 }))
  })

  it('says what the control does in money terms, not in field terms', () => {
    renderEditor()
    expect(screen.getByText(/below this.*no bid/i)).toBeInTheDocument()
  })
})
