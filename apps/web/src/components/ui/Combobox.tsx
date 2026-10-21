'use client'

/**
 * The dropdown for a list that is looked up while the page is open (#2338,
 * R15, L607, L568, L611): the orgs Bidspoke knows for a Salesforce
 * connection, and the other Connections lookups (`POST /api/connections/:id/
 * lookup/:key`) that later feed it. Part of the design system controls in
 * form.tsx, in a file of its own so a route that never shows one does not
 * load @radix-ui/react-popover.
 *
 * It is the combobox pattern SuggestInput uses (a control with role combobox,
 * a listbox of options, aria-activedescendant for the marked one, drawn in a
 * Radix popover so a clipping container never cuts the menu off). Radix has no
 * combobox primitive, and Radix Select cannot hold a loading line, an error
 * with Try again, or a box to type into, so the keys are handled here, as
 * SuggestInput handles them.
 *
 * What a plain Select does not have, because its list comes from a loader:
 *   - loading, then elapsed seconds once the load is slow, then at the
 *     deadline the stall becomes the error (working, still alive and failed
 *     look different, Dan 2026-06-28);
 *   - a failed load is an error inside the menu with Try again, never an
 *     empty list (L10), and an empty answer is its own message;
 *   - optionally a typed value as a new option (design round 25): the caller's
 *     `chooseLabel` ("Another org") comes last, and choosing it turns the box
 *     into one the value is typed straight into, whose menu offers the caller's
 *     `useLabel` ("Use <typed> as a new org").
 *
 * The clock is injected (L524), so a test moves time rather than waiting.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import { Button, FieldError, holdEnter } from './form'

export interface ComboboxOption {
  value: string
  label: string
  /** A grey second line under the label: an org's address. */
  hint?: string
}

/** Time, injectable so the slow and stalled states can be driven by a test (L524). */
export interface ComboboxClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realClock: ComboboxClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
}

export interface ComboboxNewValue {
  /** The last item of the list, which lets a value be typed instead: "Another org". */
  chooseLabel: string
  /** The item that offers what was typed: (t) => `Use ${t} as a new org`. */
  useLabel: (typed: string) => string
  /** Shown in the box until something is typed. */
  placeholder?: string
}

interface ComboboxProps {
  id: string
  value: string
  /** Called with the chosen value; `isNew` when it was typed rather than chosen from the list. */
  onChange: (value: string, choice: { isNew: boolean }) => void
  /**
   * Loads the options, once when the control mounts and again on Try again.
   * A rejection's message is shown as the error, so throw a sentence a person
   * can act on ("Salesforce did not answer."), never a raw fetch error.
   */
  loadOptions: (signal: AbortSignal) => Promise<readonly ComboboxOption[]>
  placeholder?: string
  /** Shown when the load answers with nothing to choose from. */
  emptyMessage?: string
  /** Allows a typed value as a new option (round 25). Left out, only the list's values can be chosen. */
  newValue?: ComboboxNewValue
  /** The value was typed as a new one when this control last held it, so it opens as the box to type into. */
  valueIsNew?: boolean
  disabled?: boolean
  describedBy?: string
  'aria-label'?: string
  /** After this long a load shows its elapsed seconds. */
  slowAfterMs?: number
  /** After this long a load that has not answered is the error, with Try again. */
  deadlineMs?: number
  clock?: ComboboxClock
}

type LoadState =
  | { kind: 'loading'; startedAt: number }
  | { kind: 'ready'; options: readonly ComboboxOption[] }
  | { kind: 'failed'; message: string }

type Item =
  | { kind: 'option'; option: ComboboxOption }
  | { kind: 'another'; label: string }
  | { kind: 'use'; typed: string; label: string }

/** Letters typed within this long of each other are one type ahead search. */
const TYPE_AHEAD_MS = 500

function messageOf(err: unknown): string {
  return err instanceof Error && err.message.trim() ? err.message : 'The list could not be loaded.'
}

const lower = (s: string | undefined) => (s ?? '').toLowerCase()

