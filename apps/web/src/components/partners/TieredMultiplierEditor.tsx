'use client'

import { useId } from 'react'
import { Plus } from 'lucide-react'
import { Button, NumberInput, TextInput } from '@/components/ui/form'
import { RemoveButton } from '@/components/partners/RemoveButton'

interface Tier {
  above: number
  multiplier: number
}

interface Config {
  source_field: string
  tiers: Tier[]
  default_multiplier: number | null
  /**
   * Debt below which the partner does not bid at all (#1199). Null means no
   * floor, which is not the same rule as a floor of zero, so the two must stay
   * distinct all the way to the stored config.
   */
  min_source_value: number | null
}

interface Props {
  config: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}

const PLACEHOLDER_FIELD = 'steps.eligibility.output.final'

/**
 * One row of the From / To / Multiplier table (PM-23, #2326), drawn like the
 * buyer profile's Pricing table. The stored config is a floor, a default
 * multiplier and tiers that start ABOVE a number, and the resolver reads it
 * unchanged. The first row is the floor and the default multiplier; each tier is
 * a row whose From is its `above` plus one, the whole dollar reading the daily
 * Tripoint pricing check also uses ("starts paying the higher rate at $above
 * + 1", tripoint-pricing-drift.ts). Converting back subtracts the same one, so
 * opening and saving changes no stored number. A debt with cents between
 * `above` and `above + 1` takes the higher tier, as it always has.
 */
interface TableRow {
  from: number | null
  multiplier: number | null
  /** The tier's index in the stored list, or null for the first row (the floor and the default). */
  tier: number | null
}

function tableRows(c: Config): TableRow[] {
  const tiers = c.tiers
    .map((t, i) => ({ from: t.above + 1, multiplier: t.multiplier, tier: i }))
    // Shown in order of where each starts; equal starts keep their stored order.
    .sort((a, b) => a.from - b.from || a.tier - b.tier)
  return [{ from: c.min_source_value, multiplier: c.default_multiplier, tier: null }, ...tiers]
}

