/**
 * The Connections page's reading of the list (#2338, build PR 9): how the
 * connections group, and every sentence the page builds from a connection.
 * Pure, so each is tested on its own (connection-model.test.ts) and the page
 * only lays them out.
 *
 * Status words are the catalogue's (CONNECTION_STATUS_WORDS in
 * @bidspoke/service-catalogue), never typed here, and every time is Eastern.
 */
import { CATALOGUE, CONNECTION_STATUS_WORDS, connectionSecretLabel, isConnectionProblem, type ConnectionPageStatus } from '@bidspoke/service-catalogue/schema'
import type { ConnectionListRow } from '@/lib/api'

const ET = 'America/New_York'

/** The Google section's own entry, the company list of mailboxes and drives (R10, D10). */
export const GOOGLE_SERVICE_NAME = 'Google'
export const GOOGLE_LIST_ENTRY = 'Mailboxes and drives'

export interface UsingWorkflow { id: string; name: string; deleted: boolean }

/** One connection as the page shows it. */
export interface ConnectionView {
  id: string
  name: string
  /** The catalogue key. */
  service: string
  serviceName: string
  actsAs: string | null
  status: ConnectionPageStatus | null
  /** A Salesforce connection's org host, its Org fact. */
  org: string | null
  /** What the connection declares it signs in to (its public half): Reconnect shows the parts it keeps (build PR 10). */
  target: Readonly<Record<string, unknown>> | null
  workflows: UsingWorkflow[]
  /** When the last check answered, either way; null when never checked. */
  lastCheckedAt: string | null
  /** When the problem began, and what ops recorded as its cause. */
  problemSince: string | null
  problemCause: string | null
  alertLogin: boolean
}

export function viewOf(row: ConnectionListRow): ConnectionView {
  const h = row.health
  const checks = [h?.last_check_ok_at ?? null, h?.last_check_failed_at ?? null].filter((t): t is string => t !== null)
  const lastCheckedAt = row.checked_at !== undefined ? row.checked_at : checks.length ? checks.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null
  const since = row.status === 'reauth' ? h?.needs_reauth_at ?? null : row.status === 'failing' ? h?.last_check_failed_at ?? null : null
  const cause = row.status === 'reauth' ? h?.needs_reauth_cause ?? null : row.status === 'failing' ? h?.last_check_cause ?? null : null
  return {
    id: row.id,
    name: row.name,
    service: row.service,
    serviceName: row.service_name ?? row.service,
    actsAs: row.acts_as,
    status: row.status,
    org: row.org ?? null,
    target: row.target ?? null,
    workflows: row.workflows ?? [],
    lastCheckedAt,
    problemSince: since,
    problemCause: cause,
    alertLogin: row.alert_login === true,
  }
}

/** The catalogue's word for a status, or null when the page has none to show. */
export function statusWord(status: ConnectionPageStatus | null): string | null {
  return status ? CONNECTION_STATUS_WORDS[status] : null
}

export function isProblem(c: Pick<ConnectionView, 'status'>): boolean {
  return c.status !== null && isConnectionProblem(c.status)
}

export interface ListGroup {
  heading: string
  attention: boolean
  /** The Google section opens with the company list's own entry. */
  googleEntry: boolean
  items: ConnectionView[]
}

/**
 * Needs attention first, holding every connection with a problem; then every
 * other connection under its service, services and names alphabetical (R3,
 * D3). The Google section is always there, opening with Mailboxes and drives,
 * because the company list must be editable before a Google connection can be
 * added to it.
 */
export function listGroups(connections: readonly ConnectionView[]): ListGroup[] {
  const sorted = [...connections].sort((a, b) => a.serviceName.localeCompare(b.serviceName) || a.name.localeCompare(b.name))
  const out: ListGroup[] = []
  const bad = sorted.filter(isProblem)
  if (bad.length) out.push({ heading: 'Needs attention', attention: true, googleEntry: false, items: bad })
  const byService = new Map<string, ConnectionView[]>()
  for (const c of sorted.filter((x) => !isProblem(x))) {
    const list = byService.get(c.serviceName) ?? []
    list.push(c)
    byService.set(c.serviceName, list)
  }
  if (!byService.has(GOOGLE_SERVICE_NAME)) byService.set(GOOGLE_SERVICE_NAME, [])
  for (const heading of [...byService.keys()].sort((a, b) => a.localeCompare(b))) {
    out.push({ heading, attention: false, googleEntry: heading === GOOGLE_SERVICE_NAME, items: byService.get(heading) ?? [] })
  }
  return out
}

