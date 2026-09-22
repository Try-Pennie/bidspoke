'use client'

/**
 * The blackout dates editor (#1412): Eastern calendar days the buyer takes
 * off, each with an optional note, kept sorted, rendered as one table row per
 * date however many there are. A table, not a stack of labelled forms: the
 * Date and Note headers are said once, so sixty dates are sixty short rows
 * (L579), and each control is named for a screen reader through the header
 * it sits under plus its own row.
 */
import { useId } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { ProfileBlackoutDocument } from '@bidspoke/buyer-profile'
import { Button, TextInput } from '@/components/ui/form'

export function BlackoutDatesEditor({ value, onChange, errors = {} }: { value: readonly ProfileBlackoutDocument[]; onChange: (dates: ProfileBlackoutDocument[]) => void; errors?: Record<string, string> }) {
  const base = useId()
  // Empty dates (a row just added) sort first so the person sees the row they asked for.
  const sorted = [...value].sort((a, b) => a.date.localeCompare(b.date))
  const update = (target: ProfileBlackoutDocument, next: ProfileBlackoutDocument | null) =>
    onChange(sorted.flatMap((b) => (b === target ? (next ? [next] : []) : [b])))

  return (
    <div className="space-y-2">
      {sorted.length === 0 ? (
        <p className="text-xs text-gray-500">No days off.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-gray-600">
              <th scope="col" className="w-40 pb-1 pr-2 font-medium">Date</th>
              <th scope="col" className="pb-1 pr-2 font-medium">Note</th>
              <th scope="col" className="w-10 pb-1"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => {
              const rowId = `${base}-${i}`
              const error = errors[`blackout_dates[${row.date}]`]
              const name = row.date || 'new date'
              return (
                <tr key={`${row.date}-${i}`} aria-label={`Blackout ${row.date || 'new'}`} className="align-top">
                  <td className="py-0.5 pr-2">
                    <TextInput id={`${rowId}-date`} type="date" value={row.date} onChange={(d) => update(row, { ...row, date: d })} aria-label={`Date, ${name}`} />
                    {error && <p role="alert" className="mt-1 text-xs text-red-700">{error}</p>}
                  </td>
                  <td className="py-0.5 pr-2">
                    <TextInput id={`${rowId}-note`} value={row.note ?? ''} onChange={(n) => update(row, { ...row, note: n === '' ? null : n })} aria-label={`Note, ${name}`} />
                  </td>
                  <td className="py-0.5">
                    <Button variant="ghost" aria-label={`Remove ${name}`} onClick={() => update(row, null)}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <Button variant="ghost" aria-label="Add date" onClick={() => onChange([...sorted, { date: '', note: null }])}>
        <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add date
      </Button>
    </div>
  )
}
