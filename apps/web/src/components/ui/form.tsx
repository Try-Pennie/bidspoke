'use client'

/**
 * The design system form primitives (#1412, L607). Every control on a new
 * surface comes from here: each has its own class (a select is not an input),
 * a real label reachable by id, and one place to fix geometry or contrast.
 * The raw elements and every Radix import live in components/ui and nowhere
 * else; scan guards enforce both (partner-page-controls-guard.test.ts). Radix is
 * the base for the app's controls (Dan, 2026-10-15, #2137): callers import
 * these components and never Radix itself. The Select (Select.tsx), the Toggle
 * (Toggle.tsx) and the date and time fields (DateTimeFields.tsx) have files of
 * their own, so a route that uses only a button here does not load their Radix
 * code (#2137, measured on /dashboard and the canvas).
 */
import { useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

// ── Field ─────────────────────────────────────────────────────────────────────

/**
 * A labelled control with its hint and error. `labelHidden` keeps the label for
 * screen readers only, where a heading right above already says it (#2142).
 */
export function Field({ id, label, labelHidden, hint, error, children }: { id: string; label: string; labelHidden?: boolean; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <div className="field">
      {/* The id lets a control's popup list be named by this label too (the Combobox, #2338). */}
      <label id={`${id}-label`} htmlFor={id} className={labelHidden ? 'sr-only' : 'mb-1 block text-xs font-medium text-gray-600'}>{label}</label>
      {children}
      {hint && <p id={`${id}-hint`} className="mt-1 text-xs text-hint">{hint}</p>}
      {error && <FieldError id={`${id}-error`} alert size="xs" className="mt-1">{error}</FieldError>}
    </div>
  )
}

/**
 * Text saying something is genuinely wrong (#2144): a field's error, a refused
 * save, a read or a write that failed. Red is kept for that and nothing else
 * (.impeccable.md), so every such sentence on the partners page is drawn here
 * and the page's colour scan refuses red anywhere else. `alert` announces it as
 * it appears; `boxed` sets it on a pale red panel for a failure that stands on
 * its own rather than under a field. `size` is left out to take the text size
 * around it.
 */
export function FieldError({ id, alert, size, boxed, as: Tag = 'p', className, children }: {
  id?: string
  alert?: boolean
  size?: 'xs' | 'sm'
  boxed?: boolean
  as?: 'p' | 'span' | 'div' | 'li'
  className?: string
  children: ReactNode
}) {
  const classes = ['field-error', size ? `text-${size}` : '', boxed ? 'field-error-box' : '', className ?? ''].filter(Boolean).join(' ')
  return <Tag id={id} role={alert ? 'alert' : undefined} className={classes}>{children}</Tag>
}

/** The ids a control should be described by, given which of hint and error are present. */
export function describedBy(id: string, hint: boolean, error: boolean): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean)
  return ids.length ? ids.join(' ') : undefined
}

/** Keeps Enter from submitting the form around a field (#1552, L596). */
export function holdEnter(e: KeyboardEvent<HTMLElement>, then?: () => void) {
  if (e.key !== 'Enter') return
  e.preventDefault()
  then?.()
}

// ── Inputs ────────────────────────────────────────────────────────────────────

interface TextInputProps {
  id: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  mono?: boolean
  disabled?: boolean
  describedBy?: string
  'aria-label'?: string
  className?: string
  /**
   * Enter commits this field through its own action. The key is kept from the
   * form around it, so committing a field never also submits the form (#1552, L596).
   */
  onEnter?: () => void
  /**
   * Called when the box loses focus (a list that writes each row as it is
   * left), with where focus went (`relatedTarget`), so a row's own remove mark
   * can be told from leaving the row.
   */
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void
  /**
   * Text to tint wherever it is typed, as a placeholder the value carries (the
   * click URL's `{prospect_id}`, #2327). The tint is drawn on a copy of the text
   * behind the box, hidden from screen readers, and scrolls with the address;
   * the box itself holds exactly what is typed.
   */
  tint?: string
}

/** The value split around each `tint`, the tinted parts marked. */
function tintParts(value: string, tint: string): ReactNode[] {
  const pieces = value.split(tint)
  return pieces.flatMap((piece, i) => (i === 0 ? [piece] : [<mark key={i} data-tint-mark className="input-tint-mark">{tint}</mark>, piece]))
}

/**
 * A plain text box. One that offers values as the person types is
 * SuggestInput (SuggestInput.tsx), never a native datalist (#2326).
 */
