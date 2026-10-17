/**
 * The blackout dates editor (#1412), drawn as the settled design draws it
 * (#2325, PM-22): a list, one row per day off reading its weekday and date,
 * sorted, with the grey remove mark, at the real count (60 dates render as 60
 * rows with no truncation). Before #2325 it was a Date and Note table; a note
 * already stored is still shown after its day, so it is never hidden (L1008).
 */
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { ProfileBlackoutDocument } from '@bidspoke/buyer-profile'
import { BlackoutDatesEditor } from '../BlackoutDatesEditor'

const dates: ProfileBlackoutDocument[] = [
  { date: '2027-12-25', note: 'Christmas' },
  { date: '2027-11-25', note: null },
]

describe('BlackoutDatesEditor', () => {
  it('renders one row per day off, sorted, reading its weekday, with a stored note after its day and no table', () => {
    render(<BlackoutDatesEditor value={dates} onChange={() => {}} />)
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Thursday, Nov 25, 2027', 'Saturday, Dec 25, 2027 Christmas'])
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('Add date adds a date box to pick the day in, and a day is removed by its name', () => {
    const onChange = vi.fn()
    const { rerender } = render(<BlackoutDatesEditor value={[dates[0]]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /add date/i }))
    expect(onChange).toHaveBeenLastCalledWith([dates[0], { date: '', note: null }])
    rerender(<BlackoutDatesEditor value={[dates[0], { date: '', note: null }]} onChange={onChange} />)
    // The new row sorts first, so the person sees the row they asked for.
    const added = screen.getAllByRole('listitem')[0]
    expect(within(added).getByRole('textbox', { name: 'Date, new date' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Saturday, Dec 25, 2027' }))
    expect(onChange).toHaveBeenLastCalledWith([{ date: '', note: null }])
  })

  it('a day picked in the new row reads as a row of the list', () => {
    const onChange = vi.fn()
    render(<BlackoutDatesEditor value={[{ date: '', note: null }]} onChange={onChange} />)
    const box = screen.getByRole('textbox', { name: 'Date, new date' })
    fireEvent.change(box, { target: { value: 'Dec 31, 2027' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith([{ date: '2027-12-31', note: null }])
  })

  // Lessons review on #2325: committing the day turns the box into a row of the list,
  // so the focus moves to Add date rather than dropping to the page.
  it('after a day is picked in the new row, the focus is on Add date, ready for the next', () => {
    function Owner() {
      const [value, setValue] = useState<ProfileBlackoutDocument[]>([{ date: '', note: null }])
      return <BlackoutDatesEditor value={value} onChange={setValue} />
    }
    render(<Owner />)
    const box = screen.getByRole('textbox', { name: 'Date, new date' })
    box.focus()
    fireEvent.change(box, { target: { value: 'Dec 31, 2027' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.getByRole('listitem')).toHaveTextContent('Friday, Dec 31, 2027')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add date' }))
  })

  it('renders sixty dates as sixty rows', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ date: `2027-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + Math.floor(i / 12)).padStart(2, '0')}`, note: null }))
    render(<BlackoutDatesEditor value={many} onChange={() => {}} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(60)
  })

  it('a date that is not a calendar day stays a box to correct, flagged beside its row', () => {
    render(<BlackoutDatesEditor value={[{ date: '2027-02-30', note: null }]} onChange={() => {}} errors={{ 'blackout_dates[2027-02-30]': '2027-02-30 is not a calendar date.' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('2027-02-30 is not a calendar date.')
    expect(screen.getByRole('textbox', { name: 'Date, 2027-02-30' })).toBeInTheDocument()
  })
})
