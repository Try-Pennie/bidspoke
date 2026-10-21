/**
 * The step form's Connection field (#2338 build PR 11, R8, D8): what it offers
 * and every line it draws under itself, as pure functions of the connections
 * list, so the component only lays them out.
 *
 * A step names its connection only by id (the trigger
 * `workflows_refuse_missing_connections`), so the field stores the id and
 * shows the name. Status words are the catalogue's (CONNECTION_STATUS_WORDS in
 * @bidspoke/service-catalogue, read through statusWord), never typed here.
 */
import type { ComboboxOption } from '@/components/ui/Combobox'
import { isProblem, statusWord, type ConnectionView } from './connection-model'

/** The page a connection's problem is fixed on, as the problem line names it (round 24). */
export const CONNECTIONS_PAGE = 'Connections page'

/** What the line under a loading list says, with the seconds counted after it. */
export const LOADING_LABEL = 'Loading the connections'

export const GONE_SENTENCE = 'The connection this step used no longer exists. Choose another.'

/** The Connections page, opening the connection named when there is one. */
export function connectionsPageHref(id?: string): string {
  return id ? `/connections?connection=${encodeURIComponent(id)}` : '/connections'
}

/** The connections a step of this service can use, by name. The Slack alert login is Bidspoke's own, never a step's. */
export function connectionsFor(service: string, all: readonly ConnectionView[]): ConnectionView[] {
  return all.filter((c) => c.service === service && !c.alertLogin).sort((a, b) => a.name.localeCompare(b.name))
}

/** The dropdown's rows: each connection's name, with who it acts as as its grey second line. */
export function connectionOptions(list: readonly ConnectionView[]): ComboboxOption[] {
  return list.map((c) => (c.actsAs ? { value: c.id, label: c.name, hint: `Acts as ${c.actsAs}` } : { value: c.id, label: c.name }))
}

/** The list as the field reads it: loading with its seconds, failed with its sentence, or the service's connections. */
export type FieldList =
  | { kind: 'loading'; seconds: number }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; connections: readonly ConnectionView[] }

/**
 * A line under the dropdown. Who the connection acts as is not one of them:
 * the dropdown draws its chosen row's second line itself.
 */
export type FieldLine =
  | { kind: 'problem'; word: string; page: string; href: string }
  | { kind: 'loading'; label: string; seconds: number }
  | { kind: 'failed'; sentence: string }
  | { kind: 'empty'; before: string; page: string; after: string; href: string }
  | { kind: 'gone'; sentence: string }

export function emptyLine(serviceName: string): FieldLine {
  return { kind: 'empty', before: `No ${serviceName} connection yet. Add one on the `, page: CONNECTIONS_PAGE, after: '.', href: connectionsPageHref() }
}

/**
 * Nothing about status while the chosen connection works (D8); one red line
 * with its status and where it is fixed when it has a problem. `list` holds
 * the service's connections only (connectionsFor).
 */
export function connectionFieldLines(list: FieldList, chosenId: string | null, serviceName: string): FieldLine[] {
  if (list.kind === 'loading') return [{ kind: 'loading', label: LOADING_LABEL, seconds: list.seconds }]
  if (list.kind === 'failed') return [{ kind: 'failed', sentence: list.message }]
  if (list.connections.length === 0) return [emptyLine(serviceName)]
  if (!chosenId) return []
  const chosen = list.connections.find((c) => c.id === chosenId)
  if (!chosen) return [{ kind: 'gone', sentence: GONE_SENTENCE }]
  const word = isProblem(chosen) ? statusWord(chosen.status) : null
  return word ? [{ kind: 'problem', word, page: CONNECTIONS_PAGE, href: connectionsPageHref(chosen.id) }] : []
}