export function TieredMultiplierEditor({ config, onChange }: Props) {
  const c = readConfig(config)
  const sourceFieldId = useId()
  const tableId = useId()
  const hintId = useId()
  const rows = tableRows(c)

  function patch(next: Partial<Config>) {
    const merged: Config = { ...c, ...next }
    onChange({
      ...config,
      pricing_mode: 'tiered_multiplier',
      source_field: merged.source_field,
      tiers: merged.tiers,
      default_multiplier: merged.default_multiplier,
      // Named here as well as on Config: this object is rebuilt from a list of
      // keys, so a field left off the list is silently dropped by every other
      // edit on the form (L510).
      min_source_value: merged.min_source_value,
    })
  }

  /** A row starts at `from`: the floor for the first row, a tier's `above` for the rest. */
  function setFrom(row: TableRow, from: number | null) {
    if (row.tier === null) return patch({ min_source_value: from })
    // A tier needs a number, so an emptied From stores the threshold 0, the value an
    // emptied threshold box stored before (#2137); it then reads as a From of 1.
    const above = from === null ? 0 : from - 1
    patch({ tiers: c.tiers.map((t, i) => (i === row.tier ? { ...t, above } : t)) })
  }

  function setMultiplier(row: TableRow, multiplier: number | null) {
    if (row.tier === null) return patch({ default_multiplier: multiplier })
    patch({ tiers: c.tiers.map((t, i) => (i === row.tier ? { ...t, multiplier: multiplier ?? 0 } : t)) })
  }

  function removeRow(index: number) {
    const row = rows[index]
    if (row.tier !== null) return patch({ tiers: c.tiers.filter((_, i) => i !== row.tier) })
    // The first row goes: the next tier becomes the first, so its start is the
    // floor and its multiplier the default, as the table then shows.
    const next = rows[1]
    if (!next || next.tier === null) return
    patch({ min_source_value: next.from, default_multiplier: next.multiplier, tiers: c.tiers.filter((_, i) => i !== next.tier) })
  }

  function addTier() {
    // Starts where the last row starts, as the Pricing table's Add tier does.
    const lastFrom = rows[rows.length - 1].from ?? 0
    patch({ tiers: [...c.tiers, { above: lastFrom - 1, multiplier: 0 }] })
  }

  const hasFloor = c.min_source_value !== null
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={sourceFieldId} className="mb-1 block text-xs font-medium text-gray-600">Multiply this field</label>
        <TextInput id={sourceFieldId} value={c.source_field} onChange={(v) => patch({ source_field: v })} placeholder={PLACEHOLDER_FIELD} mono />
      </div>

      <div>
        <table className="w-full text-sm" aria-describedby={hintId}>
          <thead>
            <tr className="text-left text-xs font-medium text-gray-600">
              <th scope="col" className="pb-1 pr-2 font-medium">From</th>
              <th scope="col" className="pb-1 pr-2 font-medium">To</th>
              <th scope="col" className="w-28 pb-1 pr-2 font-medium">Multiplier</th>
              <th scope="col" className="w-8 pb-1"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const n = i + 1
              const next = rows[i + 1]
              return (
                <tr key={row.tier ?? 'first'} className="align-middle">
                  <td className="py-0.5 pr-2">
                    <NumberInput id={`${tableId}-${n}-from`} aria-label={`From, tier ${n}`} value={row.from} onChange={(v) => setFrom(row, v)} placeholder={row.tier === null ? 'No lower bound' : undefined} />
                  </td>
                  <td className="py-0.5 pr-2">
                    {next ? (
                      <NumberInput id={`${tableId}-${n}-to`} aria-label={`To, tier ${n}`} value={next.from} onChange={(v) => setFrom(next, v)} />
                    ) : (
                      // The top tier has no upper bound in the stored rule, so there is nothing to type.
                      <span className="px-1 text-[13px] text-hint">No upper bound</span>
                    )}
                  </td>
                  <td className="py-0.5 pr-2">
                    <NumberInput id={`${tableId}-${n}-multiplier`} aria-label={`Multiplier, tier ${n}`} value={row.multiplier} onChange={(v) => setMultiplier(row, v)} mono />
                  </td>
                  <td className="py-0.5">
                    {rows.length > 1 && <RemoveButton label={`Remove tier ${n}`} onClick={() => removeRow(i)} />}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <Button variant="quiet" onClick={addTier}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add tier
        </Button>
        <p id={hintId} className="mt-1 text-xs text-hint">
          {hasFloor ? 'No bid below the first tier. To is not included, so the next tier starts there.' : 'To is not included, so the next tier starts there.'}
        </p>
      </div>
    </div>
  )
}

function readConfig(raw: Record<string, unknown>): Config {
  const tiers: Tier[] = Array.isArray(raw.tiers)
    ? (raw.tiers as unknown[])
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
        .map((t) => ({
          above: typeof t.above === 'number' ? t.above : parseFloat(String(t.above ?? '0')) || 0,
          multiplier: typeof t.multiplier === 'number' ? t.multiplier : parseFloat(String(t.multiplier ?? '0')) || 0,
        }))
    : []
  return {
    source_field: typeof raw.source_field === 'string' ? raw.source_field : '',
    tiers,
    default_multiplier:
      typeof raw.default_multiplier === 'number'
        ? raw.default_multiplier
        : raw.default_multiplier == null
          ? null
          : parseFloat(String(raw.default_multiplier)) || null,
    min_source_value:
      typeof raw.min_source_value === 'number'
        ? raw.min_source_value
        : raw.min_source_value == null
          ? null
          // Number(), not parseFloat() || null: `parseFloat('0') || null` is
          // null, which would read a declared floor of zero as no floor.
          : Number.isFinite(Number(raw.min_source_value))
            ? Number(raw.min_source_value)
            : null,
  }
}
