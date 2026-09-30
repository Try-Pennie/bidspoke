'use client'

/**
 * A click buyer's delivery (#1639): the routes its clicks are posted to, each
 * with the states it takes, and the reply that counts as sold. The one route
 * with no states takes every state the others do not list. The rules are the
 * shared validator's, so the reply is checked here as it is typed with the same
 * rule the save and buyer_click_send apply (successPatternOf).
 */
import { useId } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { successPatternOf, type ClickDeliveryDocument, type ClickRoute } from '@bidspoke/buyer-profile'
import { Button, Field, TextInput, describedBy } from '@/components/ui/form'
import { StatePicker } from './StatePicker'
import { NODE_ADDRESS } from './click-delivery-consequences'

/** The words the validator uses for a reply it refuses, said here as the person types. */
const REPLY_PROBLEMS = {
  success_pattern_unset: null,
  success_pattern_invalid: 'This reply is not a valid pattern.',
  success_pattern_no_id_group: 'The reply needs an (?<id>...) group for the id the buyer returns.',
} as const

const EMPTY_ROUTE: ClickRoute = { name: '', url: '', states: [] }

export function ClickDeliveryEditor({ value, onChange, errors = {} }: {
  value: ClickDeliveryDocument | null | undefined
  onChange: (next: ClickDeliveryDocument | null) => void
  /** The validator's messages by its path (clickDelivery.routes[0].url and so on). */
  errors?: Record<string, string>
}) {
  const base = useId()
  const whole = errors.clickDelivery

  if (!value) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-gray-600">Clicks go to {NODE_ADDRESS}.</p>
        {whole && <p role="alert" className="text-xs text-red-700">{whole}</p>}
        <Button variant="secondary" onClick={() => onChange({ routes: [{ ...EMPTY_ROUTE }], success_pattern: '' })}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add click delivery
        </Button>
      </div>
    )
  }

  const setRoute = (i: number, next: ClickRoute | null) =>
    onChange({ ...value, routes: value.routes.flatMap((r, j) => (j === i ? (next ? [next] : []) : [r])) })

  const reply = successPatternOf(value.success_pattern)
  const replyError = (!reply.ok ? REPLY_PROBLEMS[reply.code] : null) ?? errors['clickDelivery.successPattern'] ?? null
  const replyId = `${base}-reply`
  const routesError = errors['clickDelivery.routes']

  return (
    <div className="space-y-4">
      {whole && <p role="alert" className="text-xs text-red-700">{whole}</p>}
      <ol className="space-y-3">
        {value.routes.map((route, i) => {
          const n = i + 1
          const rowId = `${base}-route-${i}`
          const nameError = errors[`clickDelivery.routes[${i}].name`]
          const urlError = errors[`clickDelivery.routes[${i}].url`]
          const statesError = errors[`clickDelivery.routes[${i}].states`]
          const shown = route.name.trim() || `route ${n}`
          return (
            <li key={i} aria-label={`Route ${n}`} className="space-y-3 rounded-lg border border-gray-200 p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
                <Field id={`${rowId}-name`} label="Name" error={nameError}>
                  <TextInput id={`${rowId}-name`} value={route.name} onChange={(name) => setRoute(i, { ...route, name })} aria-label={`Route ${n} name`} describedBy={describedBy(`${rowId}-name`, false, Boolean(nameError))} />
                </Field>
                <Field id={`${rowId}-url`} label="Address" error={urlError}>
                  <TextInput id={`${rowId}-url`} mono value={route.url} onChange={(url) => setRoute(i, { ...route, url })} placeholder="https://" aria-label={`Route ${n} address`} describedBy={describedBy(`${rowId}-url`, false, Boolean(urlError))} />
                </Field>
                <Button variant="danger" aria-label={`Remove route ${shown}`} onClick={() => setRoute(i, null)}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Remove
                </Button>
              </div>
              <StatePicker
                idPrefix={`${rowId}-state`}
                legend={`States for ${shown}`}
                value={route.states}
                onChange={(states) => setRoute(i, { ...route, states })}
                emptyNote="Every state no other route lists."
                emptyIsWarning={false}
              />
              {statesError && <p role="alert" className="text-xs text-red-700">{statesError}</p>}
            </li>
          )
        })}
      </ol>
      {routesError && <p role="alert" className="text-xs text-red-700">{routesError}</p>}
      <Button variant="ghost" onClick={() => onChange({ ...value, routes: [...value.routes, { ...EMPTY_ROUTE }] })}>
        <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add route
      </Button>

      <Field id={replyId} label="Success reply" hint="Matched against the buyer's whole answer. The (?<id>...) group captures the id the buyer returns." error={replyError}>
        <TextInput id={replyId} mono value={value.success_pattern} onChange={(success_pattern) => onChange({ ...value, success_pattern })} describedBy={describedBy(replyId, true, Boolean(replyError))} />
      </Field>

      <Button variant="danger" onClick={() => onChange(null)}>
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Remove click delivery
      </Button>
    </div>
  )
}
