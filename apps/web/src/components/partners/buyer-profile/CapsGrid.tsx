'use client'

/**
 * The caps grid (#1412): four caps the buyer ledger refuses from. An empty box
 * is no cap, which is a different fact from a cap of zero, and the two stay
 * distinct through to the stored document. Spend is typed in dollars and stored
 * in cents. The scope is stated once from the wired populations (L582, L287).
 * An offer buyer's caps are a table of Leads and Spend by Per hour and Per day
 * (#2325, PM-22); spend is a money box, "$" beside it.
 */
import { useId } from 'react'
import { DEFAULT_DISPLAY_TIME_ZONE, WIRED_POPULATIONS, type DisplayTimeZone, type SoldOn } from '@bidspoke/buyer-profile'
import { Field, FieldError, MoneyInput, NumberInput, describedBy } from '@/components/ui/form'
import { clickCountResetSentence, easternDayResetSentence } from './display-zone'
import { zoneShiftFromEastern } from '@/lib/dates'
import { CLICK_FIELD_LABELS, FIELD_LABELS, POPULATION_LABELS } from './labels'
import { joinAnd } from '../delete-copy'

/** Each box's name, said by a screen reader with the row and column it sits in. */
const CAP_LABELS = {
  hourly_lead_cap: FIELD_LABELS.hourly_lead_cap,
  daily_lead_cap: FIELD_LABELS.daily_lead_cap,
  hourly_spend_cap_cents: FIELD_LABELS.hourly_spend_cap_cents,
  daily_spend_cap_cents: FIELD_LABELS.daily_spend_cap_cents,
} as const

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

/**
 * `zone` is the profile's display zone and `nowMs` the clock the click count's next
 * reset is read from (#2143, PM-10): the reset is said as the hour it falls on in
 * that zone, which moves on the nights the clocks change.
 */
export function CapsGrid({ value, onChange, errors = {}, soldOn = null, zone = DEFAULT_DISPLAY_TIME_ZONE, nowMs, partnerName = 'this buyer', meter }: {
  value: CapsValue
  onChange: (next: CapsValue) => void
  errors?: CapsErrors
  soldOn?: SoldOn | null
  zone?: DisplayTimeZone
  nowMs?: number
  /** Named in a click buyer's hint: "Empty means Liberty1 is not offered at all." */
  partnerName?: string
  /** A click buyer's count against the cap, drawn beside the box (#2324). */
  meter?: React.ReactNode
}) {
  const base = useId()
  const patch = (next: Partial<CapsValue>) => onChange({ ...value, ...next })
  const scope = joinAnd(WIRED_POPULATIONS.map((p) => POPULATION_LABELS[p]))

  // The empty rule is said once for the boxes, in the sentence every box is
  // described by (L605), not as a hint under each.
  const noteId = `${base}-note`

  // A click buyer (#1541) is capped by clicks per day and nothing else: the
  // validator refuses the other three, so they are not offered.
  // Drawn as the settled design draws it (#2324, PM-21): a narrow box, the count beside it, one hint.
  if (soldOn === 'click') {
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <Field id={`${base}-dl`} label={CLICK_FIELD_LABELS.daily_lead_cap} error={errors.dailyLeadCap}>
            <NumberInput id={`${base}-dl`} value={value.daily_lead_cap} onChange={(v) => patch({ daily_lead_cap: v })} min={0} describedBy={[noteId, describedBy(`${base}-dl`, false, Boolean(errors.dailyLeadCap))].filter(Boolean).join(' ')} className="w-[7.5rem]" />
          </Field>
          {meter && <div className="pb-1.5">{meter}</div>}
        </div>
        <p id={noteId} className="text-xs text-hint">Empty means {partnerName} is not offered at all. {clickCountResetSentence(nowMs ?? Date.now(), zone)}</p>
      </div>
    )
  }

  // An offer buyer's four caps as the settled design draws them (#2325, PM-22,
  // frame 19): a table, Leads and Spend by Per hour and Per day, each empty box
  // reading No cap. Each box is named for a screen reader by its row and column.
  const box = (id: string, error: string | undefined, control: (db: string) => React.ReactNode) => (
    <td className="py-0.5 pr-3 last:pr-0">{control([noteId, error ? `${id}-error` : null].filter(Boolean).join(' '))}</td>
  )
  const cells: Array<{ id: string; label: string; error: string | undefined }> = [
    { id: `${base}-hl`, label: CAP_LABELS.hourly_lead_cap, error: errors.hourlyLeadCap },
    { id: `${base}-dl`, label: CAP_LABELS.daily_lead_cap, error: errors.dailyLeadCap },
    { id: `${base}-hs`, label: CAP_LABELS.hourly_spend_cap_cents, error: errors.hourlySpendCapCents },
    { id: `${base}-ds`, label: CAP_LABELS.daily_spend_cap_cents, error: errors.dailySpendCapCents },
  ]
  const [hl, dl, hs, ds] = cells
  return (
    <div className="space-y-1.5">
      <table className="w-full max-w-[30rem] text-[13px] text-graphite">
        <thead>
          <tr className="text-left text-[11.5px] text-hint">
            <td className="w-[4.5rem]" />
            <th scope="col" className="pb-1 pr-3 font-normal">Per hour</th>
            <th scope="col" className="pb-1 font-normal">Per day</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" className="pr-3 text-left font-normal">Leads</th>
            {box(hl.id, hl.error, (db) => <NumberInput id={hl.id} aria-label={hl.label} value={value.hourly_lead_cap} onChange={(v) => patch({ hourly_lead_cap: v })} min={0} placeholder="No cap" describedBy={db} />)}
            {box(dl.id, dl.error, (db) => <NumberInput id={dl.id} aria-label={dl.label} value={value.daily_lead_cap} onChange={(v) => patch({ daily_lead_cap: v })} min={0} placeholder="No cap" describedBy={db} />)}
          </tr>
          <tr>
            <th scope="row" className="pr-3 text-left font-normal">Spend</th>
            {box(hs.id, hs.error, (db) => <MoneyInput id={hs.id} aria-label={hs.label} value={centsToDollars(value.hourly_spend_cap_cents)} onChange={(v) => patch({ hourly_spend_cap_cents: dollarsToCents(v) })} placeholder="No cap" describedBy={db} />)}
            {box(ds.id, ds.error, (db) => <MoneyInput id={ds.id} aria-label={ds.label} value={centsToDollars(value.daily_spend_cap_cents)} onChange={(v) => patch({ daily_spend_cap_cents: dollarsToCents(v) })} placeholder="No cap" describedBy={db} />)}
          </tr>
        </tbody>
      </table>
      {cells.filter((c) => c.error).map((c) => <FieldError key={c.id} id={`${c.id}-error`} alert size="xs">{c.error}</FieldError>)}
      <p id={noteId} className="text-xs text-hint">An empty box is no cap. Counts {scope} leads sold through buyer selection. {zoneShiftFromEastern(zone) === 0 ? 'Hours and days are Eastern.' : easternDayResetSentence(zone)}</p>
    </div>
  )
}
