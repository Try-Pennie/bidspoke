/**
 * The money box (#2324): text that is not an amount stays as typed while it is
 * the person's, but a value changed from outside (Discard changes, Use theirs,
 * an Undo) replaces it, so the box never shows a stale entry over a new value.
 */
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MoneyInput } from '../form'

describe('MoneyInput', () => {
  it('says text that is not an amount while it is being typed', () => {
    render(<MoneyInput id="m" aria-label="Debt maximum" value={55000} onChange={vi.fn()} />)
    const box = screen.getByRole('textbox', { name: 'Debt maximum' })
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: '55k' } })
    expect(box).toHaveValue('55k')
    expect(screen.getByText('Type an amount of dollars, such as 20,000.')).toBeInTheDocument()
  })

  it('on leaving the box, text that is not an amount goes back to the stored amount and says so, so nothing stale outlives a Discard', () => {
    const onChange = vi.fn()
    const { rerender } = render(<MoneyInput id="m" aria-label="Debt maximum" value={55000} onChange={onChange} />)
    const box = screen.getByRole('textbox', { name: 'Debt maximum' })
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: '55k' } })
    fireEvent.blur(box)
    expect(box).toHaveValue('55,000')
    expect(screen.getByText('"55k" is not an amount of dollars, so the box is back to 55,000.')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    // A Discard that puts back the same stored value leaves nothing typed behind.
    rerender(<MoneyInput id="m" aria-label="Debt maximum" value={55000} onChange={onChange} />)
    expect(box).toHaveValue('55,000')
    fireEvent.focus(box)
    expect(screen.queryByText(/is not an amount of dollars/)).toBeNull()
  })

  it('a value changed from outside replaces a stale entry', () => {
    const { rerender } = render(<MoneyInput id="m" aria-label="Debt maximum" value={55000} onChange={vi.fn()} />)
    const box = screen.getByRole('textbox', { name: 'Debt maximum' })
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: '55k' } })
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

describe('MoneyInput after leaving the box (#2324 review)', () => {
  it('an outside change back to an amount typed in an earlier visit still replaces new typing', () => {
    let set: (v: number) => void = () => {}
    function Host() {
      const [v, setV] = useState<number | null>(55000)
      set = setV
      return <MoneyInput id="m" aria-label="Debt maximum" value={v} onChange={setV} />
    }
    render(<Host />)
    const box = screen.getByRole('textbox', { name: 'Debt maximum' })
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: '60,000' } })
    fireEvent.blur(box)
    // Discard puts back 40,000; the person starts typing again.
    act(() => set(40000))
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: '40,000x' } })
    // An Undo brings back 60,000, the amount the earlier visit emitted.
    act(() => set(60000))
    expect(box).toHaveValue('60,000')
  })
})