export function TextInput({ id, value, onChange, placeholder, mono, disabled, describedBy: db, className, onEnter, onBlur, tint, ...aria }: TextInputProps) {
  const mirror = useRef<HTMLDivElement>(null)
  // The copy behind follows the box's own scroll, however it moved: typing, the caret keys, a drag or a click.
  const follow = tint ? (e: { currentTarget: HTMLInputElement }) => { if (mirror.current) mirror.current.scrollLeft = e.currentTarget.scrollLeft } : undefined
  const box = (
    <input
      id={id}
      type="text"
      value={value}
      onChange={(e) => { onChange(e.target.value); follow?.(e) }}
      onKeyDown={onEnter ? (e) => holdEnter(e, onEnter) : undefined}
      onBlur={onBlur}
      onScroll={follow}
      onKeyUp={follow}
      onSelect={follow}
      onMouseUp={follow}
      placeholder={placeholder}
      disabled={disabled}
      aria-describedby={db}
      aria-label={aria['aria-label']}
      className={`input ${mono ? 'font-mono' : ''} ${className ?? ''}`.trim()}
    />
  )
  return tint ? (
    <div className="input-tint">
      <div ref={mirror} data-tint-mirror aria-hidden="true" className={`input input-tint-mirror ${mono ? 'font-mono' : ''} ${className ?? ''}`.trim()}>
        {tintParts(value, tint)}
      </div>
      {box}
    </div>
  ) : box
}

interface NumberInputProps {
  id: string
  /** null is an empty box, which is a different fact from 0. */
  value: number | null
  onChange: (value: number | null) => void
  min?: number
  max?: number
  step?: number | 'any'
  placeholder?: string
  disabled?: boolean
  mono?: boolean
  describedBy?: string
  'aria-label'?: string
  className?: string
}

export function NumberInput({ id, value, onChange, min, max, step = 'any', placeholder, disabled, mono, describedBy: db, className, ...aria }: NumberInputProps) {
  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      value={value === null ? '' : value}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      disabled={disabled}
      aria-describedby={db}
      aria-label={aria['aria-label']}
      onChange={(e) => {
        // A number box holding text it cannot parse (a half typed "1e") reports an
        // empty value with badInput set. That is not a cleared box, so nothing is
        // emitted and the person's partial typing is left alone (L663).
        if (e.target.validity?.badInput) return
        const raw = e.target.value
        if (raw === '') { onChange(null); return }
        const n = Number(raw)
        if (Number.isFinite(n)) onChange(n)
      }}
      className={`input ${mono ? 'font-mono' : ''} ${className ?? ''}`.trim()}
    />
  )
}

/** Dollars with grouping and at most cents, the way a money box reads at rest. */
const DOLLARS_AT_REST = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
/** What a money box accepts: digits with optional grouping commas, and at most cents. */
const TYPED_DOLLARS = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{0,2})?$/

/**
 * An amount of dollars (#2324, PM-21). The box holds only the number, and "$"
 * is fixed text beside it, since a box holds only what is typed (Dan,
 * 2026-10-17). At rest it reads grouped (20,000); while it has the focus it
 * holds exactly what the person types, so nothing rewrites their typing under
 * them. Text that is not an amount is said while it is typed and never emitted;
 * leaving the box puts it back to the stored amount and says so, so typed text
 * never outlives a Discard, an Undo or a merge. An empty box is null, a
 * different fact from 0.
 */
export function MoneyInput({ id, value, onChange, placeholder, disabled, describedBy: db, className, 'aria-label': ariaLabel }: {
  id: string
  value: number | null
  onChange: (value: number | null) => void
  placeholder?: string
  disabled?: boolean
  describedBy?: string
  'aria-label'?: string
  className?: string
}) {
  // The typed text while the box is being edited, or null when it shows the value at rest.
  const [draft, setDraft] = useState<string | null>(null)
  // Text that was not an amount when the person left the box: put back to the stored amount, and said.
  const [rejected, setRejected] = useState<string | null>(null)
  // A value changed from outside (Discard changes, Use theirs, an Undo) replaces
  // whatever was typed; the value this box's own typing emitted does not.
  const emitted = useRef<number | null | undefined>(undefined)
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    if (value !== emitted.current) { setDraft(null); setRejected(null) }
  }
  const shown = draft ?? (value === null ? '' : DOLLARS_AT_REST.format(value))
  const trimmed = shown.trim()
  const invalid = trimmed !== '' && !TYPED_DOLLARS.test(trimmed)
  const unitId = `${id}-unit`
  // Its own id, apart from the `${id}-error` a Field around it gives a refusal from the save.
  const errorId = `${id}-typed-error`
  return (
    <div className={className}>
      <div className="flex items-center gap-1.5">
        <span id={unitId} className="text-sm text-graphite">$</span>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          value={shown}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={[unitId, db, invalid ? errorId : null].filter(Boolean).join(' ')}
          // Seeded as it reads at rest, so a stored amount is never flagged as mistyped by being focused.
          onFocus={() => { setRejected(null); setDraft(value === null ? '' : DOLLARS_AT_REST.format(value)) }}
          // Leaving the box always returns it to the stored amount, so typed text can never
          // outlive a Discard, an Undo or a merge; text that was not an amount is said. What this
          // visit emitted is forgotten, so a later outside change back to it still replaces typing.
          onBlur={() => { if (invalid) setRejected(trimmed); setDraft(null); emitted.current = undefined }}
          onChange={(e) => {
            const raw = e.target.value
            setDraft(raw)
            const t = raw.trim()
            if (t === '') { emitted.current = null; onChange(null); return }
            if (TYPED_DOLLARS.test(t)) { const n = Number(t.replace(/,/g, '')); emitted.current = n; onChange(n) }
          }}
          className="input"
        />
      </div>
      {invalid && <FieldError id={errorId} alert size="xs" className="mt-1">Type an amount of dollars, such as 20,000.</FieldError>}
      {!invalid && rejected !== null && (
        <p role="status" className="mt-1 text-xs text-hint">&quot;{rejected}&quot; is not an amount of dollars, so the box is back to {value === null ? 'empty' : DOLLARS_AT_REST.format(value)}.</p>
      )}
    </div>
  )
}

