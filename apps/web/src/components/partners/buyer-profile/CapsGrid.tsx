'use client'

/**
 * The caps grid (#1412): four caps the buyer ledger refuses from. An empty box
 * is no cap, which is a different fact from a cap of zero, and the two stay
 * distinct through to the stored document. Spend is typed in dollars and stored
 * in cents. The scope is stated once from the wired populations (L582, L287).
 */
import { useId } from 'react'
import { WIRED_POPULATIONS } from '@bidspoke/buyer-profile'
import { Field, NumberInput, describedBy } from '@/components/ui/form'
import { POPULATION_LABELS } from './labels'

export interface CapsValue {
  hourly_lead_cap: number | null
  daily_lead_cap: number | null
  hourly_spend_cap_cents: number | null
  daily_spend_cap_cents: number | null
}

export interface CapsErrors {
  hourlyLeadCap?: string
  dailyLeadCap?: string
  hourlySpendCapCents?: string
  dailySpendCapCents?: string
}

const centsToDollars = (cents: number | null): number | null => (cents === null ? null : Math.round(cents) / 100)
const dollarsToCents = (dollars: number | null): number | null => (dollars === null ? null : Math.round(dollars * 100))

export function CapsGrid({ value, onChange, errors = {} }: { value: CapsValue; onChange: (next: CapsValue) => void; errors?: CapsErrors }) {
  const base = useId()
  const patch = (next: Partial<CapsValue>) => onChange({ ...value, ...next })
  const scope = WIRED_POPULATIONS.map((p) => POPULATION_LABELS[p]).join(', ')

  // The unit and the empty rule are said once for the four boxes, in the
  // sentence every box is described by (L605), not as a hint under each.
  const noteId = `${base}-note`
  const cell = (id: string, label: string, error: string | undefined, input: (db: string | undefined) => React.ReactNode) => (
    <Field id={id} label={label} error={error}>
      {input([noteId, describedBy(id, false, Boolean(error))].filter(Boolean).join(' '))}
    </Field>
  )

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {cell(`${base}-hl`, 'Leads per hour', errors.hourlyLeadCap, (db) => (
          <NumberInput id={`${base}-hl`} value={value.hourly_lead_cap} onChange={(v) => patch({ hourly_lead_cap: v })} min={0} step={1} describedBy={db} />
        ))}
        {cell(`${base}-dl`, 'Leads per day', errors.dailyLeadCap, (db) => (
          <NumberInput id={`${base}-dl`} value={value.daily_lead_cap} onChange={(v) => patch({ daily_lead_cap: v })} min={0} step={1} describedBy={db} />
        ))}
        {cell(`${base}-hs`, 'Spend per hour', errors.hourlySpendCapCents, (db) => (
          <NumberInput id={`${base}-hs`} value={centsToDollars(value.hourly_spend_cap_cents)} onChange={(v) => patch({ hourly_spend_cap_cents: dollarsToCents(v) })} min={0} step={0.01} describedBy={db} />
        ))}
        {cell(`${base}-ds`, 'Spend per day', errors.dailySpendCapCents, (db) => (
          <NumberInput id={`${base}-ds`} value={centsToDollars(value.daily_spend_cap_cents)} onChange={(v) => patch({ daily_spend_cap_cents: dollarsToCents(v) })} min={0} step={0.01} describedBy={db} />
        ))}
      </div>
      <p id={noteId} className="text-xs text-gray-500">Spend is in dollars. An empty box is no cap. Counts sales made through buyer selection: {scope}. Hours and days are Eastern time.</p>
    </div>
  )
}