/** The first connection in the list as read, or null when there is none. */
export function firstConnection(groups: readonly ListGroup[]): ConnectionView | null {
  for (const g of groups) if (g.items.length) return g.items[0]
  return null
}

// ── Times ───────────────────────────────────────────────────────────────────

/**
 * "9:52 AM": the Eastern clock. The space before AM is a plain one: newer
 * ICU data writes a narrow no break space there and older data a plain one, so
 * the same moment would read differently in two browsers.
 */
export function etClock(at: string | number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' }).format(new Date(at)).replace(/[  ]/g, ' ')
}

/** "Oct 18": the Eastern day. */
export function etDay(at: string | number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: ET, month: 'short', day: 'numeric' }).format(new Date(at))
}

function sameEtDay(a: string | number, b: string | number): boolean {
  const key = (t: string | number) => new Intl.DateTimeFormat('en-US', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t))
  return key(a) === key(b)
}

/** "9:52 AM ET" today, "Oct 18, 9:52 AM ET" on another day. */
export function etMoment(at: string | number, now: number): string {
  return sameEtDay(at, now) ? `${etClock(at)} ET` : `${etDay(at)}, ${etClock(at)} ET`
}

/** How long ago a check answered: "just now", "4 min ago", "2 hours ago", then the day. */
export function agoText(at: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  return etDay(at)
}

// ── The problem notice (R7, D7) ─────────────────────────────────────────────

/** "A", "A and B", "A, B and C". */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** What a sentence calls the connection's secret: the catalogue's label, the alert login's token, or its login. */
export function secretWordOf(c: Pick<ConnectionView, 'service' | 'alertLogin'>): string {
  if (c.alertLogin) return 'token'
  const declared = CATALOGUE.find((s) => s.key === c.service)
  return declared ? connectionSecretLabel(declared.connection) : 'login'
}

export interface ProblemNotice {
  /** When it began and its cause, one sentence. */
  cause: string
  /** Its effect on the workflows using it; null when none uses it. */
  effect: string | null
  /** The grey line saying how to fix it. */
  fix: string
}

/**
 * The notice a connection with a problem opens its Connection tab with, built
 * from its health: when it began in Eastern time with its cause, what it does
 * to the workflows using it, and what fixes it. `orgNames` names an org by its
 * host where Bidspoke knows it ("Achieve"); a host it does not know is named as
 * itself.
 */
export function problemNotice(c: ConnectionView, now: number, orgNames: Readonly<Record<string, string>> = {}): ProblemNotice | null {
  if (!isProblem(c)) return null
  const secret = secretWordOf(c)
  const since = c.problemSince ? `Since ${etMoment(c.problemSince, now)}, ` : ''
  // Each cause starts with a name (the service's, or Bidspoke's), so it follows "Since ..., " as written.
  const said = (s: string) => since + s
  let cause: string
  if (c.status === 'reauth') {
    const refused = c.alertLogin || (c.problemCause ?? '').startsWith('login_refused')
    cause = refused ? `${c.serviceName} has refused its ${secret}.` : `${c.serviceName} has stopped accepting its ${secret}.`
  } else {
    cause = `Bidspoke's checks of this login with ${c.serviceName} have failed.`
  }
  const live = c.workflows.filter((w) => !w.deleted).map((w) => w.name)
  let effect: string | null = null
  if (live.length === 1) effect = `${live[0]} ${c.status === 'reauth' ? 'stops' : 'may stop'} at its ${c.serviceName} step.`
  else if (live.length > 1 && live.length <= 3) effect = `${listed(live)} ${c.status === 'reauth' ? 'stop' : 'may stop'} at their ${c.serviceName} steps.`
  else if (live.length > 3) effect = `The ${live.length} workflows using it ${c.status === 'reauth' ? 'stop' : 'may stop'} at their ${c.serviceName} steps.`
  const orgName = c.org ? orgNames[c.org] : undefined
  const from = orgName ? `${orgName}'s ${c.serviceName} admin` : c.org ? `the ${c.serviceName} admin of ${c.org}` : `the ${c.serviceName} admin`
  const fix = c.status === 'reauth'
    ? c.alertLogin ? 'Save a new token for it from the Slack app.' : `Reconnect with a new ${secret} from ${from}.`
    : 'Reconnect to check the login again.'
  return { cause: said(cause), effect, fix }
}

// ── History (R5) ────────────────────────────────────────────────────────────

export interface HistoryEntry {
  id: string
  action: string
  at: string
  by: string | null
  credential_changed: boolean
  changes: unknown
}