export function TextArea({ id, value, onChange, rows = 3, placeholder, mono, className, describedBy: db, 'aria-label': ariaLabel }: {
  id: string
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
  mono?: boolean
  className?: string
  describedBy?: string
  'aria-label'?: string
}) {
  return (
    <textarea
      id={id}
      value={value}
      rows={rows}
      placeholder={placeholder}
      aria-describedby={db}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className={`textarea ${mono ? 'font-mono' : ''} ${className ?? ''}`.trim()}
    />
  )
}

// ── Choice group ──────────────────────────────────────────────────────────────

/**
 * One answer out of a few named ones, where no answer may be preselected
 * (#1541): a radio group of radios (L560), with a visible label that is also its
 * accessible name, one tab stop (the chosen option, or the first when nothing
 * is chosen), and arrow keys that move and choose as the radio pattern does.
 * Every option is a button of type button, so no key it handles submits the
 * form around it (L596). `stacked` lays the options out one per line, each
 * with its hint under its label, for choices that need a sentence to tell apart.
 */
export function ChoiceGroup<T extends string>({ id, label, visibleLabel, value, options, onChange, disabled, describedBy: db, stacked }: {
  id: string
  label: string
  /**
   * What is shown when it differs from the accessible name, so a heading above
   * the control is not repeated on screen (L605): '' shows nothing. The group
   * is still named by `label` in full.
   */
  visibleLabel?: string
  value: T | null
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>
  onChange: (value: T) => void
  disabled?: boolean
  describedBy?: string
  stacked?: boolean
}) {
  const labelId = `${id}-label`
  const chosen = options.findIndex((o) => o.value === value)
  const tabStop = chosen === -1 ? 0 : chosen
  const choose = (index: number, group: HTMLElement | null) => {
    if (disabled) return
    const next = options[(index + options.length) % options.length]
    onChange(next.value)
    const radios = group?.querySelectorAll<HTMLElement>('[role="radio"]')
    radios?.[(index + options.length) % options.length]?.focus()
  }
  return (
    <div>
      {visibleLabel === undefined || visibleLabel === label
        ? <span id={labelId} className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
        : <span id={labelId} className={visibleLabel === '' ? 'sr-only' : 'mb-1 block text-xs font-medium text-gray-600'}><span className="sr-only">{label}</span>{visibleLabel !== '' && <span aria-hidden="true">{visibleLabel}</span>}</span>}
      <div id={id} role="radiogroup" aria-labelledby={labelId} aria-describedby={db} aria-disabled={disabled || undefined} className={stacked ? 'choice-stack' : 'choice-group'}>
        {options.map((o, i) => {
          const on = o.value === value
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={i === tabStop ? 0 : -1}
              disabled={disabled}
              aria-labelledby={stacked ? `${id}-${i}-label` : undefined}
              aria-describedby={stacked && o.hint ? `${id}-${i}-hint` : undefined}
              onClick={() => { if (!disabled) onChange(o.value) }}
              onKeyDown={(e) => {
                const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
                if (step === 0) return
                e.preventDefault()
                choose(i + step, e.currentTarget.parentElement)
              }}
              className={stacked ? `choice-row ${on ? 'choice-row-on' : ''}`.trim() : `choice ${on ? 'choice-on' : ''}`.trim()}
            >
              {stacked ? (
                <>
                  <span aria-hidden="true" className="choice-dot" />
                  <span className="text-left">
                    <span id={`${id}-${i}-label`} className="block font-medium text-graphite">{o.label}</span>
                    {o.hint && <span id={`${id}-${i}-hint`} className="block text-gray-600">{o.hint}</span>}
                  </span>
                </>
              ) : o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Checkbox ──────────────────────────────────────────────────────────────────

export function Checkbox({ id, checked, onChange, label, disabled, describedBy: db }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; describedBy?: string }) {
  return (
    <label htmlFor={id} className="inline-flex items-center gap-1.5 text-sm text-graphite">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} aria-describedby={db} onChange={(e) => onChange(e.target.checked)} className="checkbox" />
      <span>{label}</span>
    </label>
  )
}

// ── Chip ──────────────────────────────────────────────────────────────────────

/**
 * A chip that is a checkbox (#2324, PM-21): a state in a grid of states, a day
 * of the week. Navy when chosen, white with the beige line when not, so a set
 * of many reads at a glance. A button with the checkbox role, so it is named
 * and announced as checked or not, Space toggles it, and it never submits the
 * form around it. `shortLabel` is what it shows when its name is longer (Mon
 * for Monday); the name begins with it, so a spoken command finds it.
 */
export function ChipCheck({ id, checked, onChange, label, shortLabel, size = 'sm', disabled }: {
  id?: string
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  shortLabel?: string
  size?: 'sm' | 'lg'
  disabled?: boolean
}) {
  return (
    <button
      id={id}
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={shortLabel ? label : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`chip ${size === 'lg' ? 'chip-lg' : ''} ${checked ? 'chip-on' : ''}`.replace(/\s+/g, ' ').trim()}
    >
      {shortLabel ?? label}
    </button>
  )
}

// ── Button ────────────────────────────────────────────────────────────────────

/**
 * destructive: the solid red button that answers a dialog with a deletion;
 * danger is the quieter outlined one beside a row. `row` is a whole list row
 * that is one control (a partner in the list): left aligned and full width,
 * its own class because its geometry is not a button's. `quiet` is a dark
 * action that is not a button, an add link or All and None on the partners
 * page (#2317), where blue is kept for buttons; `remove` is the grey minus of
 * RemoveButton.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'destructive' | 'ghost' | 'row' | 'quiet' | 'remove'

export function Button({ variant, type = 'button', form, onClick, disabled, busy, children, 'aria-label': ariaLabel, describedBy: db, title, className, keepFocus, current, part }: {
  variant: ButtonVariant
  type?: 'button' | 'submit'
  /** The form a submit button belongs to when it is drawn outside it (the partners save bar, #2138). */
  form?: string
  onClick?: () => void
  disabled?: boolean
  busy?: boolean
  children: ReactNode
  'aria-label'?: string
  /** The id of the sentence saying why the button is as it is (a disabled Discard, #2138). */
  describedBy?: string
  title?: string
  className?: string
  /**
   * Pressing the button leaves focus where it was, so a text box beside it is
   * not left (and does not commit) before the click lands. Keyboard focus
   * still reaches the button as usual (#2327).
   */
  keepFocus?: boolean
  /** The button is the chosen one of a list of them (a list row that opens what it names): aria-current. */
  current?: boolean
  /** A data-part name a settled design's checks read the button by (#2338), never a styling hook. */
  part?: string
}) {
  return (
    <button
      type={type}
      form={form}
      data-part={part}
      aria-current={current ? 'true' : undefined}
      onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined}
      aria-describedby={db}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy ? 'true' : undefined}
      aria-label={ariaLabel}
      title={title}
      className={`btn btn-${variant} ${className ?? ''}`.trim()}
    >
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  )
}