export function Combobox({
  id, value, onChange, loadOptions, placeholder, emptyMessage = 'Nothing to choose from.', newValue, valueIsNew,
  disabled, describedBy: db, 'aria-label': ariaLabel, slowAfterMs = 2000, deadlineMs = 15_000, clock = realClock,
}: ComboboxProps) {
  const base = useId()
  const menuId = `${base}-menu`
  const listId = `${base}-list`
  const hintId = `${base}-hint`
  const optionId = (i: number) => `${base}-option-${i}`

  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // ── The load ────────────────────────────────────────────────────────────────
  const loaderRef = useRef(loadOptions)
  const clockRef = useRef(clock)
  useEffect(() => { loaderRef.current = loadOptions; clockRef.current = clock })
  const [load, setLoad] = useState<LoadState>(() => ({ kind: 'loading', startedAt: clock.now() }))
  const [now, setNow] = useState(() => clock.now())
  /** Bumped by every new load and by the deadline, so a late answer is never taken. */
  const generation = useRef(0)
  const stopCurrent = useRef<() => void>(() => {})

  const startLoad = useCallback(() => {
    stopCurrent.current()
    const g = ++generation.current
    const c = clockRef.current
    const controller = new AbortController()
    const startedAt = c.now()
    setLoad({ kind: 'loading', startedAt })
    setNow(startedAt)
    let tick: unknown = null
    const stop = () => { if (tick !== null) c.clearTimeout(tick); c.clearTimeout(deadline) }
    const beat = () => { if (generation.current !== g) return; setNow(c.now()); tick = c.setTimeout(beat, 1000) }
    tick = c.setTimeout(beat, 1000)
    const deadline = c.setTimeout(() => {
      if (generation.current !== g) return
      generation.current += 1
      stop()
      controller.abort()
      setLoad({ kind: 'failed', message: `The list did not load within ${Math.round(deadlineMs / 1000)} seconds.` })
    }, deadlineMs)
    stopCurrent.current = () => { stop(); controller.abort() }
    loaderRef.current(controller.signal).then(
      (options) => { if (generation.current !== g) return; stop(); setLoad({ kind: 'ready', options }) },
      (err: unknown) => { if (generation.current !== g) return; stop(); setLoad({ kind: 'failed', message: messageOf(err) }) },
    )
  }, [deadlineMs])

  useEffect(() => {
    startLoad()
    return () => { generation.current += 1; stopCurrent.current() }
  }, [startLoad])

  // ── What the menu offers ────────────────────────────────────────────────────
  const [open, setOpen] = useState(false)
  /** The marked item; -1 means the default for the mode (the chosen one, or the first). */
  const [active, setActive] = useState(-1)
  const [typing, setTyping] = useState(Boolean(newValue && valueIsNew && value))
  const [typed, setTyped] = useState(newValue && valueIsNew ? value : '')
  const focusNext = useRef<'trigger' | 'input' | null>(null)
  /** The value this control took as typed, the only one an emptied box may clear. */
  const typedNew = useRef<string | null>(newValue && valueIsNew && value ? value : null)

  const known = useMemo(() => (load.kind === 'ready' ? load.options : []), [load])
  const query = typed.trim()
  const items = useMemo<Item[]>(() => {
    if (!typing) {
      const list: Item[] = known.map((option) => ({ kind: 'option', option }))
      if (newValue) list.push({ kind: 'another', label: newValue.chooseLabel })
      return list
    }
    const q = query.toLowerCase()
    const matches = q ? known.filter((o) => lower(o.label).includes(q) || lower(o.hint).includes(q) || lower(o.value) === q) : known
    const list: Item[] = matches.map((option) => ({ kind: 'option', option }))
    const exact = known.some((o) => [o.label, o.hint, o.value].some((s) => lower(s) === q))
    if (q && !exact && newValue) list.push({ kind: 'use', typed: query, label: newValue.useLabel(query) })
    return list
  }, [typing, known, newValue, query])

  const chosenIndex = items.findIndex((it) => it.kind === 'option' && it.option.value === value)
  const defaultActive = typing
    ? (query && items.length ? 0 : -1)
    : load.kind === 'failed' ? -1 : chosenIndex >= 0 ? chosenIndex : items.length ? 0 : -1
  const marked = active >= 0 && active < items.length ? active : defaultActive
  const shown = open && !disabled

  const chosen = known.find((o) => o.value === value)
  const boxText = chosen ? chosen.label
    : value === '' ? (placeholder ?? '')
    // Only a list that was read can say a value has gone from it (L11).
    : load.kind === 'ready' ? `${value} (no longer available)`
    : value
  const showHint = !typing && Boolean(chosen?.hint)
  const describedByIds = [db, showHint ? hintId : null].filter(Boolean).join(' ') || undefined

  useEffect(() => {
    const target = focusNext.current === 'trigger' ? triggerRef.current : focusNext.current === 'input' ? inputRef.current : null
    focusNext.current = null
    target?.focus()
  }, [typing])

  // The marked option stays in view as the arrows move down a list longer than the menu.
  const markedId = shown && marked >= 0 ? optionId(marked) : null
  useEffect(() => {
    if (markedId) document.getElementById(markedId)?.scrollIntoView?.({ block: 'nearest' })
  }, [markedId])

  // The open list is named by the field's label (Field gives it the id
  // `<id>-label`). Pointing at the combobox instead names the list by the
  // chosen value or the typed text in Chromium (measured 2026-10-21), so with
  // no such label the list is left unnamed rather than misnamed.
  const [fieldLabelId, setFieldLabelId] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (shown) setFieldLabelId(document.getElementById(`${id}-label`) ? `${id}-label` : undefined)
  }, [shown, id])

  const close = () => { setOpen(false); setActive(-1) }
  const openMenu = () => { if (!disabled) { setOpen(true); setActive(-1) } }
  const retry = () => { startLoad(); setActive(-1) }

  const choose = (item: Item) => {
    if (item.kind === 'another') {
      focusNext.current = 'input'
      setTyping(true)
      setTyped('')
      setActive(-1)
      return
    }
    if (item.kind === 'use') {
      typedNew.current = item.typed
      onChange(item.typed, { isNew: true })
      setTyped(item.typed)
      close()
      return
    }
    onChange(item.option.value, { isNew: false })
    if (typing) { focusNext.current = 'trigger'; setTyping(false); setTyped('') }
    close()
  }

  /**
   * Leaving the typing box keeps what it shows as the value, so the box never
   * reads as chosen while holding something else: a known org typed in full is
   * that org, anything else typed is the new value, and an empty box goes back
   * to the list, which shows the known value still held, or nothing when the
   * box was emptied of a typed new value.
   */
  const leaveTyping = () => {
    close()
    if (query === '') {
      // An emptied box that held a typed new value no longer holds it; a known value stays.
      if (value !== '' && typedNew.current === value) { typedNew.current = null; onChange('', { isNew: false }) }
      setTyping(false)
      return
    }
    const q = query.toLowerCase()
    const knownMatch = known.find((o) => [o.label, o.hint, o.value].some((s) => lower(s) === q))
    if (knownMatch) {
      if (knownMatch.value !== value) onChange(knownMatch.value, { isNew: false })
      setTyping(false)
      setTyped('')
      return
    }
    typedNew.current = query
    if (query !== value) onChange(query, { isNew: true })
    setTyped(query)
  }

  const move = (step: number) => {
    if (!items.length) return
    const from = marked < 0 ? (step > 0 ? -1 : items.length) : marked
    setActive((from + step + items.length) % items.length)
  }

  // Type ahead on the closed or open list, as a native select does.
  const typeAhead = useRef<{ text: string; reset: unknown }>({ text: '', reset: null })
  const findByLetters = (key: string) => {
    const c = clockRef.current
    const t = typeAhead.current
    if (t.reset !== null) c.clearTimeout(t.reset)
    t.text += key.toLowerCase()
    t.reset = c.setTimeout(() => { typeAhead.current = { text: '', reset: null } }, TYPE_AHEAD_MS)
    const labelOf = (it: Item) => (it.kind === 'option' ? it.option.label : it.label)
    const found = items.findIndex((it) => lower(labelOf(it)).startsWith(t.text))
    if (!shown) setOpen(true)
    if (found >= 0) setActive(found)
  }

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const k = e.key
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault()
      if (!shown) { openMenu(); return }
      move(k === 'ArrowDown' ? 1 : -1)
      return
    }
    if ((k === 'Home' || k === 'End') && shown) {
      e.preventDefault()
      if (items.length) setActive(k === 'Home' ? 0 : items.length - 1)
      return
    }
    if (k === 'Enter' || (k === ' ' && typeAhead.current.text === '')) {
      e.preventDefault()
      if (!shown) { openMenu(); return }
      if (marked >= 0) { choose(items[marked]); return }
      if (load.kind === 'failed') retry()
      return
    }
    if (k === 'Escape' && shown) {
      // Closes the list only, not a dialog the control sits in.
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (k === 'Tab') { close(); return }
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      findByLetters(k)
    }
  }

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const k = e.key
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault()
      if (!shown) { openMenu(); return }
      move(k === 'ArrowDown' ? 1 : -1)
      return
    }
    if (k === 'Enter' && shown && marked >= 0) { e.preventDefault(); choose(items[marked]); return }
    if (k === 'Enter' && shown && load.kind === 'failed') { e.preventDefault(); retry(); return }
    if (k === 'Escape') {
      if (shown) { e.preventDefault(); e.stopPropagation(); close(); return }
      if (query === '') {
        // Nothing typed: back to the list of what Bidspoke knows.
        e.preventDefault()
        e.stopPropagation()
        focusNext.current = 'trigger'
        setTyping(false)
      }
      return
    }
    if (k === 'Tab') { close(); return }
    // Enter never submits the form around the box (#1552, L596).
    holdEnter(e)
  }

  const leaves = (next: EventTarget | null) => !(next instanceof Node && (contentRef.current?.contains(next) || anchorRef.current?.contains(next)))
  const insideAnchor = (target: EventTarget | null) => target instanceof Node && Boolean(anchorRef.current?.contains(target))

  const showEmpty = load.kind === 'ready' && items.every((it) => it.kind !== 'option') && (!typing || query === '')
  const seconds = load.kind === 'loading' && now - load.startedAt >= slowAfterMs ? Math.floor((now - load.startedAt) / 1000) : null
  const controls = shown ? (items.length ? listId : menuId) : undefined
  const activeDescendant = markedId ?? undefined

  return (
    <div className="combobox">
      <Popover.Root open={shown} onOpenChange={(next) => { if (!next) close() }}>
        <Popover.Anchor asChild>
          <div ref={anchorRef} className="combobox-anchor">
            {typing ? (
              <input
                ref={inputRef}
                id={id}
                type="text"
                role="combobox"
                aria-expanded={shown}
                aria-controls={controls}
                aria-autocomplete="list"
                aria-activedescendant={activeDescendant}
                aria-describedby={describedByIds}
                aria-label={ariaLabel}
                autoComplete="off"
                spellCheck={false}
                value={typed}
                placeholder={newValue?.placeholder}
                disabled={disabled}
                onChange={(e) => { setTyped(e.target.value); setOpen(true); setActive(-1) }}
                onFocus={() => setOpen(true)}
                onBlur={(e) => { if (leaves(e.relatedTarget)) leaveTyping() }}
                onKeyDown={onInputKeyDown}
                className="input"
              />
            ) : (
              <button
                ref={triggerRef}
                type="button"
                id={id}
                role="combobox"
                aria-haspopup="listbox"
                aria-expanded={shown}
                aria-controls={controls}
                aria-activedescendant={activeDescendant}
                aria-describedby={describedByIds}
                aria-label={ariaLabel}
                disabled={disabled}
                onClick={() => (shown ? close() : openMenu())}
                onBlur={(e) => { if (leaves(e.relatedTarget)) close() }}
                onKeyDown={onTriggerKeyDown}
                className="select-trigger"
              >
                <span className={`select-trigger-text ${chosen || value !== '' ? '' : 'combobox-placeholder'}`.trim()}>{boxText}</span>
                <ChevronDown className="select-trigger-icon h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            ref={contentRef}
            id={menuId}
            // The menu is the listbox's frame, not a dialog: the control owns focus.
            role={undefined}
            data-testid="combobox-menu"
            align="start"
            sideOffset={4}
            className="combobox-content"
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            onPointerDownOutside={(e) => { if (insideAnchor(e.target)) e.preventDefault() }}
            onFocusOutside={(e) => { if (insideAnchor(e.target)) e.preventDefault() }}
          >
            {load.kind === 'loading' && (
              <p role="status" className="combobox-note">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
                {seconds === null ? 'Loading' : `Loading, ${seconds} s`}
              </p>
            )}
            {load.kind === 'failed' && (
              <div className="combobox-failed">
                <FieldError alert size="sm" className="text-pretty">{load.message}</FieldError>
                <Button variant="secondary" className="btn-sm" keepFocus onClick={retry}>Try again</Button>
              </div>
            )}
            {showEmpty && <p className="combobox-note">{emptyMessage}</p>}
            {items.length > 0 && (
              <ul id={listId} role="listbox" aria-label={ariaLabel} aria-labelledby={ariaLabel ? undefined : fieldLabelId} className="combobox-list">
                {items.map((item, i) => {
                  const isChosen = item.kind === 'option' && item.option.value === value
                  const classes = ['combobox-item', i === marked ? 'combobox-item-active' : '', isChosen ? 'combobox-item-chosen' : ''].filter(Boolean).join(' ')
                  return (
                    <li
                      key={item.kind === 'option' ? `o:${item.option.value}` : item.kind}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === marked}
                      // mousedown, not click: focus stays in the control, so its blur does not close the list first.
                      onMouseDown={(e) => { e.preventDefault(); choose(item) }}
                      onMouseEnter={() => setActive(i)}
                      className={classes}
                    >
                      <span className="combobox-item-check" aria-hidden="true">{isChosen && <Check className="h-3.5 w-3.5" />}</span>
                      {item.kind === 'option' ? (
                        <span className="combobox-item-text">
                          <span className="combobox-item-label">{item.option.label}</span>
                          {item.option.hint && <span className="combobox-item-hint">{item.option.hint}</span>}
                        </span>
                      ) : (
                        <span className="combobox-item-text">{item.label}</span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {showHint && <p id={hintId} className="combobox-hint text-hint">{chosen?.hint}</p>}
    </div>
  )
}
