'use client'

/**
 * A text box that offers values as the person types (#2326), part of the
 * design system controls in form.tsx, in a file of its own so a route that
 * never offers suggestions does not load @radix-ui/react-popover.
 *
 * It replaces the native <datalist> TextInput used to draw (L607, L568): that
 * list is the operating system's, unstyled and differently reachable in every
 * browser. This one is the combobox pattern (an input with role combobox, a
 * listbox of options, aria-activedescendant for the marked one), drawn in a
 * portal so a box inside a clipping container (a collapsing section, a canvas
 * panel) never cuts it off. Typing anything else stays allowed.
 */
import { useId, useMemo, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { holdEnter } from './form'

/** More than this many matches is a list nobody reads; typing narrows it. */
const MAX_SHOWN = 50

export function SuggestInput({ id, value, onChange, suggestions, placeholder, mono, disabled, describedBy: db, className, onEnter, 'aria-label': ariaLabel }: {
  id: string
  value: string
  onChange: (value: string) => void
  /** The values offered: those holding what is typed, the exact value itself left out. */
  suggestions: readonly string[]
  placeholder?: string
  mono?: boolean
  disabled?: boolean
  describedBy?: string
  'aria-label'?: string
  className?: string
  /** Enter commits this field through its own action, and never submits the form (#1552, L596). */
  onEnter?: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = `${useId()}-suggestions`
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const matches = useMemo(() => {
    const typed = value.trim().toLowerCase()
    return suggestions.filter((s) => s !== value && s.toLowerCase().includes(typed)).slice(0, MAX_SHOWN)
  }, [suggestions, value])
  const shown = open && !disabled && matches.length > 0
  const optionId = (i: number) => `${listId}-${i}`

  const close = () => { setOpen(false); setActive(-1) }
  const take = (s: string) => { onChange(s); close() }

  return (
    <Popover.Root open={shown} onOpenChange={(next) => { if (!next) close() }}>
      <Popover.Anchor asChild>
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={shown}
          aria-controls={shown ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
          aria-describedby={db}
          aria-label={ariaLabel}
          autoComplete="off"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(-1) }}
          onFocus={() => setOpen(true)}
          onBlur={close}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              if (!shown) { setOpen(true); return }
              const step = e.key === 'ArrowDown' ? 1 : -1
              setActive((i) => (i + step + matches.length) % matches.length)
              return
            }
            if (e.key === 'Escape' && shown) {
              // Closes the list only, not a dialog the box sits in.
              e.preventDefault()
              e.stopPropagation()
              close()
              return
            }
            if (e.key === 'Enter' && shown && active >= 0) {
              e.preventDefault()
              take(matches[active])
              return
            }
            if (onEnter) holdEnter(e, onEnter)
          }}
          className={`input ${mono ? 'font-mono' : ''} ${className ?? ''}`.trim()}
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="suggest-content"
          // Focus stays in the box: the list is read through aria-activedescendant.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => { if (e.target === inputRef.current) e.preventDefault() }}
          onFocusOutside={(e) => { if (e.target === inputRef.current) e.preventDefault() }}
        >
          <ul id={listId} role="listbox" aria-label={ariaLabel ? `${ariaLabel} suggestions` : 'Suggestions'} className="suggest-list">
            {matches.map((s, i) => (
              <li
                key={s}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                // mousedown, not click: the box keeps focus, so its blur does not close the list first.
                onMouseDown={(e) => { e.preventDefault(); take(s) }}
                onMouseEnter={() => setActive(i)}
                className={`suggest-item ${mono ? 'font-mono' : ''} ${i === active ? 'suggest-item-active' : ''}`.trim()}
              >
                {s}
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
