/**
 * The weekly hours editor (#1412), stored in Eastern time and drawn in the
 * profile's display zone (#2143). No windows means never open, and the editor
 * says so (L72).
 *
 * Since #2324 (PM-21) it is drawn as the settled design draws it: the same
 * hours every day first (day chips and one range), with "Set different hours
 * for each day" opening one row per day (a switch, its ranges, "Another
 * window"), and "Same hours every day" back. Hours that differ by day open in
 * the per day view and are never flattened by being looked at. The old seven
 * row table with Opens and Closes headers is gone.
 */
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { ProfileWindowDocument } from '@bidspoke/buyer-profile'
import { WeeklyHoursEditor } from '../WeeklyHoursEditor'

const w = (day_of_week: number, opens_minute: number, closes_minute: number): ProfileWindowDocument => ({ day_of_week, opens_minute, closes_minute })
const weekdays = [1, 2, 3, 4, 5].map((d) => w(d, 540, 1260))
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const sortWindows = (ws: readonly ProfileWindowDocument[]) => [...ws].sort((a, b) => a.day_of_week - b.day_of_week || a.opens_minute - b.opens_minute)
const lastWindows = (fn: ReturnType<typeof vi.fn>) => sortWindows(fn.mock.lastCall![0] as ProfileWindowDocument[])
const commit = (box: HTMLElement, value: string) => {
  fireEvent.change(box, { target: { value } })
  fireEvent.keyDown(box, { key: 'Enter' })
}

