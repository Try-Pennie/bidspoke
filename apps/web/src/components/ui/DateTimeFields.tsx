'use client'

/**
 * DateField and TimeField (design round 1 of #2137, "Typed, with a
 * calendar"), part of the design system controls in form.tsx, in a file of
 * their own so a route with no date or time does not load the calendar and
 * @radix-ui/react-popover.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import * as RadixPopover from '@radix-ui/react-popover'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { holdEnter } from './form'
import {
  addDays, addMonths, endOfWeek, formatShortDate, formatTime, fullDateName, isIsoDate, monthGrid, monthTitle,
  parseTypedDate, parseTypedTime, startOfWeek, todayEastern, yearMonthOf,
} from './date-time'

/**
 * A typed box that keeps its own draft and commits it on blur or Enter (#2137).
 * Enter never submits the form. A draft that does not read stays on screen with
 * the reason beside it, marks the box invalid so the form will not submit, and
 * is never silently dropped; the box shows the stored value again whenever that
 * value changes from outside.
 */
function useTypedDraft<T>({ value, show, read, onChange }: {
  value: T
  show: (v: T) => string
  read: (text: string) => { ok: true; value: T } | { ok: false; message: string }
  onChange: (v: T) => void
}) {
  const [draft, setDraft] = useState(() => show(value))
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  function resync() {
    setDraft(show(value))
    setError(null)
  }
  // `show` is a pure formatter; only a new stored value resyncs the box.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(resync, [value])
  useEffect(() => {
    inputRef.current?.setCustomValidity(error ?? '')
  }, [error])
  function commit() {
    // An untouched box is not a commit: a stored value that reads back
    // differently (a close stored as 1439 reads as 1440, a stored day that is
    // not a calendar day) must not be rewritten or flagged by tabbing through.
    if (draft === show(value)) { setError(null); return }
    const result = read(draft)
    if (!result.ok) { setError(result.message); return }
    setError(null)
    setDraft(show(result.value))
    if (result.value !== value) onChange(result.value)
  }
  return { draft, setDraft, error, commit, resync, inputRef }
}

interface DateFieldProps {
  id: string
  /** `YYYY-MM-DD`, or '' for no date yet. */
  value: string
  onChange: (date: string) => void
  /** The field's name, read out on the box and its calendar button. */
  label: string
  placeholder?: string
  describedBy?: string
  disabled?: boolean
  /** The clock "today" is read from. A test passes a fixed one. */
  now?: () => number
}

/**
 * A date, typed or picked from a small month calendar in a popover (design
 * round 1 of #2137, "Typed, with a calendar"). Accepted typed forms are listed
 * in date-time.ts. The calendar follows the WAI-ARIA date picker pattern: a
 * grid with one tab stop, arrows by day and week, Page Up and Page Down by
 * month (with Shift, by year), Home and End to the week's ends, the full date
 * as each day's name, today marked current, and Escape back to the button.
 */
export function DateField({ id, value, onChange, label, placeholder, describedBy: db, disabled, now = Date.now }: DateFieldProps) {
  const errorId = `${id}-error`
  const [open, setOpen] = useState(false)
  const { draft, setDraft, error, commit, resync, inputRef } = useTypedDraft<string>({
    value,
    show: (v) => (isIsoDate(v) ? formatShortDate(v) : v),
    read: (text) => {
      if (text.trim() === '') return { ok: true, value: '' }
      const r = parseTypedDate(text, todayEastern(now()))
      return r.ok ? { ok: true, value: r.date } : r
    },
    onChange,
  })
  const describedIds = [db, error ? errorId : null].filter(Boolean).join(' ') || undefined
  return (
    <div>
      <RadixPopover.Root open={open} onOpenChange={setOpen}>
        <div className="date-field">
          <input
            id={id}
            ref={inputRef}
            type="text"
            value={draft}
            placeholder={placeholder}
            disabled={disabled}
            aria-label={label}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedIds}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => holdEnter(e, commit)}
            className="input date-field-input"
          />
          <RadixPopover.Trigger asChild>
            <button type="button" disabled={disabled} aria-label={`Choose ${label} from a calendar`} className="date-field-button">
              <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </RadixPopover.Trigger>
        </div>
        <RadixPopover.Portal>
          <RadixPopover.Content
            align="start"
            sideOffset={4}
            aria-label={`Calendar for ${label}`}
            className="popover"
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <Calendar
              selected={isIsoDate(value) ? value : null}
              today={todayEastern(now())}
              onPick={(date) => { setOpen(false); if (date !== value) onChange(date); else resync() }}
            />
          </RadixPopover.Content>
        </RadixPopover.Portal>
      </RadixPopover.Root>
      {error && <p id={errorId} role="alert" className="mt-1 text-xs text-red-700">{error}</p>}
    </div>
  )
}

