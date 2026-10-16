'use client'

/**
 * The weekly hours editor (#1412): seven days from the shared vocabulary, any
 * number of windows a day in Eastern time, an "Always open" preset, and a
 * window whose close is not after its open flagged beside it. No windows means
 * the buyer is never offered a lead (L72), stated once. Opens and Closes are
 * column headers said once over the seven rows, not labels on each (L579).
 * Times are typed (design round 1 of #2137), and each window keeps a stable
 * id, so committing a time that re-sorts the day keeps the focus in the field.
 */
import { useId } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { DAYS_OF_WEEK, type ProfileWindowDocument } from '@bidspoke/buyer-profile'
import { Button } from '@/components/ui/form'
import { TimeField } from '@/components/ui/DateTimeFields'
import { formatTime } from '@/components/ui/date-time'
import { useRowIds } from './row-ids'

const DEFAULT_WINDOW = { opens_minute: 540, closes_minute: 1020 }

export function WeeklyHoursEditor({ value, onChange }: { value: readonly ProfileWindowDocument[]; onChange: (windows: ProfileWindowDocument[]) => void }) {
  const base = useId()
  const rows = useRowIds<ProfileWindowDocument>()
  const sorted = [...value].sort((a, b) => a.day_of_week - b.day_of_week || a.opens_minute - b.opens_minute)

  const replaceWindow = (target: ProfileWindowDocument, next: ProfileWindowDocument | null) =>
    onChange(sorted.flatMap((w) => (w === target ? (next ? [rows.carry(target, next)] : []) : [w])))
  const addWindow = (day: number) => onChange([...sorted, { day_of_week: day, ...DEFAULT_WINDOW }])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500">{value.length === 0 ? 'With no hours the buyer is never offered a lead.' : ''}</p>
        <Button variant="ghost" onClick={() => onChange(DAYS_OF_WEEK.map((d) => ({ day_of_week: d.index, opens_minute: 0, closes_minute: 1440 })))}>Always open</Button>
      </div>
      <div className="grid grid-cols-[7rem_9rem_9rem_1fr] items-center gap-x-2 text-xs font-medium text-gray-600" aria-hidden="true">
        <span>Day</span>
        <span>Opens</span>
        <span>Closes</span>
        <span />
      </div>
      {DAYS_OF_WEEK.map((day) => {
        const windows = sorted.filter((w) => w.day_of_week === day.index)
        return (
          <fieldset key={day.index} aria-label={day.label} className="border-t border-gray-100 py-1">
            <legend className="sr-only">{day.label}</legend>
            {windows.length === 0 ? (
              <div className="grid grid-cols-[7rem_1fr] items-center gap-x-2">
                <span className="text-xs font-medium text-gray-600" aria-hidden="true">{day.label}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">Closed</span>
                  <Button variant="ghost" aria-label={`Add hours on ${day.label}`} onClick={() => addWindow(day.index)}>
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add hours
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                {windows.map((w, i) => {
                  const key = rows.idOf(w)
                  const rowId = `${base}-${key}`
                  const invalid = w.closes_minute <= w.opens_minute
                  const opens = formatTime(w.opens_minute)
                  return (
                    <div key={key}>
                      <div className="grid grid-cols-[7rem_9rem_9rem_1fr] items-start gap-x-2">
                        <span className="pt-1.5 text-xs font-medium text-gray-600" aria-hidden="true">{i === 0 ? day.label : ''}</span>
                        <TimeField id={`${rowId}-open`} edge="start" value={w.opens_minute} label={`Opens, ${day.label}`} onChange={(m) => replaceWindow(w, { ...w, opens_minute: m })} className="w-[8.5rem]" />
                        <TimeField id={`${rowId}-close`} edge="end" value={w.closes_minute} label={`Closes, ${day.label}`} onChange={(m) => replaceWindow(w, { ...w, closes_minute: m })} className="w-[8.5rem]" />
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" aria-label={`Remove ${day.label} hours from ${opens}`} onClick={() => replaceWindow(w, null)}>
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                          {i === windows.length - 1 && (
                            <Button variant="ghost" aria-label={`Add hours on ${day.label}`} onClick={() => addWindow(day.index)}>
                              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                            </Button>
                          )}
                        </div>
                      </div>
                      {invalid && <p role="alert" className="mt-1 text-xs text-red-700">Closes must be after opens.</p>}
                    </div>
                  )
                })}
              </div>
            )}
          </fieldset>
        )
      })}
    </div>
  )
}
