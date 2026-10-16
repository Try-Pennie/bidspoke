/**
 * The weekly hours editor (#1412): seven days from the shared vocabulary, one
 * or more windows a day in Eastern time, an "Always open" preset, and a window
 * whose close is not after its open flagged beside it. No windows means never
 * open, and the editor says so (L72). The Opens and Closes words are column
 * headers said once, not labels repeated on every row (L579).
 */
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { ProfileWindowDocument } from '@bidspoke/buyer-profile'
import { WeeklyHoursEditor } from '../WeeklyHoursEditor'

const monday: ProfileWindowDocument = { day_of_week: 1, opens_minute: 540, closes_minute: 1080 }

describe('WeeklyHoursEditor', () => {
  it('renders the seven days with their windows as times, Sunday first, under headers said once', () => {
    render(<WeeklyHoursEditor value={[monday, { day_of_week: 3, opens_minute: 600, closes_minute: 900 }]} onChange={() => {}} />)
    const days = screen.getAllByRole('group')
    expect(days.map((d) => d.getAttribute('aria-label'))).toEqual(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])
    expect(within(days[1]).getByLabelText(/opens/i)).toHaveValue('9:00 AM')
    expect(within(days[1]).getByLabelText(/closes/i)).toHaveValue('6:00 PM')
    expect(within(days[0]).getByText(/closed/i)).toBeInTheDocument()
    expect(screen.getAllByText('Opens')).toHaveLength(1)
    expect(screen.getAllByText('Closes')).toHaveLength(1)
  })

  it('Always open sets one whole day window on every day', () => {
    const onChange = vi.fn()
    render(<WeeklyHoursEditor value={[monday]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Always open' }))
    expect(onChange).toHaveBeenLastCalledWith([0, 1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, opens_minute: 0, closes_minute: 1440 })))
  })

  it('adds a window to a day, edits its times in minutes, and removes it', () => {
    const onChange = vi.fn()
    render(<WeeklyHoursEditor value={[monday]} onChange={onChange} />)
    const tuesday = screen.getByRole('group', { name: 'Tuesday' })
    fireEvent.click(within(tuesday).getByRole('button', { name: /add hours/i }))
    expect(onChange).toHaveBeenLastCalledWith([monday, { day_of_week: 2, opens_minute: 540, closes_minute: 1020 }])
    const mondayGroup = screen.getByRole('group', { name: 'Monday' })
    // A day that already has hours can take a second window too.
    expect(within(mondayGroup).getByRole('button', { name: /add hours/i })).toBeInTheDocument()
    const closes = within(mondayGroup).getByLabelText(/closes/i)
    fireEvent.change(closes, { target: { value: '5:30 PM' } })
    fireEvent.keyDown(closes, { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith([{ ...monday, closes_minute: 1050 }])
    fireEvent.click(within(mondayGroup).getByRole('button', { name: /remove/i }))
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('a time typed into a middle window that re-sorts the day keeps the focus in that field (#2137)', () => {
    function Owned() {
      const [windows, setWindows] = useState<ProfileWindowDocument[]>([
        { day_of_week: 1, opens_minute: 480, closes_minute: 600 },
        { day_of_week: 1, opens_minute: 720, closes_minute: 840 },
        { day_of_week: 1, opens_minute: 960, closes_minute: 1080 },
      ])
      return <WeeklyHoursEditor value={windows} onChange={setWindows} />
    }
    render(<Owned />)
    const middle = within(screen.getByRole('group', { name: 'Monday' })).getAllByLabelText(/opens/i)[1]
    middle.focus()
    // 7:00 AM sorts the middle window first.
    fireEvent.change(middle, { target: { value: '7:00 AM' } })
    fireEvent.keyDown(middle, { key: 'Enter' })
    const opens = within(screen.getByRole('group', { name: 'Monday' })).getAllByLabelText(/opens/i)
    expect(opens.map((o) => (o as HTMLInputElement).value)).toEqual(['7:00 AM', '8:00 AM', '4:00 PM'])
    expect(document.activeElement).toBe(opens[0])
    expect(opens[0]).toBe(middle)
  })

  it('a close at or before its open is flagged beside the window', () => {
    render(<WeeklyHoursEditor value={[{ day_of_week: 1, opens_minute: 600, closes_minute: 600 }]} onChange={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/closes must be after opens/i)
  })

  it('says once that no hours means the buyer is never offered a lead', () => {
    render(<WeeklyHoursEditor value={[]} onChange={() => {}} />)
    expect(screen.getAllByText(/never offered a lead/i)).toHaveLength(1)
  })
})
