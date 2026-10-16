/**
 * DateField and TimeField (#2137, design round 1, "Typed, with a calendar").
 * Runs under both zone projects (vitest.config.ts), so "today" in the calendar
 * is proved to be the Eastern date from either side of it. The clock is passed
 * in, never read.
 */
import { describe, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'
import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DateField, TimeField } from '../DateTimeFields'

// Noon Eastern on 2026-10-15: a Thursday. In Kiritimati it is already the 16th.
const NOW = () => Date.UTC(2026, 9, 15, 16, 0)

function Form({ children, onSubmit }: { children: ReactNode; onSubmit: () => void }) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit() }}>
      {children}
      <button type="submit">Save</button>
    </form>
  )
}

function OwnedDate({ initial, onChange }: { initial: string; onChange?: (d: string) => void }) {
  const [value, setValue] = useState(initial)
  return <DateField id="d" label="Blackout date" value={value} now={NOW} onChange={(d) => { setValue(d); onChange?.(d) }} />
}

function OwnedTime({ initial, edge, onChange }: { initial: number; edge: 'start' | 'end'; onChange?: (m: number) => void }) {
  const [value, setValue] = useState(initial)
  return <TimeField id="t" label="Opens, Monday" edge={edge} value={value} onChange={(m) => { setValue(m); onChange?.(m) }} />
}

describe('DateField, typed', () => {
  it('shows the stored date the way it is typed, labelled for a screen reader', () => {
    render(<OwnedDate initial="2027-01-01" />)
    expect(screen.getByRole('textbox', { name: 'Blackout date' })).toHaveValue('Jan 1, 2027')
  })

  it('commits a typed date on Enter, shows it back in one spelling, and does not submit the form', async () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    render(<Form onSubmit={onSubmit}><OwnedDate initial="" onChange={onChange} /></Form>)
    await userEvent.type(screen.getByRole('textbox', { name: 'Blackout date' }), '12/25/2026{Enter}')
    expect(onChange).toHaveBeenCalledWith('2026-12-25')
    expect(screen.getByRole('textbox', { name: 'Blackout date' })).toHaveValue('Dec 25, 2026')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('commits on blur too', async () => {
    const onChange = vi.fn()
    render(<><OwnedDate initial="" onChange={onChange} /><button type="button">elsewhere</button></>)
    await userEvent.type(screen.getByRole('textbox', { name: 'Blackout date' }), 'Nov 26')
    await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }))
    expect(onChange).toHaveBeenCalledWith('2026-11-26')
  })

  it('keeps an unreadable draft on screen with the reason beside it, and the form will not submit', async () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    render(<Form onSubmit={onSubmit}><OwnedDate initial="2027-01-01" onChange={onChange} /></Form>)
    const box = screen.getByRole('textbox', { name: 'Blackout date' })
    await userEvent.clear(box)
    await userEvent.type(box, '1/1/27{Enter}')
    expect(box).toHaveValue('1/1/27')
    expect(box).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent(/year in full/i)
    expect(box).toHaveAccessibleDescription(/year in full/i)
    expect(onChange).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows the stored date again when it changes from outside, clearing an old error', async () => {
    const { rerender } = render(<DateField id="d" label="Blackout date" value="2027-01-01" now={NOW} onChange={() => {}} />)
    const box = screen.getByRole('textbox', { name: 'Blackout date' })
    await userEvent.clear(box)
    await userEvent.type(box, 'nonsense{Enter}')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    rerender(<DateField id="d" label="Blackout date" value="2026-12-25" now={NOW} onChange={() => {}} />)
    expect(box).toHaveValue('Dec 25, 2026')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('DateField, the calendar (WAI-ARIA date picker pattern)', () => {
  async function openCalendar(initial = '2027-01-01', onChange?: (d: string) => void) {
    render(<OwnedDate initial={initial} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: 'Choose Blackout date from a calendar' }))
    return screen.getByRole('grid')
  }

  it('opens on the stored month with the stored day focused, each day named in full', async () => {
    const grid = await openCalendar()
    expect(grid).toHaveAccessibleName('January 2027')
    expect(document.activeElement).toBe(within(grid).getByRole('button', { name: 'Friday, January 1, 2027' }))
    // One tab stop in the grid.
    expect(within(grid).getAllByRole('button').filter((b) => b.tabIndex === 0)).toHaveLength(1)
  })

  it('marks today, the Eastern date, as current', async () => {
    const grid = await openCalendar('')
    expect(grid).toHaveAccessibleName('October 2026')
    const today = within(grid).getByRole('button', { name: 'Thursday, October 15, 2026' })
    expect(today).toHaveAttribute('aria-current', 'date')
    expect(document.activeElement).toBe(today)
  })

  it('arrows move by day and week, across a month boundary', async () => {
    const grid = await openCalendar()
    await userEvent.keyboard('{ArrowLeft}')
    expect(screen.getByRole('grid')).toHaveAccessibleName('December 2026')
    expect(document.activeElement).toHaveAccessibleName('Thursday, December 31, 2026')
    await userEvent.keyboard('{ArrowRight}{ArrowDown}')
    expect(document.activeElement).toHaveAccessibleName('Friday, January 8, 2027')
    await userEvent.keyboard('{ArrowUp}')
    expect(document.activeElement).toHaveAccessibleName('Friday, January 1, 2027')
    expect(grid).toBeInTheDocument()
  })

  it('Page Up and Page Down move by month, Home and End to the ends of the week', async () => {
    await openCalendar('2027-01-31')
    await userEvent.keyboard('{PageDown}')
    expect(document.activeElement).toHaveAccessibleName('Sunday, February 28, 2027')
    await userEvent.keyboard('{PageUp}')
    expect(document.activeElement).toHaveAccessibleName('Thursday, January 28, 2027')
    await userEvent.keyboard('{Home}')
    expect(document.activeElement).toHaveAccessibleName('Sunday, January 24, 2027')
    await userEvent.keyboard('{End}')
    expect(document.activeElement).toHaveAccessibleName('Saturday, January 30, 2027')
  })

  it('Enter picks the focused day, closes the calendar and returns focus to its button', async () => {
    const onChange = vi.fn()
    await openCalendar('2027-01-01', onChange)
    await userEvent.keyboard('{ArrowRight}{Enter}')
    expect(onChange).toHaveBeenCalledWith('2027-01-02')
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Blackout date' })).toHaveValue('Jan 2, 2027')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose Blackout date from a calendar' }))
  })

  it('Escape closes it without a change and returns focus to its button', async () => {
    const onChange = vi.fn()
    await openCalendar('2027-01-01', onChange)
    await userEvent.keyboard('{ArrowRight}{Escape}')
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose Blackout date from a calendar' }))
  })

  it('the month buttons change the month and leave the focus on the button pressed', async () => {
    await openCalendar()
    const next = screen.getByRole('button', { name: 'Next month' })
    await userEvent.click(next)
    expect(screen.getByRole('grid')).toHaveAccessibleName('February 2027')
    expect(document.activeElement).toBe(next)
  })

  it('a key that lands on the focused day leaves the next month button press keeping its focus', async () => {
    await openCalendar('2027-01-03') // a Sunday
    await userEvent.keyboard('{Home}')
    expect(document.activeElement).toHaveAccessibleName('Sunday, January 3, 2027')
    const next = screen.getByRole('button', { name: 'Next month' })
    await userEvent.click(next)
    expect(document.activeElement).toBe(next)
  })

  it('a stored day that is not a calendar day is shown as stored and not flagged by tabbing through', async () => {
    const onChange = vi.fn()
    render(<><DateField id="d" label="Blackout date" value="2027-02-30" now={NOW} onChange={onChange} /><button type="button">elsewhere</button></>)
    const box = screen.getByRole('textbox', { name: 'Blackout date' })
    expect(box).toHaveValue('2027-02-30')
    await userEvent.click(box)
    await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a click on a day picks it', async () => {
    const onChange = vi.fn()
    const grid = await openCalendar('2027-01-01', onChange)
    fireEvent.click(within(grid).getByRole('button', { name: 'Friday, January 15, 2027' }))
    expect(onChange).toHaveBeenCalledWith('2027-01-15')
  })
})

