/**
 * The tier multiplier as a From / To / Multiplier table (PM-23, #2326), drawn
 * like the buyer profile's Pricing table, over the config the resolver reads
 * unchanged (bid-resolver.ts evaluateTieredMultiplier).
 *
 * The stored shape is a floor (`min_source_value`), a default multiplier, and
 * tiers that start ABOVE a number. The table's first row is the floor and the
 * default; each tier is a row whose From is its `above` plus one, the same
 * whole dollar reading the daily Tripoint pricing check uses ("starts paying the
 * higher rate at $above + 1"). A row's To is the next row's From, so the two
 * boxes are one stored number.
 *
 * Was (#1199): a "Minimum value" box, a "When > N multiply by M" line per tier
 * and a separate "Default multiplier" box. The three states of the floor stay
 * distinct here: a number is a floor, 0 is a floor of zero, and an empty box is
 * no floor.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { TieredMultiplierEditor } from '../TieredMultiplierEditor'

// Tripoint as the recorded fixture holds it.
const tripoint = {
  pricing_mode: 'tiered_multiplier',
  source_field: 'context.finalDebt',
  tiers: [{ above: 12499, multiplier: 0.0013 }],
  default_multiplier: 0.0009,
  min_source_value: 10000,
}

function renderEditor(config: Record<string, unknown> = tripoint) {
  const onChange = vi.fn()
  render(<TieredMultiplierEditor config={config} onChange={onChange} />)
  return onChange
}
const last = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.calls[onChange.mock.calls.length - 1][0] as Record<string, unknown>
const box = (name: string) => screen.getByLabelText(name)

describe('the tier table (PM-23)', () => {
  it('draws From, To and Multiplier columns with Tripoint as two tiers', () => {
    renderEditor()
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['From', 'To', 'Multiplier', 'Remove'])
    expect(box('From, tier 1')).toHaveValue(10000)
    expect(box('To, tier 1')).toHaveValue(12500)
    expect(box('Multiplier, tier 1')).toHaveValue(0.0009)
    expect(box('From, tier 2')).toHaveValue(12500)
    expect(box('Multiplier, tier 2')).toHaveValue(0.0013)
    expect(screen.queryByLabelText('To, tier 2')).not.toBeInTheDocument()
    expect(within(table).getByText('No upper bound')).toBeInTheDocument()
    expect(screen.getByText('No bid below the first tier. To is not included, so the next tier starts there.')).toBeInTheDocument()
  })

  it('has no Default multiplier or Minimum value box of its own', () => {
    renderEditor()
    expect(screen.queryByLabelText(/default multiplier/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/minimum value/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/When >/)).not.toBeInTheDocument()
  })

  it('a row To and the next row From are one number, stored as the tier start less one', () => {
    const onChange = renderEditor()
    fireEvent.change(box('To, tier 1'), { target: { value: '15000' } })
    expect(last(onChange).tiers).toEqual([{ above: 14999, multiplier: 0.0013 }])
    fireEvent.change(box('From, tier 2'), { target: { value: '20000' } })
    expect(last(onChange).tiers).toEqual([{ above: 19999, multiplier: 0.0013 }])
  })

  it('the first row is the floor and the default multiplier', () => {
    const onChange = renderEditor()
    fireEvent.change(box('Multiplier, tier 1'), { target: { value: '0.001' } })
    expect(last(onChange)).toEqual(expect.objectContaining({ default_multiplier: 0.001, min_source_value: 10000, tiers: [{ above: 12499, multiplier: 0.0013 }] }))
  })

  it('opening and editing an unrelated field keeps every stored number as it was', () => {
    const onChange = renderEditor()
    fireEvent.change(screen.getByLabelText('Multiply this field'), { target: { value: 'context.debt' } })
    expect(last(onChange)).toEqual({ ...tripoint, source_field: 'context.debt' })
  })

  it('removing the first row makes the next tier the first, with its start as the floor', () => {
    const onChange = renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Remove tier 1' }))
    expect(last(onChange)).toEqual(expect.objectContaining({ tiers: [], default_multiplier: 0.0013, min_source_value: 12500 }))
  })

  it('removing a later row removes that tier', () => {
    const onChange = renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Remove tier 2' }))
    expect(last(onChange)).toEqual(expect.objectContaining({ tiers: [], default_multiplier: 0.0009, min_source_value: 10000 }))
  })

  it('a single row offers no remove', () => {
    renderEditor({ ...tripoint, tiers: [] })
    expect(screen.queryByRole('button', { name: /Remove tier/ })).not.toBeInTheDocument()
  })

  it('Add tier starts a row where the last one starts, as the Pricing table does', () => {
    const onChange = renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Add tier' }))
    expect(last(onChange).tiers).toEqual([{ above: 12499, multiplier: 0.0013 }, { above: 12499, multiplier: 0 }])
  })

  it('shows tiers in order of where they start, whatever order they are stored in', () => {
    renderEditor({ ...tripoint, tiers: [{ above: 19999, multiplier: 0.002 }, { above: 12499, multiplier: 0.0013 }] })
    expect(box('From, tier 2')).toHaveValue(12500)
    expect(box('From, tier 3')).toHaveValue(20000)
  })
})

describe('the floor, as the first From (#1199)', () => {
  const noFloor = { ...tripoint, min_source_value: undefined }

  it('shows an empty box when no floor is set, not a zero, and does not claim one', () => {
    renderEditor(noFloor)
    expect(box('From, tier 1')).toHaveValue(null)
    expect(box('From, tier 1')).toHaveAttribute('placeholder', 'No lower bound')
    expect(screen.queryByText(/No bid below the first tier/)).not.toBeInTheDocument()
  })

  it('emits the floor when one is typed', () => {
    const onChange = renderEditor(noFloor)
    fireEvent.change(box('From, tier 1'), { target: { value: '10000' } })
    expect(last(onChange)).toEqual(expect.objectContaining({ min_source_value: 10000 }))
  })

  it('emits a floor of zero as 0, not as no floor', () => {
    const onChange = renderEditor(noFloor)
    fireEvent.change(box('From, tier 1'), { target: { value: '0' } })
    expect(last(onChange)).toEqual(expect.objectContaining({ min_source_value: 0 }))
  })

  it('clearing the box removes the floor rather than setting it to zero', () => {
    const onChange = renderEditor()
    fireEvent.change(box('From, tier 1'), { target: { value: '' } })
    expect(last(onChange)).toEqual(expect.objectContaining({ min_source_value: null }))
  })
})
