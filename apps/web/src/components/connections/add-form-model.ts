/**
 * The Add connection form and the Reconnect dialog, read (#2338, build PR 10;
 * R12 to R16, R18, R19): which services the form offers, the orgs Bidspoke
 * knows, what a save and a Reconnect send, and every sentence the form says
 * while its check runs and when it stalls. Pure, so each is tested on its own
 * (add-form-model.test.ts) and the page only lays them out.
 *
 * The services and their fields are the catalogue's (@bidspoke/service-catalogue),
 * never typed here: a service appears on the form once its catalogue entry
 * ships, and its fields are the ones its declaration names, in its order. What
 * a save sends is the field values by key; the create route builds the login
 * and target from them with the same connectionParts the ops minters are
 * tested against, and answers each refusal in its own sentence, which the page
 * shows as it is (lib/connection-create-refusals.ts in the Worker).
 */
import { CATALOGUE, isListInput, isOwnAccountTarget, type ConnectionDeclaration, type ConnectionInput } from '@bidspoke/service-catalogue/schema'
import type { ConnectionView } from './connection-model'

/** A service as the form offers it: its catalogue key and name, its tile's line, and its connection. */
export interface FormService {
  key: string
  name: string
  tile: string
  connection: ConnectionDeclaration
}

/** The catalogue's services, in its order, which is the tiles' order (R12). */
export function catalogueServices(): FormService[] {
  return CATALOGUE.map((s) => ({ key: s.key, name: s.name, tile: s.connection.tile, connection: s.connection }))
}

/** Which way a Google connection acts: as a mailbox or drive on the company list, or as your own account (R16). */
export type GoogleWay = 'company' | 'own'

/** What the form holds: the service chosen, the name, and each service's own values, kept apart so switching service loses nothing. */
export interface AddDraft {
  service: string | null
  name: string
  values: Readonly<Record<string, Readonly<Record<string, string>>>>
  /**
   * The values of each list field ticked, in the order ticked, by service and
   * field key (#2572): a Google connection's shared drives, by drive id.
   */
  lists: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>
  /** A value typed into an org box as a new org rather than chosen from the list, by service and field key. */
  typedNew: Readonly<Record<string, Readonly<Record<string, boolean>>>>
  google: GoogleWay
}

export const EMPTY_ADD_DRAFT: AddDraft = { service: null, name: '', values: {}, lists: {}, typedNew: {}, google: 'company' }

/** Whether leaving now would lose something typed or ticked: a service chosen with nothing typed loses nothing. */
export function draftDirty(d: AddDraft): boolean {
  if (d.name.trim() !== '') return true
  if (Object.values(d.lists).some((fields) => Object.values(fields).some((v) => v.length > 0))) return true
  return Object.values(d.values).some((fields) => Object.values(fields).some((v) => v.trim() !== ''))
}

/** The values ticked in one list field of the chosen service, in the order ticked. */
export function draftList(d: AddDraft, field: string): readonly string[] {
  return (d.service && d.lists[d.service]?.[field]) || []
}

/** A list with one value ticked (added once, at the end) or unticked. */
export function pickedList(list: readonly string[], value: string, picked: boolean): string[] {
  if (!picked) return list.filter((v) => v !== value)
  return list.includes(value) ? [...list] : [...list, value]
}

/** The draft with a shared drive unticked wherever it is ticked: the drive lists are the only list fields (CONNECTION_INPUTS). */
export function withoutDrive(d: AddDraft, driveId: string): AddDraft {
  const lists = Object.fromEntries(Object.entries(d.lists).map(([service, fields]) => [
    service, Object.fromEntries(Object.entries(fields).map(([field, list]) => [field, list.filter((v) => v !== driveId)])),
  ]))
  return { ...d, lists }
}

/** The values of the chosen service's fields. */
export function draftValues(d: AddDraft): Readonly<Record<string, string>> {
  return (d.service && d.values[d.service]) || {}
}

export interface OrgOption {
  /** What the connection's target declares: the org's https address. */
  value: string
  /** The org's name where Bidspoke holds one, else its address. */
  label: string
  /** The address in a grey line under the name; absent when the label already is the address (L605). */
  hint?: string
}

/**
 * The orgs Bidspoke knows (D15): every org it holds a name for, and every org
 * one of the organization's Salesforce connections signs in to, each address
 * once, alphabetical by what is shown. An org is shown by its address until
 * Bidspoke holds a name for it.
 */
