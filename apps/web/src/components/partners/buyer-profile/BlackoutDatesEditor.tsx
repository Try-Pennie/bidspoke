'use client'

/**
 * The blackout dates editor (#1412): Eastern calendar days the buyer takes
 * off, kept sorted.
 *
 * Drawn as the settled design draws it (#2325, PM-22, frames 1 and 19): a
 * list, one row per day off reading its weekday and date ("Thursday, Nov 26,
 * 2026") with the grey remove mark, then Add date. A row just added, or one
 * whose date is not a calendar day, is a date box to type or pick the day in
 * (design round 1 of #2137); once the day is a real one it reads as the row.
 * The list carries no Note column: a note already stored is shown after its
 * date, so it is never hidden (L1008), and is removed with the day.
 */
import { useId } from 'react'
import { Plus } from 'lucide-react'
import type { ProfileBlackoutDocument } from '@bidspoke/buyer-profile'
import { Button, FieldError } from '@/components/ui/form'
import { DateField } from '@/components/ui/DateTimeFields'
import { formatWeekdayDate, isIsoDate } from '@/components/ui/date-time'
import { useRowIds } from './row-ids'
import { RemoveButton } from '@/components/partners/RemoveButton'

/** How a row is named: the day as the list shows it. */
export function blackoutRowName(date: string): string {
  if (date === '') return 'new date'
  return isIsoDate(date) ? formatWeekdayDate(date) : date
}

export function BlackoutDatesEditor({ value, onChange, errors = {} }: { value: readonly ProfileBlackoutDocument[]; onChange: (dates: ProfileBlackoutDocument[]) => void; errors?: Record<string, string> }) {
  const base = useId()
  const rows = useRowIds<ProfileBlackoutDocument>()
  // Empty dates (a row just added) sort first so the person sees the row they asked for.
  const sorted = [...value].sort((a, b) => a.date.localeCompare(b.date))
  const update = (target: ProfileBlackoutDocument, next: ProfileBlackoutDocument | null) =>
    onChange(sorted.flatMap((b) => (b === target ? (next ? [rows.carry(target, next)] : []) : [b])))

  return (
    <div className="space-y-1.5">
      {sorted.length === 0 ? (
        <p className="text-xs text-hint">No days off.</p>
      ) : (
        <ul aria-label="Days off" className="max-w-[20rem] divide-y divide-line-soft text-[13px] text-graphite">
          {sorted.map((row) => {
            const key = rows.idOf(row)
            const rowId = `${base}-${key}`
            const error = errors[`blackout_dates[${row.date}]`]
            const name = blackoutRowName(row.date)
            const settled = isIsoDate(row.date)
            return (
              <li key={key} className="py-1 first:pt-0">
                <div className="flex items-center justify-between gap-3">
                  {settled ? (
                    <span>
                      {name}
                      {row.note ? <span className="text-hint"> {row.note}</span> : null}
                    </span>
                  ) : (
                    <DateField id={`${rowId}-date`} value={row.date} onChange={(d) => update(row, { ...row, date: d })} label={`Date, ${name}`} />
                  )}
                  <RemoveButton label={`Remove ${name}`} onClick={() => update(row, null)} />
                </div>
                {error && <FieldError alert size="xs" className="mt-1">{error}</FieldError>}
              </li>
            )
          })}
        </ul>
      )}
      <div>
        <Button variant="quiet" aria-label="Add date" onClick={() => onChange([...sorted, { date: '', note: null }])}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add date
        </Button>
      </div>
    </div>
  )
}