// ── Outcome: working, still alive, done, failed ───────────────────────────────

export type OutcomeState =
  | { kind: 'idle' }
  | { kind: 'working'; label: string; startedAt: number; now: number; stalledAfterMs?: number }
  | { kind: 'done'; message: string }
  | { kind: 'failed'; message: string }

/**
 * The three states a time taking action can be in are visibly distinct (Dan,
 * 2026-06-28): started (the label), still alive (elapsed seconds, ticking), and
 * failed or stalled (an alert). A bare spinner is a defect.
 */
export function Outcome({ state }: { state: OutcomeState }) {
  if (state.kind === 'idle') return null
  if (state.kind === 'working') {
    const seconds = Math.max(0, Math.floor((state.now - state.startedAt) / 1000))
    if (state.stalledAfterMs !== undefined && state.now - state.startedAt >= state.stalledAfterMs) {
      return <p role="alert" className="outcome outcome-stalled">{state.label}: still waiting after {seconds} s. It may have stalled.</p>
    }
    return (
      <p role="status" className="outcome outcome-working">
        {/* Sized by the one .outcome svg rule in globals.css: as tall as the capitals, level with them (round 32). */}
        <Loader2 className="animate-spin" aria-hidden="true" />
        {state.label}, {seconds} s
      </p>
    )
  }
  if (state.kind === 'done') return <p role="status" className="outcome outcome-done">{state.message}</p>
  return <p role="alert" className="outcome outcome-failed">{state.message}</p>
}