describe('the same hours every day (#2324)', () => {
  it('opens weekday hours as day chips and one range, Sunday first', () => {
    render(<WeeklyHoursEditor value={weekdays} onChange={() => {}} />)
    const days = within(screen.getByRole('group', { name: 'Days open' })).getAllByRole('checkbox')
    expect(days.map((d) => d.getAttribute('aria-label'))).toEqual(DAY_NAMES)
    expect(days.map((d) => d.textContent)).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
    expect(days.map((d) => d.getAttribute('aria-checked'))).toEqual(['false', 'true', 'true', 'true', 'true', 'true', 'false'])
    expect(screen.getByLabelText('Opens')).toHaveValue('9:00 AM')
    expect(screen.getByLabelText('Closes')).toHaveValue('9:00 PM')
    expect(screen.getByRole('button', { name: 'Set different hours for each day' })).toBeInTheDocument()
    // No per day rows and no Always open in this view.
    expect(screen.queryByRole('group', { name: 'Monday' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Always open' })).toBeNull()
  })

  it('choosing a day opens it for the shared range, and unchoosing one closes it', () => {
    const onChange = vi.fn()
    render(<WeeklyHoursEditor value={weekdays} onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Saturday' }))
    expect(lastWindows(onChange)).toEqual([...weekdays, w(6, 540, 1260)])
    fireEvent.click(screen.getByRole('checkbox', { name: 'Monday' }))
    expect(lastWindows(onChange)).toEqual(weekdays.filter((x) => x.day_of_week !== 1))
  })

  it('changing the range changes it on every open day', () => {
    const onChange = vi.fn()
    render(<WeeklyHoursEditor value={weekdays} onChange={onChange} />)
    commit(screen.getByLabelText('Closes'), '5:00 PM')
    expect(lastWindows(onChange)).toEqual([1, 2, 3, 4, 5].map((d) => w(d, 540, 1020)))
  })

  it('with no hours, no day is chosen, the editor says the buyer is never offered a lead, and a chosen day opens 9:00 AM to 5:00 PM', () => {
    const onChange = vi.fn()
    render(<WeeklyHoursEditor value={[]} onChange={onChange} />)
    expect(screen.getAllByText(/never offered a lead/i)).toHaveLength(1)
    expect(screen.getAllByRole('checkbox').every((c) => c.getAttribute('aria-checked') === 'false')).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tuesday' }))
    expect(onChange).toHaveBeenLastCalledWith([w(2, 540, 1020)])
  })

  it('a range whose close is not after its open is flagged and stays in this view', () => {
    render(<WeeklyHoursEditor value={[w(1, 600, 600), w(2, 600, 600)]} onChange={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/closes must be after opens/i)
    expect(screen.getByRole('group', { name: 'Days open' })).toBeInTheDocument()
  })

  it('in Pacific shows the hours there and stores an edit as the Eastern hours it means', () => {
    const onChange = vi.fn()
    render(<WeeklyHoursEditor value={weekdays} onChange={onChange} zone="America/Los_Angeles" />)
    expect(screen.getByLabelText('Opens')).toHaveValue('6:00 AM')
    expect(screen.getByLabelText('Closes')).toHaveValue('6:00 PM')
    commit(screen.getByLabelText('Closes'), '7:00 PM')
    expect(lastWindows(onChange)).toEqual([1, 2, 3, 4, 5].map((d) => w(d, 540, 1320)))
  })
})

describe('switching between the two views', () => {
  it('hours that differ by day open one row per day, and nothing is written by looking', () => {
    const onChange = vi.fn()
    render(<WeeklyHoursEditor value={[w(1, 540, 1020), w(2, 600, 1020)]} onChange={onChange} />)
    expect(screen.getAllByRole('group').filter((g) => DAY_NAMES.includes(g.getAttribute('aria-label') ?? '')).map((g) => g.getAttribute('aria-label'))).toEqual(DAY_NAMES)
    expect(screen.queryByRole('group', { name: 'Days open' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Same hours every day' })).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Set different hours for each day and Same hours every day switch views without changing hours that are the same', () => {
    const onChange = vi.fn()
    render(<WeeklyHoursEditor value={weekdays} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Set different hours for each day' }))
    expect(within(screen.getByRole('group', { name: 'Monday' })).getByLabelText('Opens, Monday')).toHaveValue('9:00 AM')
    fireEvent.click(screen.getByRole('button', { name: 'Same hours every day' }))
    expect(screen.getByRole('group', { name: 'Days open' })).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Same hours every day from hours that differ gives every open day the first open day\'s hours, as the person asked', () => {
    const onChange = vi.fn()
    render(<WeeklyHoursEditor value={[w(1, 540, 1020), w(2, 600, 1080), w(2, 1140, 1200)]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Same hours every day' }))
    expect(lastWindows(onChange)).toEqual([w(1, 540, 1020), w(2, 540, 1020)])
  })
})

describe('one row per day', () => {
  const perDay = (value: ProfileWindowDocument[], onChange = vi.fn(), zone?: 'America/Los_Angeles' | 'America/Chicago') => {
    function Owned() {
      const [windows, setWindows] = useState(value)
      return <WeeklyHoursEditor value={windows} onChange={(next) => { onChange(next); setWindows(next) }} zone={zone} />
    }
    render(<Owned />)
    if (screen.queryByRole('button', { name: 'Set different hours for each day' })) fireEvent.click(screen.getByRole('button', { name: 'Set different hours for each day' }))
    return onChange
  }
  const day = (name: string) => screen.getByRole('group', { name })

  it('draws each day with its switch and its ranges, a closed day saying Closed', () => {
    perDay([w(1, 540, 1080), w(3, 600, 900)])
    expect(within(day('Monday')).getByRole('switch', { name: 'Open on Monday' })).toHaveAttribute('aria-checked', 'true')
    expect(within(day('Monday')).getByLabelText('Opens, Monday')).toHaveValue('9:00 AM')
    expect(within(day('Monday')).getByLabelText('Closes, Monday')).toHaveValue('6:00 PM')
    expect(within(day('Sunday')).getByRole('switch', { name: 'Open on Sunday' })).toHaveAttribute('aria-checked', 'false')
    expect(within(day('Sunday')).getByText('Closed')).toBeInTheDocument()
  })

  it('a day switched on opens 9:00 AM to 5:00 PM, and switched off loses its hours', () => {
    const onChange = perDay([w(1, 540, 1080), w(3, 600, 900)])
    fireEvent.click(within(day('Tuesday')).getByRole('switch', { name: 'Open on Tuesday' }))
    expect(sortWindows(onChange.mock.lastCall![0])).toEqual([w(1, 540, 1080), w(2, 540, 1020), w(3, 600, 900)])
    fireEvent.click(within(day('Monday')).getByRole('switch', { name: 'Open on Monday' }))
    expect(sortWindows(onChange.mock.lastCall![0])).toEqual([w(2, 540, 1020), w(3, 600, 900)])
  })

  it('adds another window to a day, edits it, and removes it', () => {
    const onChange = perDay([w(1, 540, 1080), w(3, 600, 900)])
    fireEvent.click(within(day('Monday')).getByRole('button', { name: 'Another window on Monday' }))
    expect(within(day('Monday')).getAllByLabelText('Opens, Monday')).toHaveLength(2)
    commit(within(day('Monday')).getAllByLabelText('Closes, Monday')[0], '5:30 PM')
    expect(sortWindows(onChange.mock.lastCall![0]).filter((x) => x.day_of_week === 1)[0]).toEqual(w(1, 540, 1050))
    fireEvent.click(within(day('Monday')).getAllByRole('button', { name: /^Remove Monday hours/ })[1])
    expect(within(day('Monday')).getAllByLabelText('Opens, Monday')).toHaveLength(1)
  })

  it('Always open sets one whole day window on every day', () => {
    const onChange = perDay([w(1, 540, 1080), w(3, 600, 900)])
    fireEvent.click(screen.getByRole('button', { name: 'Always open' }))
    expect(onChange).toHaveBeenLastCalledWith([0, 1, 2, 3, 4, 5, 6].map((d) => w(d, 0, 1440)))
  })

  it('a time typed into a middle window that re-sorts the day keeps the focus in that field (#2137)', () => {
    perDay([w(1, 480, 600), w(1, 720, 840), w(1, 960, 1080)])
    const middle = within(day('Monday')).getAllByLabelText('Opens, Monday')[1]
    middle.focus()
    // 7:00 AM sorts the middle window first.
    commit(middle, '7:00 AM')
    const opens = within(day('Monday')).getAllByLabelText('Opens, Monday')
    expect(opens.map((o) => (o as HTMLInputElement).value)).toEqual(['7:00 AM', '8:00 AM', '4:00 PM'])
    expect(document.activeElement).toBe(opens[0])
    expect(opens[0]).toBe(middle)
  })

  it('a close at or before its open is flagged beside the window', () => {
    perDay([w(1, 600, 600), w(2, 540, 1020)])
    expect(screen.getByRole('alert')).toHaveTextContent(/closes must be after opens/i)
  })

  it('draws a window that crosses midnight in the display zone on the days it touches', () => {
    // Monday 1:00 AM to 9:00 AM Eastern is Sunday 10:00 PM to Monday 6:00 AM Pacific.
    perDay([w(1, 60, 540)], vi.fn(), 'America/Los_Angeles')
    expect([within(day('Sunday')).getByLabelText('Opens, Sunday'), within(day('Sunday')).getByLabelText('Closes, Sunday')].map((b) => (b as HTMLInputElement).value)).toEqual(['10:00 PM', '12:00 AM'])
    expect([within(day('Monday')).getByLabelText('Opens, Monday'), within(day('Monday')).getByLabelText('Closes, Monday')].map((b) => (b as HTMLInputElement).value)).toEqual(['12:00 AM', '6:00 AM'])
    expect(within(day('Tuesday')).getByText('Closed')).toBeInTheDocument()
  })

  it('switching off a day that holds part of a window crossing midnight keeps the other day\'s part', () => {
    // Sunday 10:00 PM to Monday 6:00 AM Pacific; Sunday switched off leaves Monday 12:00 AM to 6:00 AM, 3:00 AM to 9:00 AM Eastern.
    const onChange = perDay([w(1, 60, 540)], vi.fn(), 'America/Los_Angeles')
    fireEvent.click(within(day('Sunday')).getByRole('switch', { name: 'Open on Sunday' }))
    expect(onChange).toHaveBeenLastCalledWith([w(1, 180, 540)])
  })

  it('a day switched on in Central stores the Eastern window it means', () => {
    const onChange = perDay([w(1, 540, 1080), w(3, 600, 900)], vi.fn(), 'America/Chicago')
    fireEvent.click(within(day('Tuesday')).getByRole('switch', { name: 'Open on Tuesday' }))
    // 9:00 AM to 5:00 PM Central is 10:00 AM to 6:00 PM Eastern.
    expect(sortWindows(onChange.mock.lastCall![0]).filter((x) => x.day_of_week === 2)).toEqual([w(2, 600, 1080)])
  })
})

describe('the per day view stays while the person edits (#2324 review)', () => {
  it('hours that differ open per day, and editing them until they match keeps the per day rows', () => {
    function Host() {
      const [value, setValue] = useState<ProfileWindowDocument[]>([...weekdays.slice(0, 4), w(5, 540, 1020)])
      return <WeeklyHoursEditor value={value} onChange={setValue} />
    }
    render(<Host />)
    const friday = screen.getByRole('group', { name: 'Friday' })
    commit(within(friday).getByLabelText('Closes, Friday'), '9:00 PM')
    // Every open day now has the same hours, and the view the person is working in stays.
    expect(screen.getByRole('group', { name: 'Friday' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Days open' })).toBeNull()
  })
})
