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
