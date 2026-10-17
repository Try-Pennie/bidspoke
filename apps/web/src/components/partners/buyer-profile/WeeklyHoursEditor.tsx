'use client'

/**
 * The weekly hours editor (#1412): seven days from the shared vocabulary, any
 * number of windows a day (stored in Eastern time), an "Always open" preset, and
 * a window whose close is not after its open flagged beside it. No windows means
 * the buyer is never offered a lead (L72), stated once.
 *
 * Drawn as the settled design draws it (#2324, PM-21): the same hours every day
 * first, as day chips and one range, and "Set different hours for each day"
 * opens one row per day, each with a switch, its ranges and "Another window",
 * with "Same hours every day" back. Which view shows is read from the hours:
 * hours that differ by day open in the per day view and are never flattened by
 * being looked at (sharedHoursOf). Going back to the same hours from hours that
 * differ is the person's choice, and gives every open day the first open day's
 * range, which the save bar then names.
 *
 * The windows are stored in Eastern and drawn in the profile's display zone
 * (#2143, PM-10): display-zone.ts shifts them, draws one that crosses midnight
 * there on both days, and turns an edit back into the Eastern windows it means.
 * Times are typed (design round 1 of #2137), and each window keeps a stable id,
 * so committing a time that re-sorts the day keeps the focus in the field.
 */
import { useId, useState } from 'react'
import { DAYS_OF_WEEK, DEFAULT_DISPLAY_TIME_ZONE, type DisplayTimeZone, type ProfileWindowDocument } from '@bidspoke/buyer-profile'
import { Button, ChipCheck, FieldError } from '@/components/ui/form'
import { Toggle } from '@/components/ui/Toggle'
import { TimeField } from '@/components/ui/DateTimeFields'
import { formatTime } from '@/components/ui/date-time'
import { zoneShiftFromEastern } from '@/lib/dates'
import { addDisplayWindow, displayWindows, replaceDisplayWindow, sharedHoursOf, sharedWindows, type DisplayWindow } from './display-zone'
import { useRowIds } from './row-ids'
import { RemoveButton } from '@/components/partners/RemoveButton'

/** The range a newly opened day gets, as drawn in the display zone. */
const DEFAULT_RANGE = { opens_minute: 540, closes_minute: 1020 }
const NEVER_OPEN = 'With no hours the buyer is never offered a lead.'
const CLOSE_AFTER_OPEN = 'Closes must be after opens.'