describe('TimeField, typed', () => {
  it('shows minutes as a twelve hour time and commits a typed one on Enter without submitting', async () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    render(<Form onSubmit={onSubmit}><OwnedTime initial={540} edge="start" onChange={onChange} /></Form>)
    const box = screen.getByRole('textbox', { name: 'Opens, Monday' })
    expect(box).toHaveValue('9:00 AM')
    await userEvent.clear(box)
    await userEvent.type(box, '5pm{Enter}')
    expect(onChange).toHaveBeenCalledWith(1020)
    expect(box).toHaveValue('5:00 PM')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('a close typed as 12:00 AM is the end of the day', async () => {
    const onChange = vi.fn()
    render(<OwnedTime initial={1020} edge="end" onChange={onChange} />)
    const box = screen.getByRole('textbox', { name: 'Opens, Monday' })
    await userEvent.clear(box)
    await userEvent.type(box, '12:00 AM{Enter}')
    expect(onChange).toHaveBeenCalledWith(1440)
  })

  it('tabbing through an untouched box changes nothing, even a stored value that reads back differently', async () => {
    // 7 of 12 live windows close at 1440, but a close stored as 1439 shows as
    // 11:59 PM, which reads back as 1440: a blur must not rewrite it.
    const onChange = vi.fn()
    render(<><OwnedTime initial={1439} edge="end" onChange={onChange} /><button type="button">elsewhere</button></>)
    await userEvent.click(screen.getByRole('textbox', { name: 'Opens, Monday' }))
    await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps an unreadable time with the reason beside it, and the form will not submit', async () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    render(<Form onSubmit={onSubmit}><OwnedTime initial={540} edge="start" onChange={onChange} /></Form>)
    const box = screen.getByRole('textbox', { name: 'Opens, Monday' })
    await userEvent.clear(box)
    await userEvent.type(box, 'noon{Enter}')
    expect(box).toHaveValue('noon')
    expect(screen.getByRole('alert')).toHaveTextContent(/like 9:00 AM/)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })
})
