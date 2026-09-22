'use client'

/**
 * The state picker (#1412, L611): one checkbox per state from the shared
 * vocabulary, all and none, and the count. An empty list accepts nothing (L72),
 * and the picker says so once.
 */
import { US_STATES } from '@bidspoke/buyer-profile'
import { Button, Checkbox } from '@/components/ui/form'

export function StatePicker({ value, onChange, idPrefix = 'state' }: { value: readonly string[]; onChange: (states: string[]) => void; idPrefix?: string }) {
  const selected = new Set(value)
  const emit = (next: Set<string>) => onChange([...next].sort())
  return (
    <fieldset className="rounded-lg border border-gray-200 p-3">
      <legend className="px-1 text-xs font-medium text-gray-600">States</legend>
      <div className="mb-2 flex items-center gap-3">
        <span className="text-xs text-gray-600">{selected.size} of {US_STATES.length} states</span>
        <Button variant="ghost" onClick={() => emit(new Set(US_STATES))}>All</Button>
        <Button variant="ghost" onClick={() => emit(new Set())}>None</Button>
      </div>
      {selected.size === 0 && <p className="mb-2 text-xs text-amber-800">This buyer accepts no lead until a state is chosen.</p>}
      <div className="grid grid-cols-6 gap-x-3 gap-y-1.5 sm:grid-cols-9 lg:grid-cols-12">
        {US_STATES.map((code) => (
          <Checkbox
            key={code}
            id={`${idPrefix}-${code}`}
            label={code}
            checked={selected.has(code)}
            onChange={(checked) => {
              const next = new Set(selected)
              if (checked) next.add(code)
              else next.delete(code)
              emit(next)
            }}
          />
        ))}
      </div>
    </fieldset>
  )
}