/** What one history entry says happened. */
export function historyWhat(e: HistoryEntry, secret: string): string {
  if (e.action === 'INSERT') return 'Added'
  if (e.action === 'DELETE') return 'Removed'
  if (e.action === 'connection_rechecked') return 'Login checked again'
  if (e.credential_changed) return `Reconnected with a new ${secret}`
  return 'Changed'
}

// ── The Google list (R10, D10) ──────────────────────────────────────────────

export interface DelegationEntry {
  kind: 'mailbox' | 'drive'
  subject: string
  display_name: string | null
  added_by: string
  added_at: string
}

export const DELEGATION_KIND_WORDS: Readonly<Record<DelegationEntry['kind'], string>> = { mailbox: 'Mailbox', drive: 'Shared drive' }

export function delegationShown(e: DelegationEntry): string {
  return e.display_name ?? e.subject
}

export function delegationAdded(e: DelegationEntry): string {
  return `Added by ${e.added_by}, ${etDay(e.added_at)}`
}

/**
 * A shared drive's id as the ops list judges it (google_delegation_subjects,
 * ops migration 20261018170000): 10 to 128 letters, digits, dashes and
 * underscores.
 */
const DRIVE_ID = /^[A-Za-z0-9_-]{10,128}$/

export type DriveAddressReading =
  | { ok: true; id: string }
  | { ok: false; why: 'empty' | 'not_drive' | 'not_a_folder' }

/** The one sentence the add box shows when a pasted text holds no shared drive (Dan, round 30). */
export const NOT_A_DRIVE_ADDRESS = 'That is not a Google Drive shared drive address.'

/**
 * The drive id in whatever a person copies from Google Drive (Dan, rounds 29
 * to 31, 2026-10-21: a box that needs an id from another tool takes what that
 * tool gives and pulls the id out itself). Read: the folder address
 * https://drive.google.com/drive/folders/<id>, the signed in form
 * /drive/u/<n>/folders/<id>, either with a query string or a fragment, with
 * or without https://, and a bare id pasted on its own. Refused: an empty
 * box, any other site's address, and a Drive address that is not a folder's
 * (a single file's /file/d/<id>/view, a Docs link, the Drive home page).
 */
export function readDriveAddress(text: string): DriveAddressReading {
  const t = text.trim()
  if (t === '') return { ok: false, why: 'empty' }
  if (DRIVE_ID.test(t)) return { ok: true, id: t }
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`)
  } catch {
    return { ok: false, why: 'not_drive' }
  }
  if (url.hostname.toLowerCase() !== 'drive.google.com' || !/^https?:$/.test(url.protocol)) return { ok: false, why: 'not_drive' }
  const folder = /^\/drive\/(?:u\/\d+\/)?folders\/([^/]+)\/?$/.exec(url.pathname)
  if (!folder) return { ok: false, why: 'not_a_folder' }
  return DRIVE_ID.test(folder[1]) ? { ok: true, id: folder[1] } : { ok: false, why: 'not_a_folder' }
}

/** What the add box holds: which kind is chosen, and each kind's own boxes. */
export interface DelegationDraft {
  kind: DelegationEntry['kind']
  mailbox: string
  driveAddress: string
  driveName: string
}

export const EMPTY_DRAFT: DelegationDraft = { kind: 'mailbox', mailbox: '', driveAddress: '', driveName: '' }

/** Whether the chosen kind's boxes hold enough to try adding: an address, and for a drive its name too. */
export function draftReady(d: DelegationDraft): boolean {
  return d.kind === 'mailbox' ? d.mailbox.trim() !== '' : d.driveAddress.trim() !== '' && d.driveName.trim() !== ''
}

export type AddRequest =
  | { ok: true; body: { kind: DelegationEntry['kind']; subject: string; display_name: string | null }; shown: string }
  | { ok: false; sentence: string }

/** What adding the draft sends, and the name it is shown by while it goes; or the sentence refusing it before anything is sent. */
export function addRequestOf(d: DelegationDraft): AddRequest {
  if (d.kind === 'mailbox') {
    const address = d.mailbox.trim()
    return { ok: true, body: { kind: 'mailbox', subject: address, display_name: null }, shown: address }
  }
  const reading = readDriveAddress(d.driveAddress)
  if (!reading.ok) return { ok: false, sentence: NOT_A_DRIVE_ADDRESS }
  const name = d.driveName.trim()
  return { ok: true, body: { kind: 'drive', subject: reading.id, display_name: name === '' ? null : name }, shown: name === '' ? 'the shared drive' : name }
}