const WEEKDAY_HEADERS = [['S', 'Sunday'], ['M', 'Monday'], ['T', 'Tuesday'], ['W', 'Wednesday'], ['T', 'Thursday'], ['F', 'Friday'], ['S', 'Saturday']] as const

function Calendar({ selected, today, onPick }: { selected: string | null; today: string; onPick: (date: string) => void }) {
  const titleId = useId()
  const [focused, setFocused] = useState(selected ?? today)
  const gridRef = useRef<HTMLTableElement | null>(null)
  // The day takes the focus when the calendar opens and when a key moves it;
  // the month buttons change the month and leave the focus where it was.
  const moveFocus = useRef(true)
  const { year, month } = yearMonthOf(focused)
  useEffect(() => {
    if (!moveFocus.current) return
    moveFocus.current = false
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus()
  }, [focused])
  function onKey(e: KeyboardEvent<HTMLButtonElement>, date: string) {
    const moves: Record<string, () => string> = {
      ArrowLeft: () => addDays(date, -1),
      ArrowRight: () => addDays(date, 1),
      ArrowUp: () => addDays(date, -7),
      ArrowDown: () => addDays(date, 7),
      PageUp: () => addMonths(date, e.shiftKey ? -12 : -1),
      PageDown: () => addMonths(date, e.shiftKey ? 12 : 1),
      Home: () => startOfWeek(date),
      End: () => endOfWeek(date),
    }
    if (moves[e.key]) {
      e.preventDefault()
      const next = moves[e.key]()
      // Home on a Sunday lands where it is: no move, so no flag left set to
      // steal the focus on the next month button press.
      if (next === date) return
      moveFocus.current = true
      setFocused(next)
      return
    }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(date) }
  }
  return (
    <div className="calendar">
      <div className="calendar-nav">
        <button type="button" aria-label="Previous month" className="calendar-step" onClick={() => setFocused(addMonths(focused, -1))}>
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <span id={titleId} aria-live="polite" className="calendar-title">{monthTitle(year, month)}</span>
        <button type="button" aria-label="Next month" className="calendar-step" onClick={() => setFocused(addMonths(focused, 1))}>
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <table ref={gridRef} role="grid" aria-labelledby={titleId} className="calendar-grid">
        <thead>
          <tr>
            {WEEKDAY_HEADERS.map(([short, full], i) => <th key={i} scope="col" abbr={full} className="calendar-weekday">{short}</th>)}
          </tr>
        </thead>
        <tbody>
          {monthGrid(year, month).map((week, w) => (
            <tr key={w}>
              {week.map((date, d) => (
                <td key={d} role="gridcell" aria-selected={date !== null && date === selected ? true : undefined}>
                  {date && (
                    <button
                      type="button"
                      data-date={date}
                      tabIndex={date === focused ? 0 : -1}
                      aria-label={fullDateName(date)}
                      aria-current={date === today ? 'date' : undefined}
                      onClick={() => onPick(date)}
                      onKeyDown={(e) => onKey(e, date)}
                      className={`calendar-day ${date === selected ? 'calendar-day-selected' : ''}`.trim()}
                    >
                      {Number(date.slice(8))}
                    </button>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * A time of day, typed (design round 1 of #2137). Minutes in, minutes out.
 * `edge` says which end of a window the box is: at the end, 12:00 AM is the
 * midnight that closes the day (1440). Accepted forms are listed in date-time.ts.
 */
export function TimeField({ id, value, onChange, label, edge, placeholder, describedBy: db, disabled, className }: {
  id: string
  value: number
  onChange: (minutes: number) => void
  label: string
  placeholder?: string
  edge: 'start' | 'end'
  describedBy?: string
  disabled?: boolean
  className?: string
}) {
  const errorId = `${id}-error`
  const { draft, setDraft, error, commit, inputRef } = useTypedDraft<number>({
    value,
    show: formatTime,
    read: (text) => {
      const r = parseTypedTime(text, edge)
      return r.ok ? { ok: true, value: r.minutes } : r
    },
    onChange,
  })
  return (
    <div className={className}>
      <input
        id={id}
        ref={inputRef}
        type="text"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={[db, error ? errorId : null].filter(Boolean).join(' ') || undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => holdEnter(e, commit)}
        className="input"
      />
      {error && <p id={errorId} role="alert" className="mt-1 text-xs text-red-700">{error}</p>}
    </div>
  )
}
