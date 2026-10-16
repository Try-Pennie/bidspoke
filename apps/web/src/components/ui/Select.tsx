'use client'

/**
 * The one dropdown in the app (Dan, 2026-10-15, #2137), part of the design
 * system controls in form.tsx, in a file of its own so a route that never
 * shows a dropdown does not load @radix-ui/react-select.
 */
import { useMemo } from 'react'
import * as RadixSelect from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'

/**
 * Radix refuses an item whose value is the empty string, while callers use ''
 * as a real answer ("All workflows", "No matrix"), so '' crosses the Radix
 * boundary as this token and comes back as ''.
 */
const EMPTY_VALUE = '__bidspoke_select_empty__'
const toRadix = (v: string) => (v === '' ? EMPTY_VALUE : v)
const fromRadix = (v: string) => (v === EMPTY_VALUE ? '' : v)

interface SelectProps {
  id: string
  value: string
  onChange: (value: string) => void
  options: ReadonlyArray<{ value: string; label: string }>
  /** Shown when the value is '' and no option stands for ''. */
  placeholder?: string
  disabled?: boolean
  describedBy?: string
  'aria-label'?: string
  className?: string
  /** Submits the value under this name when the select sits in a form. */
  name?: string
}

/**
 * The one dropdown in the app (Dan, 2026-10-15). Built on @radix-ui/react-select
 * and styled to the design: its own trigger class, a list that shows a scrollbar
 * when it is longer than the room it has, and the value contract callers rely on.
 *
 * A stored value the options no longer offer shows as "<value> (no longer
 * available)", never as a blank, and stays the value. `onChange` fires only for
 * a choice of a different, offered value: Radix keeps a hidden native select in
 * a form and reports a change on it whenever the value moves, and that report is
 * not a person choosing anything, so it must never rewrite a stored value (a
 * dirty check would otherwise save an empty value over a real one).
 */
export function Select({ id, value, onChange, options, placeholder, disabled, describedBy: db, className, name, ...aria }: SelectProps) {
  const offered = useMemo(() => new Set(options.map((o) => o.value)), [options])
  const missing = value !== '' && !offered.has(value)
  const hasEmptyOption = offered.has('')
  const radixValue = value === '' && !hasEmptyOption ? '' : toRadix(value)
  return (
    <RadixSelect.Root
      value={radixValue}
      name={name}
      disabled={disabled}
      onValueChange={(next) => {
        const chosen = fromRadix(next)
        if (chosen === value || !offered.has(chosen)) return
        onChange(chosen)
      }}
    >
      <RadixSelect.Trigger
        id={id}
        aria-label={aria['aria-label']}
        aria-describedby={db}
        className={`select-trigger ${className ?? ''}`.trim()}
      >
        <span className="select-trigger-text">
          {/* A missing value is spelled out here as well as in the list, so the
              closed trigger never depends on Radix finding the item's text. */}
          <RadixSelect.Value placeholder={placeholder}>{missing ? `${value} (no longer available)` : undefined}</RadixSelect.Value>
        </span>
        <RadixSelect.Icon className="select-trigger-icon"><ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /></RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content position="popper" sideOffset={4} className="select-content">
          <RadixSelect.Viewport className="select-viewport">
            {missing && (
              <RadixSelect.Item value={value} className="select-item select-item-missing">
                <RadixSelect.ItemText>{value} (no longer available)</RadixSelect.ItemText>
              </RadixSelect.Item>
            )}
            {options.map((o) => (
              <RadixSelect.Item key={o.value} value={toRadix(o.value)} className="select-item">
                <RadixSelect.ItemIndicator className="select-item-indicator"><Check className="h-3.5 w-3.5" aria-hidden="true" /></RadixSelect.ItemIndicator>
                <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}
