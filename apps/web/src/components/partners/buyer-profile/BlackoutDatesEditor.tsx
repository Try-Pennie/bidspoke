'use client'

/**
 * The blackout dates editor (#1412): Eastern calendar days the buyer takes
 * off, each with an optional note, kept sorted, rendered as one table row per
 * date however many there are. A table, not a stack of labelled forms: the
 * Date and Note headers are said once, so sixty dates are sixty short rows
 * (L579), and each control is named for a screen reader through the header
 * it sits under plus its own row. A date is typed or picked from a calendar
 * (design round 1 of #2137), and each row keeps a stable id, so committing a
 * date that re-sorts the list keeps the focus in the field.
 */
import { useId } from 'react'
import { Plus } from 'lucide-react'
import type { ProfileBlackoutDocument } from '@bidspoke/buyer-profile'
import { Button, FieldError, TextInput } from '@/components/ui/form'
import { DateField } from '@/components/ui/DateTimeFields'
import { formatShortDate, isIsoDate } from '@/components/ui/date-time'
import { useRowIds } from './row-ids'
import { RemoveButton } from '@/components/partners/RemoveButton'

/** How a row is named to a screen reader: the date as the page shows it. */
export function blackoutRowName(date: string): string {
  if (date === '') return 'new date'
  return isIsoDate(date) ? formatShortDate(date) : date
}

export function BlackoutDatesEditor({ value, onChange, errors = {} }: { value: readonly ProfileBlackoutDocument[]; onChange: (dates: ProfileBlackoutDocument[]) => void; errors?: Record<string, string> }) {
  const base = useId()
  const rows = useRowIds<ProfileBlackoutDocument>()
  // Empty dates (a row just added) sort first so the person sees the row they asked for.
  const sorted = [...value].sort((a, b) => a.date.localeCompare(b.date))
  const update = (target: ProfileBlackoutDocument, next: ProfileBlackoutDocument | null) =>
    onChange(sorted.flatMap((b) => (b === target ? (next ? [rows.carry(target, next)] : []) : [b])))

  return (
    <div className="space-y-2">
      {sorted.length === 0 ? (
        <p className="text-xs text-hint">No days off.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-gray-600">
              <th scope="col" className="w-48 pb-1 pr-2 font-medium">Date</th>
              <th scope="col" className="pb-1 pr-2 font-medium">Note</th>
              <th scope="col" className="w-10 pb-1"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const key = rows.idOf(row)
              const rowId = `${base}-${key}`
              const error = errors[`blackout_dates[${row.date}]`]
              const name = blackoutRowName(row.date)
              return (
                <tr key={key} aria-label={`Blackout ${name}`} className="align-top">
                  <td className="py-0.5 pr-2">
                    <DateField id={`${rowId}-date`} value={row.date} onChange={(d) => update(row, { ...row, date: d })} label={`Date, ${name}`} />
                    {error && <FieldError alert size="xs" className="mt-1">{error}</FieldError>}
                  </td>
                  <td className="py-0.5 pr-2">
                    <TextInput id={`${rowId}-note`} value={row.note ?? ''} onChange={(n) => update(row, { ...row, note: n === '' ? null : n })} aria-label={`Note, ${name}`} />
                  </td>
                  <td className="py-0.5">
                    <RemoveButton label={`Remove ${name}`} onClick={() => update(row, null)} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <Button variant="quiet" aria-label="Add date" onClick={() => onChange([...sorted, { date: '', note: null }])}>
        <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add date
      </Button>
    </div>
  )
}
