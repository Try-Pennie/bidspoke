import { CATALOGUE, catalogueActions, resolveActionVersion } from '@bidspoke/service-catalogue/schema'

/**
 * What an App Action step's card says (#2339; settled in
 * docs/design/app-action-node-card.html): the service in the header, as a person
 * knows it, and the name of the action version the step pinned in a chip.
 *
 * Google is one catalogue service for Sheets, Gmail, Drive and Calendar, so its
 * card names the product the action runs in (Google Drive), and the action
 * without the product prefix the catalogue's name carries ("Drive: list files"
 * reads List files). The chip is read from the pinned version only: a version
 * the catalogue does not have shows no chip, never a newer version's name.
 *
 * `mark` names the service's own mark where the build has one. Only Google
 * Drive's is here, the one the design round drew; every other service draws the
 * plain box until its mark is added (the catalogue holds no marks).
 */

export type AppActionMark = 'google-drive'

export interface AppActionDisplay {
  service: string
  action: string | null
  mark: AppActionMark | null
}

const ACTIONS = catalogueActions(CATALOGUE)

const GOOGLE_PRODUCTS: ReadonlyArray<{ prefix: string; name: string; mark: AppActionMark | null }> = [
  { prefix: 'google.drive-', name: 'Google Drive', mark: 'google-drive' },
  { prefix: 'google.sheets-', name: 'Google Sheets', mark: null },
  { prefix: 'google.gmail-', name: 'Gmail', mark: null },
  { prefix: 'google.calendar-', name: 'Google Calendar', mark: null },
]

const capitalised = (s: string) => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1))

export function appActionDisplay(config: Record<string, unknown>): AppActionDisplay {
  const serviceKey = typeof config.service === 'string' ? config.service : null
  const service = CATALOGUE.find((s) => s.key === serviceKey)
  const actionKey = typeof config.action === 'string' ? config.action : null
  const version = config.actionVersion
  const resolved = actionKey !== null && typeof version === 'number' ? resolveActionVersion(ACTIONS, actionKey, version) : null
  const action = resolved?.ok ? resolved.action : null
  const product = actionKey !== null ? GOOGLE_PRODUCTS.find((p) => actionKey.startsWith(p.prefix)) : undefined

  const name = product?.name ?? service?.name ?? 'App action'
  let chip: string | null = null
  if (action !== null) chip = product ? capitalised(action.name.replace(/^[^:]+:\s*/, '')) : action.name
  return { service: name, action: chip, mark: product?.mark ?? null }
}

/**
 * The tick box's words before a test of a step that sends for real (#2339;
 * settled in docs/design/app-action-test-send.html): what the pinned action
 * sends, from the catalogue's realSend, and the connection it sends from, by its
 * name. Null for a read, and for an action version the catalogue does not have,
 * which a test refuses before sending anything. While the connection's name is
 * not known it says this step's connection, never a guess.
 */
export function appActionRealSend(config: Record<string, unknown>, connectionName: string | null): string | null {
  const actionKey = typeof config.action === 'string' ? config.action : null
  const version = config.actionVersion
  const resolved = actionKey !== null && typeof version === 'number' ? resolveActionVersion(ACTIONS, actionKey, version) : null
  if (!resolved?.ok || !resolved.action.sideEffect || !resolved.action.realSend) return null
  return `Send for real. This ${resolved.action.realSend} from ${connectionName ?? 'this step\'s connection'}. It cannot be taken back.`
}

/**
 * The connection a test of this step may send through for real, or null: only
 * an App Action step whose pinned action changes something asks first. The
 * canvas reads the connection's name only for such a step.
 */
export function realSendConnectionOf(nodeType: string, config: Record<string, unknown>): string | null {
  if (nodeType !== 'app_action' || typeof config.connection !== 'string') return null
  return appActionRealSend(config, null) === null ? null : config.connection
}

/**
 * The step form's Service dropdown (#2338, settled in
 * docs/design/app-action-step-form.html): every catalogue service as a person
 * knows it, Google split into the products its actions run in (Gmail, Google
 * Sheets and so on), the same names the card shows. `value` is the choice's own
 * key; `service` the catalogue service the step stores; `prefix` the action keys
 * it offers.
 */
export interface AppActionServiceChoice {
  value: string
  label: string
  service: string
  prefix: string
}

export const APP_ACTION_SERVICE_CHOICES: readonly AppActionServiceChoice[] = CATALOGUE.flatMap((s): AppActionServiceChoice[] =>
  s.key === 'google'
    ? GOOGLE_PRODUCTS.map((p) => ({ value: p.prefix.replace(/[.-]$/, '').replace('.', ':'), label: p.name, service: 'google', prefix: p.prefix }))
    : [{ value: s.key, label: s.name, service: s.key, prefix: `${s.key}.` }],
).sort((a, b) => a.label.localeCompare(b.label))

/** The choice a step's settings fall under: its action's product, else its service; null when nothing is chosen. */
export function appActionServiceChoice(config: Record<string, unknown>): AppActionServiceChoice | null {
  const action = typeof config.action === 'string' ? config.action : null
  const service = typeof config.service === 'string' ? config.service : null
  if (action !== null) {
    const byAction = APP_ACTION_SERVICE_CHOICES.find((c) => action.startsWith(c.prefix))
    if (byAction) return byAction
  }
  const byService = APP_ACTION_SERVICE_CHOICES.filter((c) => c.service === service)
  return byService.length === 1 ? byService[0] : null
}

/** One action a choice offers, at its newest version: what a step pins when it is chosen. */
export interface AppActionChoice {
  value: string
  label: string
  version: number
}

/** The Action dropdown: only the chosen service's actions, each named as the card names it. */
export function appActionChoices(choice: AppActionServiceChoice | null): AppActionChoice[] {
  if (choice === null) return []
  const newest = new Map<string, (typeof ACTIONS)[number]>()
  for (const a of ACTIONS) {
    if (!a.key.startsWith(choice.prefix)) continue
    const seen = newest.get(a.key)
    if (!seen || a.version > seen.version) newest.set(a.key, a)
  }
  const isProduct = choice.service === 'google'
  return [...newest.values()].map((a) => ({ value: a.key, label: isProduct ? capitalised(a.name.replace(/^[^:]+:\s*/, '')) : a.name, version: a.version }))
}

/** The pinned action version's schema, or null for none or a version the catalogue does not have. */
export function appActionSchema(config: Record<string, unknown>) {
  const actionKey = typeof config.action === 'string' ? config.action : null
  const version = config.actionVersion
  const resolved = actionKey !== null && typeof version === 'number' ? resolveActionVersion(ACTIONS, actionKey, version) : null
  return resolved?.ok ? resolved.action : null
}
