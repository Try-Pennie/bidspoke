'use client'

/**
 * The state picker (#1412, L611): one chip per state from the shared
 * vocabulary, all and none, and the count. An empty list accepts nothing (L72),
 * and the picker says so once. A click delivery route (#1639) reuses it with its
 * own name and its own meaning for an empty list: every state no other route lists.
 *
 * Drawn as the settled design draws it (#2324, PM-21): a white box headed by the
 * count with All and None beside it, and a grid of chips, navy when chosen. The
 * section heading above says what the states are for, so the group's name is
 * read by a screen reader and not shown again (L605).
 */
import { US_STATES } from '@bidspoke/buyer-profile'
import { Button, ChipCheck } from '@/components/ui/form'

export function StatePicker({ value, onChange, idPrefix = 'state', legend = 'States', emptyNote = 'This buyer accepts no lead until a state is chosen.', emptyIsWarning = true }: {
  value: readonly string[]
  onChange: (states: string[]) => void
  idPrefix?: string
  legend?: string
  /** Said when no state is chosen; the words depend on what an empty list means where the picker sits. */
  emptyNote?: string
  /** False where an empty list is a meaningful choice rather than a gap. */
  emptyIsWarning?: boolean
}) {
  const selected = new Set(value)
  const emit = (next: Set<string>) => onChange([...next].sort())
  return (
    <fieldset className="rounded-lg border border-line bg-white p-2.5">
      <legend className="sr-only">{legend}</legend>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs text-graphite">{selected.size} of {US_STATES.length} states</span>
        <Button variant="quiet" onClick={() => emit(new Set(US_STATES))}>All</Button>
        <Button variant="quiet" onClick={() => emit(new Set())}>None</Button>
      </div>
      {selected.size === 0 && <p className={`mb-2 text-xs ${emptyIsWarning ? 'text-amber-800' : 'text-gray-600'}`}>{emptyNote}</p>}
      {/* As many columns as the settings column holds (#2317), each wide enough for a code. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1">
        {US_STATES.map((code) => (
          <ChipCheck
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
