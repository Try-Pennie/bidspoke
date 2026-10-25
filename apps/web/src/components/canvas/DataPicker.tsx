'use client'

/**
 * The data picker (#2338, plan section 3.3 of #1689; settled in
 * docs/design/app-action-step-form.html): the list an argument field's Insert
 * button opens under the field, in the app's dropdown list (the Combobox's
 * classes), headed by the step the values come from ("From Trigger"), each row
 * the value's name with its sample from the last test as its second line.
 * Choosing one hands its path to the field, which inserts {{<path>}} at the
 * cursor. Arrow keys move, Enter chooses, Escape closes.
 *
 * Each group says its own state: its values, still reading the step's last
 * test, a read that failed (in the list itself, with Try again, L10), or no
 * test to read.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { SampleRow } from '@bidspoke/references'
import { Button, FieldError } from '@/components/ui/form'

export type PickerGroupState =
  | { kind: 'rows'; rows: SampleRow[] }
  | { kind: 'loading' }
  | { kind: 'failed'; message: string; retry: () => void }
  | { kind: 'empty'; sentence: string }

export interface PickerGroup {
  key: string
  /** The step the values come from, as the picker heads its group: Trigger, or a step's name. */
  from: string
  state: PickerGroupState
}

export function DataPicker({ id, groups, onPick, onClose }: {
  id: string
  groups: readonly PickerGroup[]
  onPick: (path: string) => void
  onClose: (returnFocus: boolean) => void
}) {
  const base = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => groups.flatMap((g) => (g.state.kind === 'rows' ? g.state.rows : [])), [groups])
  const [active, setActive] = useState(0)
  const marked = rows.length === 0 ? -1 : Math.min(active, rows.length - 1)

  useEffect(() => { listRef.current?.focus() }, [])
  useEffect(() => {
    function outside(e: MouseEvent) {
      const box = listRef.current?.parentElement
      if (box && !box.contains(e.target as Node)) onClose(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [onClose])

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(true); return }
    if (rows.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, rows.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0) }
    else if (e.key === 'End') { e.preventDefault(); setActive(rows.length - 1) }
    else if (e.key === 'Enter') { e.preventDefault(); onPick(rows[marked].path) }
  }

  let index = -1
  const optionId = (i: number) => `${base}-option-${i}`
  return (
    <div
      ref={listRef}
      id={id}
      className="combobox-content data-picker"
      role="listbox"
      aria-label="Values from earlier steps"
      tabIndex={-1}
      aria-activedescendant={marked >= 0 ? optionId(marked) : undefined}
      onKeyDown={onKeyDown}
    >
      {groups.map((g) => (
        <div key={g.key} role="group" aria-label={`From ${g.from}`}>
          <p className="combobox-note" aria-hidden="true">From {g.from}</p>
          {g.state.kind === 'loading' && <p className="combobox-note">Reading its last test</p>}
          {g.state.kind === 'empty' && <p className="combobox-note">{g.state.sentence}</p>}
          {g.state.kind === 'failed' && (
            <div className="combobox-failed">
              <FieldError alert size="xs">{g.state.message}</FieldError>
              <Button variant="secondary" className="btn-sm" onClick={g.state.retry}>Try again</Button>
            </div>
          )}
          {g.state.kind === 'rows' && (
            <ul className="combobox-list">
              {g.state.rows.map((row) => {
                index++
                const i = index
                return (
                  <li
                    key={row.path}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === marked}
                    className={`combobox-item${i === marked ? ' combobox-item-active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => { e.preventDefault(); onPick(row.path) }}
                  >
                    <span className="combobox-item-check" />
                    <span className="combobox-item-text">
                      <span className="combobox-item-label">{row.label}</span>
                      <span className="combobox-item-hint">{row.sample}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

/** The field's value with {{<path>}} put in place of the selection, and where the cursor goes after it. */
export function insertReference(value: string, path: string, start: number | null, end: number | null): { value: string; cursor: number } {
  const from = Math.max(0, Math.min(start ?? value.length, value.length))
  const to = Math.max(from, Math.min(end ?? from, value.length))
  const text = `{{${path}}}`
  return { value: value.slice(0, from) + text + value.slice(to), cursor: from + text.length }
}
