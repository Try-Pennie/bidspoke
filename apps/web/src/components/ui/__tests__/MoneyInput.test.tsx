/**
 * The money box (#2324): text that is not an amount stays as typed while it is
 * the person's, but a value changed from outside (Discard changes, Use theirs,
 * an Undo) replaces it, so the box never shows a stale entry over a new value.
 */
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { MoneyInput } from '../form'

describe('MoneyInput', () => {
  it('keeps text that is not an amount after blur, with its reason', () => {
    render(<MoneyInput id="m" aria-label="Debt maximum" value={55000} onChange={vi.fn()} />)
    const box = screen.getByRole('textbox', { name: 'Debt maximum' })
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: '55k' } })
    fireEvent.blur(box)
    expect(box).toHaveValue('55k')
    expect(screen.getByText('Type an amount of dollars, such as 20,000.')).toBeInTheDocument()
  })

  it('a value changed from outside replaces a stale entry', () => {
    const { rerender } = render(<MoneyInput id="m" aria-label="Debt maximum" value={55000} onChange={vi.fn()} />)
    const box = screen.getByRole('textbox', { name: 'Debt maximum' })
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: '55k' } })
    fireEvent.blur(box)
    rerender(<MoneyInput id="m" aria-label="Debt maximum" value={65000} onChange={vi.fn()} />)
    expect(box).toHaveValue('65,000')
    expect(screen.queryByText('Type an amount of dollars, such as 20,000.')).toBeNull()
  })

  it('the value its own typing emits does not cut the typing short', () => {
    function Host() {
      const [v, setV] = useState<number | null>(null)
      return <MoneyInput id="m" aria-label="Debt maximum" value={v} onChange={setV} />
    }
    render(<Host />)
    const box = screen.getByRole('textbox', { name: 'Debt maximum' })
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: '20,0' } })
    fireEvent.change(box, { target: { value: '20,000.' } })
    expect(box).toHaveValue('20,000.')
  })
})

describe('MoneyInput focus (#2324 review)', () => {
  it('focusing a stored amount with more than cents shows no error nobody typed', () => {
    render(<MoneyInput id="m" aria-label="Debt maximum" value={1234.567} onChange={vi.fn()} />)
    const box = screen.getByRole('textbox', { name: 'Debt maximum' })
    fireEvent.focus(box)
    expect(box).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByText('Type an amount of dollars, such as 20,000.')).toBeNull()
  })
})
