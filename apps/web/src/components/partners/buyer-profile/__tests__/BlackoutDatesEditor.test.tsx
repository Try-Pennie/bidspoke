/**
 * The blackout dates editor (#1412): Eastern calendar days the buyer takes off,
 * each with an optional note, kept sorted, at the real count (60 dates render
 * as 60 rows with no truncation). It is a table: the Date and Note headers are
 * said once, not once per row (L579), so sixty dates are sixty short rows and
 * not sixty labelled forms.
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
  it('renders one row per date, sorted by date, with the note, under headers said once', () => {
    render(<BlackoutDatesEditor value={dates} onChange={() => {}} />)
    const rows = screen.getAllByRole('row', { name: /blackout/i })
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByRole('textbox', { name: /date/i })).toHaveValue('Nov 25, 2027')
    expect(within(rows[1]).getByLabelText(/note/i)).toHaveValue('Christmas')
    // The third header names the remove column for a screen reader only.
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Date', 'Note', 'Remove'])
    // The header carries the words; the rows carry no repeated label or placeholder text.
    expect(screen.queryAllByText('Date')).toHaveLength(1)
    expect(screen.queryByPlaceholderText(/./)).toBeNull()
  })

  it('adds an empty row, edits a date and a note, and removes by date', () => {
    const onChange = vi.fn()
    render(<BlackoutDatesEditor value={[dates[0]]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /add date/i }))
    expect(onChange).toHaveBeenLastCalledWith([dates[0], { date: '', note: null }])
    const row = screen.getByRole('row', { name: /blackout/i })
    fireEvent.change(within(row).getByLabelText(/note/i), { target: { value: 'Christmas Day' } })
    expect(onChange).toHaveBeenLastCalledWith([{ date: '2027-12-25', note: 'Christmas Day' }])
    fireEvent.click(within(row).getByRole('button', { name: 'Remove Dec 25, 2027' }))
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('a date typed into a middle row that re-sorts the list keeps the focus in that field (#2137)', () => {
    function Owned() {
      const [value, setValue] = useState<ProfileBlackoutDocument[]>([
        { date: '2027-01-01', note: null }, { date: '2027-06-01', note: null }, { date: '2027-12-01', note: null },
      ])
      return <BlackoutDatesEditor value={value} onChange={setValue} />
    }
    render(<Owned />)
    const middle = screen.getByRole('textbox', { name: 'Date, Jun 1, 2027' })
    middle.focus()
    fireEvent.change(middle, { target: { value: 'Dec 31, 2027' } })
    fireEvent.keyDown(middle, { key: 'Enter' })
    const boxes = screen.getAllByRole('row', { name: /blackout/i }).map((r) => within(r).getByRole('textbox', { name: /^date/i }))
    expect(boxes.map((b) => (b as HTMLInputElement).value)).toEqual(['Jan 1, 2027', 'Dec 1, 2027', 'Dec 31, 2027'])
    expect(boxes[2]).toBe(middle)
    expect(document.activeElement).toBe(middle)
  })

  it('renders sixty dates as sixty rows', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ date: `2027-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + Math.floor(i / 12)).padStart(2, '0')}`, note: null }))
    render(<BlackoutDatesEditor value={many} onChange={() => {}} />)
    expect(screen.getAllByRole('row', { name: /blackout/i })).toHaveLength(60)
  })

  it('a date that is not a calendar day is flagged beside its row', () => {
    render(<BlackoutDatesEditor value={[{ date: '2027-02-30', note: null }]} onChange={() => {}} errors={{ 'blackout_dates[2027-02-30]': '2027-02-30 is not a calendar date.' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('2027-02-30 is not a calendar date.')
  })
})
