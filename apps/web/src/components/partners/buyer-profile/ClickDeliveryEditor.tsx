'use client'

/**
 * A click buyer's delivery (#1639): the routes its clicks are posted to, each
 * with the states it takes, and the reply that counts as sold. The one route
 * with no states takes every state the others do not list. The rules are the
 * shared validator's, so the reply is checked here as it is typed with the same
 * rule the save and buyer_click_send apply (successPatternOf).
 *
 * Drawn as the settled design draws it (#2325, PM-22, frame 13): flat routes
 * with a rule between them, a name box and an address box, the states as chips,
 * and the route with no states saying only "Every state no other route lists."
 * until the person chooses states for it. Remove marks are the grey minus.
 */
import { useId, useState } from 'react'
import { Plus } from 'lucide-react'
import { successPatternOf, type ClickDeliveryDocument, type ClickRoute } from '@bidspoke/buyer-profile'
import { Button, Field, FieldError, TextInput, describedBy } from '@/components/ui/form'
import { StatePicker } from './StatePicker'
import { RemoveButton } from '@/components/partners/RemoveButton'
import { NODE_ADDRESS } from './click-delivery-consequences'

/** The words the validator uses for a reply it refuses, said here as the person types. */
const REPLY_PROBLEMS = {
  success_pattern_unset: null,
  success_pattern_invalid: 'This reply is not a valid pattern.',
  success_pattern_no_id_group: 'The reply needs an (?<id>...) group for the id the buyer returns.',
} as const

const EMPTY_ROUTE: ClickRoute = { name: '', url: '', states: [] }

/** What a route with no states means, said once where its chips would be. */
const CATCH_ALL = 'Every state no other route lists.'

export function ClickDeliveryEditor({ value, onChange, errors = {} }: {
  value: ClickDeliveryDocument | null | undefined
  onChange: (next: ClickDeliveryDocument | null) => void
  /** The validator's messages by its path (clickDelivery.routes[0].url and so on). */
  errors?: Record<string, string>
}) {
  const base = useId()
  const whole = errors.clickDelivery
  /** Routes whose state chips the person opened, though no state is chosen yet (a new route, or the catch all given states). */
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set())

  if (!value) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-gray-600">Clicks go to {NODE_ADDRESS}.</p>
        {whole && <FieldError alert size="xs">{whole}</FieldError>}
        <Button variant="secondary" onClick={() => onChange({ routes: [{ ...EMPTY_ROUTE }], success_pattern: '' })}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add click delivery
        </Button>
      </div>
    )
  }

  /** Removing a route shifts the ones after it up, so the opened pickers move with them. */
  const setRoute = (i: number, next: ClickRoute | null) => {
    onChange({ ...value, routes: value.routes.flatMap((r, j) => (j === i ? (next ? [next] : []) : [r])) })
    if (next === null) setOpened((o) => new Set([...o].flatMap((j) => (j === i ? [] : [j > i ? j - 1 : j]))))
  }

  const reply = successPatternOf(value.success_pattern)
  const replyError = (!reply.ok ? REPLY_PROBLEMS[reply.code] : null) ?? errors['clickDelivery.successPattern'] ?? null
  const replyId = `${base}-reply`
  const routesError = errors['clickDelivery.routes']

  return (
    <div className="space-y-3">
      {whole && <FieldError alert size="xs">{whole}</FieldError>}
      {/* Flat routes, a thin rule between them, no box (#2325, the settled design). */}
      <ol className="divide-y divide-line-soft">
        {value.routes.map((route, i) => {
          const n = i + 1
          const rowId = `${base}-route-${i}`
          const nameError = errors[`clickDelivery.routes[${i}].name`]
          const urlError = errors[`clickDelivery.routes[${i}].url`]
          const statesError = errors[`clickDelivery.routes[${i}].states`]
          const shown = route.name.trim() || `route ${n}`
          // The route with no states takes every state no other route lists, and says only that until states are chosen for it.
          const pickerShown = route.states.length > 0 || opened.has(i)
          return (
            <li key={i} aria-label={`Route ${n}`} className="space-y-2 py-3 first:pt-0 last:pb-0">
              <div className="grid grid-cols-[6rem_minmax(0,1fr)_auto] items-start gap-2">
                <div>
                  <TextInput id={`${rowId}-name`} value={route.name} onChange={(name) => setRoute(i, { ...route, name })} placeholder="Name" aria-label={`Route ${n} name`} describedBy={nameError ? `${rowId}-name-error` : undefined} className="font-semibold" />
                  {nameError && <FieldError id={`${rowId}-name-error`} alert size="xs" className="mt-1">{nameError}</FieldError>}
                </div>
                <div>
                  <TextInput id={`${rowId}-url`} mono value={route.url} onChange={(url) => setRoute(i, { ...route, url })} placeholder="https://" aria-label={`Route ${n} address`} describedBy={urlError ? `${rowId}-url-error` : undefined} />
                  {urlError && <FieldError id={`${rowId}-url-error`} alert size="xs" className="mt-1">{urlError}</FieldError>}
                </div>
                <RemoveButton label={`Remove route ${shown}`} onClick={() => setRoute(i, null)} className="mt-1" />
              </div>
              {pickerShown ? (
                <StatePicker
                  idPrefix={`${rowId}-state`}
                  legend={`States for ${shown}`}
                  legendShown
                  value={route.states}
                  onChange={(states) => setRoute(i, { ...route, states })}
                  emptyNote={CATCH_ALL}
                  emptyIsWarning={false}
                />
              ) : (
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <p className="text-xs text-hint">{CATCH_ALL}</p>
                  <Button variant="quiet" aria-label={`Choose states for ${shown}`} onClick={() => setOpened((o) => new Set(o).add(i))}>Choose states</Button>
                </div>
              )}
              {statesError && <FieldError alert size="xs">{statesError}</FieldError>}
            </li>
          )
        })}
      </ol>
      {routesError && <FieldError alert size="xs">{routesError}</FieldError>}
      <Button
        variant="quiet"
        onClick={() => {
          // A new route opens with its states to choose: only one route may take every other state.
          setOpened((o) => new Set(o).add(value.routes.length))
          onChange({ ...value, routes: [...value.routes, { ...EMPTY_ROUTE }] })
        }}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add route
      </Button>

      <Field id={replyId} label="Success reply" hint="Matched against the buyer's whole answer. The (?<id>...) group captures the id the buyer returns." error={replyError}>
        <TextInput id={replyId} mono value={value.success_pattern} onChange={(success_pattern) => onChange({ ...value, success_pattern })} describedBy={describedBy(replyId, true, Boolean(replyError))} />
      </Field>

      {/* Staged like every edit on the page: the save bar names what it does, and Discard changes puts it back. */}
      <Button variant="quiet" onClick={() => onChange(null)}>
        Remove click delivery
      </Button>
    </div>
  )
}