export function knownOrgs(connections: readonly ConnectionView[], orgNames: Readonly<Record<string, string>>): OrgOption[] {
  const hosts = new Set<string>(Object.keys(orgNames))
  for (const c of connections) if (c.service === 'salesforce' && c.org) hosts.add(c.org)
  return [...hosts]
    .map((host) => {
      const name = orgNames[host]
      return name ? { value: `https://${host}`, label: name, hint: host } : { value: `https://${host}`, label: host }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * An org's address read out of whatever was pasted (Dan's rule, round 29: a box
 * that needs something from another tool takes what that tool gives): a bare
 * host, the org's address with any page of it, http or https, and a Lightning
 * page's address, whose `<domain>.lightning.force.com` is the same org as
 * `<domain>.my.salesforce.com`. Whether the org is one Bidspoke may connect to
 * is the save route's to say, in its own words.
 */
export function readOrgAddress(text: string): { ok: true; url: string } | { ok: false } {
  const t = text.trim()
  if (t === '' || /\s/.test(t)) return { ok: false }
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`)
  } catch {
    return { ok: false }
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) return { ok: false }
  const host = url.hostname.toLowerCase().replace(/\.lightning\.force\.com$/, '.my.salesforce.com')
  return { ok: true, url: `https://${host}` }
}

/** What POST /api/connections is sent: the service, the name, and each field's value by its key, a list field's as a list. */
export interface CreateBody {
  service: string
  name: string
  fields: Record<string, string | string[]>
}

/**
 * The save's body: blank fields and empty lists left out (the route names a
 * missing one), an org's address read out of what was typed, and a list
 * field's ticked values as a list, the shape connectionParts builds the
 * target from (#2572).
 */
export function createBodyOf(service: FormService, d: AddDraft): CreateBody {
  const values = d.values[service.key] ?? {}
  const lists = d.lists[service.key] ?? {}
  const fields: Record<string, string | string[]> = {}
  for (const f of service.connection.fields) {
    if (isListInput(f.input)) {
      const picked = lists[f.key] ?? []
      if (picked.length > 0) fields[f.key] = [...picked]
      continue
    }
    const v = values[f.key]
    if (v === undefined || v.trim() === '') continue
    if (f.input === 'salesforce_org') {
      const read = readOrgAddress(v)
      fields[f.key] = read.ok ? read.url : v
    } else {
      // Kept exactly as typed: a key's line breaks are part of it.
      fields[f.key] = v
    }
  }
  return { service: service.key, name: d.name.trim(), fields }
}

/** What the create route answers with on a save. */
export interface CreatedConnection {
  id: string
  name: string
  service: string
  acts_as: string | null
  target: Record<string, unknown> | null
  created_at: string
}

function orgHostOf(target: Record<string, unknown> | null): string | null {
  const url = target?.instance_url
  if (typeof url !== 'string') return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/**
 * The connection a save made, as the list shows it (R18): its login was just
 * checked, so it is working and checked now; no workflow uses it yet.
 */
export function createdView(answer: CreatedConnection, service: FormService, now: number): ConnectionView {
  return {
    id: answer.id,
    name: answer.name,
    service: answer.service,
    serviceName: service.name,
    actsAs: answer.acts_as,
    status: 'ok',
    org: answer.service === 'salesforce' ? orgHostOf(answer.target) : null,
    target: answer.target,
    workflows: [],
    lastCheckedAt: new Date(now).toISOString(),
    problemSince: null,
    problemCause: null,
    alertLogin: false,
    // A person's own Google account is saved by its sign in (#2338), and says so by its target.
    ownAccount: isOwnAccountTarget(answer.target),
  }
}

export interface ReconnectFields {
  /** What the connection names that the login is also built from (Salesforce's client id), shown and kept. */
  kept: Array<{ key: string; label: string; value: string }>
  /** The login's own fields, asked for anew. */
  asked: Array<{ key: string; label: string; input: ConnectionInput }>
}

/**
 * What Reconnect shows (D19): a Reconnect keeps what the connection names, so
 * each field that is both login and target is shown with its kept value, and
 * each field of the login alone is asked for as "New <label>". A field of the
 * target alone (the org) is not the login and is not shown.
 */
export function reconnectFieldsOf(connection: ConnectionDeclaration, target: Readonly<Record<string, unknown>> | null): ReconnectFields {
  const kept: ReconnectFields['kept'] = []
  const asked: ReconnectFields['asked'] = []
  for (const f of connection.fields) {
    if (f.login === undefined) continue
    if (f.target !== undefined) {
      const v = target?.[f.target]
      kept.push({ key: f.key, label: f.label, value: typeof v === 'string' ? v : '' })
    } else {
      asked.push({ key: f.key, label: `New ${f.label.toLowerCase()}`, input: f.input })
    }
  }
  return { kept, asked }
}

/**
 * What Reconnect asks on the Slack alerts login (build PR 14, Dan's decision
 * 4): its new bot token, by the key the Worker takes (bot_token), which Slack
 * checks before it is saved. Slack has no catalogue entry, so it is named here.
 */
export const SLACK_ALERT_RECONNECT_FIELDS: ReconnectFields = {
  kept: [],
  asked: [{ key: 'bot_token', label: 'New bot token', input: 'secret' }],
}

/** What Reconnect shows for a connection: the Slack alerts login's token, its catalogue entry's fields, or nothing for a service it does not declare. */
export function reconnectFieldsFor(connection: Pick<ConnectionView, 'alertLogin' | 'target'>, service: FormService | null): ReconnectFields {
  if (connection.alertLogin) return SLACK_ALERT_RECONNECT_FIELDS
  return service ? reconnectFieldsOf(service.connection, connection.target) : { kept: [], asked: [] }
}

/** A Reconnect's body: the new login's fields that were typed, or none, which checks the stored login again. */
export function reconnectBodyOf(values: Readonly<Record<string, string>>): { fields?: Record<string, string> } {
  const fields = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ''))
  return Object.keys(fields).length > 0 ? { fields } : {}
}

/** The working line's words while a save or a Reconnect checks the login (R13, D13). */
export function workingLabel(serviceName: string): string {
  return `Checking the login with ${serviceName}`
}

/** What a time taking change was doing, for the sentences about it. */
export type ChangeKind = 'saved' | 'reconnected' | 'removed'

const WORDS: Readonly<Record<ChangeKind, { what: string; verb: string; again: string; redo: string }>> = {
  saved: { what: 'the connection', verb: 'saved', again: 'saving again', redo: 'save again' },
  reconnected: { what: 'the new login', verb: 'saved', again: 'reconnecting again', redo: 'reconnect again' },
  removed: { what: 'the connection', verb: 'removed', again: 'removing it again', redo: 'remove it again' },
}

/**
 * What the line says when the change has not answered by its deadline (R13): a
 * check that stalls may still land, so the sentence never says nothing was
 * saved; it says that is not known, and how to find out.
 */
export function stalledSentence(serviceName: string, deadlineMs: number, kind: ChangeKind): string {
  const w = WORDS[kind]
  const seconds = Math.round(deadlineMs / 1000)
  if (kind === 'removed') return `Bidspoke did not answer within ${seconds} seconds, so it cannot tell whether ${w.what} was ${w.verb}. Reload the page to see before ${w.again}.`
  return `The login check with ${serviceName} did not answer within ${seconds} seconds, so Bidspoke cannot tell whether ${w.what} was ${w.verb}. Reload the page to see before ${w.again}.`
}

/**
 * The failed line's sentence (R14): the route's own when it answered one (each
 * cause the save route names has its own); otherwise what the client measured,
 * and whether the change may have landed: a call the client gave up on, a
 * server that failed or could not be reached may have made it (L11), while a
 * sign in that ended stopped it before the route ran.
 */
export function saveFailureSentence(err: unknown, serviceName: string, deadlineMs: number, kind: ChangeKind): string {
  const e = (err ?? {}) as { body?: unknown; timedOut?: unknown; status?: unknown }
  const sentence = e.body && typeof e.body === 'object' ? (e.body as { message?: unknown }).message : undefined
  if (typeof sentence === 'string' && sentence.trim() !== '') return sentence
  if (e.timedOut === true) return stalledSentence(serviceName, deadlineMs, kind)
  const w = WORDS[kind]
  const nothing = kind === 'removed' ? 'removed' : 'saved'
  if (e.status === 401) return `Your sign in has ended, so nothing was ${nothing}. Sign in again in a new tab, then ${w.redo}.`
  if (e.status === 403) return `Your account no longer has access to Bidspoke, so nothing was ${nothing}.`
  const why = err instanceof TypeError ? 'could not be reached' : 'failed while answering'
  return `Bidspoke's server ${why}, so whether ${w.what} was ${w.verb} is not known. Reload the page to see before ${w.again}.`
}
