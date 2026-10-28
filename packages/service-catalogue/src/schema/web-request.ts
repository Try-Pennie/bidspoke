import { CATALOGUE } from './catalogue'

/**
 * The canvas's Webhook step (a web request any workflow sends, the money lane's
 * included) and the services its form offers, each with the sign in the form
 * presets when it is picked (#2342, decision 10 of the #1689 plan). This is the
 * one list; ConfigPanel.tsx reads it and holds no copy.
 *
 * A preset is a convenience of the form, nothing more: picking a service writes
 * `service`, `service_label` and `auth.type` into the step, and the engine sends
 * whatever the step stores (engine/nodes/integration.ts). It never looks a
 * service up here, so this list cannot change what a saved step sends.
 *
 * Two entries are not catalogue services, and are declared here rather than
 * invented as services, because a catalogue service is an ops connection with
 * actions and an Add connection tile:
 *   custom   the step's own address and sign in, which is no service at all.
 *   equifax  the bidding lane's credit pull, signed in with the step's own
 *            {{env.X}} values, not through an ops connection.
 * Every other entry is a catalogue service that declares `webRequestAuth`,
 * named by its catalogue key and name, after these two, in catalogue order.
 */
export const WEB_REQUEST_AUTH_TYPES = ['none', 'bearer', 'basic', 'api_key'] as const
export type WebRequestAuthType = (typeof WEB_REQUEST_AUTH_TYPES)[number]

export interface WebRequestService {
  /** What the step stores as `service`. Never change one: saved steps hold it. */
  readonly value: string
  /** The option's words, also stored as `service_label` when it is picked. */
  readonly label: string
  /** The sign in the form sets when it is picked; the person can change it. */
  readonly authType: WebRequestAuthType
}

const NOT_CATALOGUE_SERVICES: readonly WebRequestService[] = [
  { value: 'custom', label: 'Custom', authType: 'none' },
  { value: 'equifax', label: 'Equifax', authType: 'basic' },
]

export const WEB_REQUEST_SERVICES: readonly WebRequestService[] = [
  ...NOT_CATALOGUE_SERVICES,
  ...CATALOGUE.flatMap((s) => (s.webRequestAuth === undefined ? [] : [{ value: s.key, label: s.name, authType: s.webRequestAuth }])),
]

/** The sign in to preset for a picked service: none for one the list does not hold, as before. */
export function webRequestAuthFor(service: string): WebRequestAuthType {
  return WEB_REQUEST_SERVICES.find((s) => s.value === service)?.authType ?? 'none'
}