export function WeeklyHoursEditor({ value, onChange, zone = DEFAULT_DISPLAY_TIME_ZONE }: { value: readonly ProfileWindowDocument[]; onChange: (windows: ProfileWindowDocument[]) => void; zone?: DisplayTimeZone }) {
  const base = useId()
  const rows = useRowIds<ProfileWindowDocument>()
  const shift = zoneShiftFromEastern(zone)
  const sorted = [...value].sort((a, b) => a.day_of_week - b.day_of_week || a.opens_minute - b.opens_minute)
  const shown = displayWindows(sorted, shift)
  const shared = sharedHoursOf(sorted, shift)
  // Once hours that differ have opened the per day view, it stays while the
  // person edits, even when their edits make every day match; only "Same hours
  // every day" goes back.
  const [perDayChosen, setPerDayChosen] = useState(() => shared === null)
  if (shared === null && !perDayChosen) setPerDayChosen(true)
  // The range the chips open a day for while no day is open, so a range typed first is kept.
  const [idleRange, setIdleRange] = useState(DEFAULT_RANGE)
  const perDay = perDayChosen || shared === null

  if (!perDay && shared) {
    const range = shared.range ?? idleRange
    const setDays = (days: number[]) => onChange(sharedWindows(days, range, shift))
    const setRange = (next: typeof range) => {
      setIdleRange(next)
      if (shared.days.length > 0) onChange(sharedWindows(shared.days, next, shift))
    }
    const invalid = shared.days.length > 0 && range.closes_minute <= range.opens_minute
    return (
      <div className="space-y-2.5">
        {value.length === 0 && <p className="text-xs text-hint">{NEVER_OPEN}</p>}
        <div role="group" aria-label="Days open" className="flex flex-wrap gap-1.5">
          {DAYS_OF_WEEK.map((day) => (
            <ChipCheck
              key={day.index}
              size="lg"
              label={day.label}
              shortLabel={day.label.slice(0, 3)}
              checked={shared.days.includes(day.index)}
              onChange={(on) => setDays(on ? [...shared.days, day.index] : shared.days.filter((d) => d !== day.index))}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <TimeField id={`${base}-shared-open`} edge="start" value={range.opens_minute} label="Opens" onChange={(m) => setRange({ ...range, opens_minute: m })} className="w-[6.5rem]" />
          <span className="text-xs text-hint">to</span>
          <TimeField id={`${base}-shared-close`} edge="end" value={range.closes_minute} label="Closes" onChange={(m) => setRange({ ...range, closes_minute: m })} className="w-[6.5rem]" />
        </div>
        {invalid && <FieldError alert size="xs">{CLOSE_AFTER_OPEN}</FieldError>}
        <div>
          <Button variant="quiet" onClick={() => setPerDayChosen(true)}>Set different hours for each day</Button>
        </div>
      </div>
    )
  }

  // The first window an edit writes keeps the edited row's id, so a re-sort keeps the focus.
  const replaceWindow = (target: DisplayWindow, next: Pick<ProfileWindowDocument, 'day_of_week' | 'opens_minute' | 'closes_minute'> | null) => {
    const out = replaceDisplayWindow(sorted, shift, target, next)
    const written = out.find((w) => !sorted.includes(w))
    if (written) rows.carry(target.sources[0], written)
    onChange(out)
  }
  const addWindow = (day: number) => onChange(addDisplayWindow(sorted, shift, { day_of_week: day, ...DEFAULT_RANGE }))
  const closeDay = (day: number) => {
    // Each row is removed through the display zone, so a window shared with the next day keeps its other half.
    // A removal takes the row's own parts, so a day has fewer rows after each one and the loop ends.
    let out = sorted
    const rowOf = () => displayWindows(out, shift).find((r) => r.day_of_week === day)
    for (let row = rowOf(); row; row = rowOf()) out = replaceDisplayWindow(out, shift, row, null)
    onChange(out)
  }
  const keyOf = (row: DisplayWindow) => `${rows.idOf(row.sources[0])}-${row.pieces[0].part}`
  // Back to the same hours: as they are when they are the same, or the first open day's range on every open day.
  const sameEveryDay = () => {
    setPerDayChosen(false)
    if (shared !== null) return
    const first = shown.find((r) => r.closes_minute > r.opens_minute) ?? shown[0]
    const days = [...new Set(shown.map((r) => r.day_of_week))]
    onChange(sharedWindows(days, { opens_minute: first.opens_minute, closes_minute: first.closes_minute }, shift))
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-hint">{value.length === 0 ? NEVER_OPEN : ''}</p>
        <div className="flex items-center gap-1">
          <Button variant="quiet" onClick={sameEveryDay}>Same hours every day</Button>
          <Button variant="quiet" onClick={() => onChange(DAYS_OF_WEEK.map((d) => ({ day_of_week: d.index, opens_minute: 0, closes_minute: 1440 })))}>Always open</Button>
        </div>
      </div>
      <div>
        {DAYS_OF_WEEK.map((day) => {
          const windows = shown.filter((w) => w.day_of_week === day.index)
          const open = windows.length > 0
          return (
            <fieldset key={day.index} aria-label={day.label} className="grid grid-cols-[6rem_2.75rem_1fr] items-start gap-x-2 border-t border-line-soft py-1.5 first:border-t-0">
              <legend className="sr-only">{day.label}</legend>
              <span className={`pt-1.5 text-[13px] ${open ? 'text-graphite' : 'text-hint'}`} aria-hidden="true">{day.label}</span>
              <div className="pt-1.5">
                <Toggle id={`${base}-${day.index}-open`} checked={open} onChange={(on) => (on ? addWindow(day.index) : closeDay(day.index))} label={`Open on ${day.label}`} />
              </div>
              {!open ? (
                <span className="pt-1.5 text-xs text-hint">Closed</span>
              ) : (
                <div className="space-y-1">
                  {windows.map((w, i) => {
                    const key = keyOf(w)
                    const rowId = `${base}-${key}`
                    const invalid = w.closes_minute <= w.opens_minute
                    return (
                      <div key={key}>
                        <div className="flex flex-wrap items-center gap-2">
                          <TimeField id={`${rowId}-open`} edge="start" value={w.opens_minute} label={`Opens, ${day.label}`} onChange={(m) => replaceWindow(w, { ...w, opens_minute: m })} className="w-[6.5rem]" />
                          <span className="text-xs text-hint">to</span>
                          <TimeField id={`${rowId}-close`} edge="end" value={w.closes_minute} label={`Closes, ${day.label}`} onChange={(m) => replaceWindow(w, { ...w, closes_minute: m })} className="w-[6.5rem]" />
                          {windows.length > 1 && <RemoveButton label={`Remove ${day.label} hours from ${formatTime(w.opens_minute)}`} onClick={() => replaceWindow(w, null)} />}
                          {i === windows.length - 1 && (
                            <Button variant="quiet" aria-label={`Another window on ${day.label}`} onClick={() => addWindow(day.index)}>+ Another window</Button>
                          )}
                        </div>
                        {invalid && <FieldError alert size="xs" className="mt-1">{CLOSE_AFTER_OPEN}</FieldError>}
                      </div>
                    )
                  })}
                </div>
              )}
            </fieldset>
          )
        })}
      </div>
    </div>
  )
}
