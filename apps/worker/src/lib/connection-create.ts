/**
 * The pure halves of POST /api/connections (#2338, build PR 5): reading the
 * form, the reserved names, how a catalogue auth kind is stored, the Google
 * list check, and who a verified login acts as. The route
 * (routes/api/connections.ts) holds the order and the calls.
 *
 * The login and target are never built here: the catalogue's connectionParts
 * is the one builder (L613), the same the ops minter contract test holds.
 */
import { connectionSecretLabel, type ConnectionAuthKind, type ServiceSchema } from '@bidspoke/service-catalogue/schema'
import type { DelegationSubjectRow, MeasuredIdentityAnswer } from './ops-connections-contract'
import { CONNECTION_NAME_MAX } from './connection-create-refusals'

/** The keys the form's body may hold. Anything else, an organization above all, is refused by name. */
const BODY_KEYS = ['service', 'name', 'fields'] as const

/** The largest body read: a Snowflake PEM is about 1.7 KB, a Google service account key about 2.4 KB. */
export const CREATE_BODY_MAX_BYTES = 32_768

export type CreateBody = { ok: true; service: string; name: string; fields: Record<string, string> } | { ok: false; problem: string }

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

const TOO_LARGE = `the body is over ${CREATE_BODY_MAX_BYTES} bytes`

/**
 * Whether a declared Content-Length already exceeds the limit, so the body is
 * refused before it is read. A missing or unreadable header is not a refusal:
 * readCreateBody measures the bytes read either way.
 */
export function declaredBodyTooLarge(contentLength: string | undefined): boolean {
  if (contentLength === undefined || !/^\d{1,12}$/.test(contentLength.trim())) return false
  return Number(contentLength.trim()) > CREATE_BODY_MAX_BYTES
}

/** The form's body, or what is wrong with it, by field name only (never a value). */
export function readCreateBody(text: string): CreateBody {
  // Bytes, not UTF-16 code units: a body of multi byte characters is measured as sent.
  if (text.length > CREATE_BODY_MAX_BYTES || new TextEncoder().encode(text).length > CREATE_BODY_MAX_BYTES) return { ok: false, problem: TOO_LARGE }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, problem: 'the body is not JSON' }
  }
  if (!isRecord(raw)) return { ok: false, problem: 'the body is not an object' }
  const extra = Object.keys(raw).filter((k) => !(BODY_KEYS as readonly string[]).includes(k))
  if (extra.length > 0) return { ok: false, problem: `the body holds ${extra.map((k) => (/^[\w.-]{1,64}$/.test(k) ? k : 'a key')).join(', ')}, which a save does not read` }
  if (typeof raw.service !== 'string') return { ok: false, problem: 'service is not text' }
  const name = raw.name ?? ''
  if (typeof name !== 'string') return { ok: false, problem: 'name is not text' }
  const fields = raw.fields ?? {}
  if (!isRecord(fields)) return { ok: false, problem: 'fields is not an object' }
  const notText = Object.entries(fields).filter(([, v]) => typeof v !== 'string').map(([k]) => (/^[\w.-]{1,64}$/.test(k) ? k : 'a field'))
  if (notText.length > 0) return { ok: false, problem: `${notText.join(', ')} ${notText.length === 1 ? 'is' : 'are'} not text` }
  return { ok: true, service: raw.service, name, fields: fields as Record<string, string> }
}

/** The service the catalogue declares under a key, or undefined. */
export function declaredService(catalogue: readonly ServiceSchema[], key: string): ServiceSchema | undefined {
  return catalogue.find((s) => s.key === key)
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** The name as stored (trimmed), or why it cannot be one. */
export function connectionNameOf(raw: string): { ok: true; name: string } | { ok: false; code: 'connection_name_missing' | 'connection_name_invalid' } {
  const name = raw.trim()
  if (name === '') return { ok: false, code: 'connection_name_missing' }
  if (name.length > CONNECTION_NAME_MAX || CONTROL.test(name)) return { ok: false, code: 'connection_name_invalid' }
  return { ok: true, name }
}

/**
 * Names no connection may take, by service, compared ignoring case. The Slack
 * alert login is the row named slack (the table's
 * service_connections_alert_name_reserved CHECK refuses an ops_key row of that
 * name, and the route maps that refusal to the same code). Ignoring case here
 * is stricter than the CHECK, so "Slack" is refused too and the page never
 * lists two logins whose names differ only in case from the alert login's.
 */
export const RESERVED_CONNECTION_NAMES: Readonly<Record<string, readonly string[]>> = {
  slack: ['slack'],
}

export function isReservedName(service: string, name: string): boolean {
  const reserved = Object.hasOwn(RESERVED_CONNECTION_NAMES, service) ? RESERVED_CONNECTION_NAMES[service] : []
  return reserved.some((r) => r.toLowerCase() === name.toLowerCase())
}

/** How each catalogue auth kind is stored in service_connections.auth_type (its CHECK, 20261017150000). */
export const AUTH_TYPE_OF: Readonly<Record<ConnectionAuthKind, string>> = {
  static_key: 'api_key',
  key_pair: 'key_pair',
  client_credentials: 'oauth_client_credentials',
  service_account_delegation: 'service_account',
  oauth_user: 'oauth_user',
}

/** The service's secret field's label in lower case, for the page's sentence ("refused the client secret"): the catalogue's one rule. */
export function secretLabelOf(service: ServiceSchema): string {
  return connectionSecretLabel(service.connection)
}

/** The Salesforce org a target declares, by its host, for the sentences that name it (#2556). */
export function orgHostOf(target: Readonly<Record<string, unknown>>): string | null {
  const url = Object.hasOwn(target, 'instance_url') ? target.instance_url : undefined
  if (typeof url !== 'string') return null
  try {
    return new URL(url.trim()).hostname || null
  } catch {
    return null
  }
}

/**
 * The mailbox and drives a Google target names that are not on the
 * organization's list (F129): compared as the ops minter and
 * google_delegation_check compare them, a mailbox trimmed and lower cased, a
 * drive id exactly. A target naming no mailbox names an empty one, which no
 * list holds. The minter refuses the same at every mint; this answers it at
 * save, by name, before verify is asked (L667).
 */
export function unlistedGoogleSubjects(target: Readonly<Record<string, unknown>>, list: readonly DelegationSubjectRow[]): string[] {
  const { mailbox, drives } = googleTargetSubjects(target)
  const mailboxes = new Set(list.filter((e) => e.kind === 'mailbox').map((e) => e.subject.toLowerCase()))
  const listedDrives = new Set(list.filter((e) => e.kind === 'drive').map((e) => e.subject))
  return [
    ...(mailboxes.has(mailbox) ? [] : [mailbox === '' ? 'The mailbox' : mailbox]),
    ...drives.filter((d) => !listedDrives.has(d)),
  ]
}

/**
 * The mailbox and drives a Google target names, read as the ops minter reads
 * them (a mailbox trimmed and lower cased, a drive id trimmed): the one reading
 * both the save's list check above and the list's removal check below use.
 * A target naming no mailbox names an empty one.
 */
export function googleTargetSubjects(target: unknown): { mailbox: string; drives: string[] } {
  const t = target !== null && typeof target === 'object' && !Array.isArray(target) ? (target as Record<string, unknown>) : {}
  const subject = Object.hasOwn(t, 'subject') ? t.subject : undefined
  const mailbox = typeof subject === 'string' ? subject.trim().toLowerCase() : ''
  const rawDrives = Object.hasOwn(t, 'drives') ? t.drives : undefined
  const drives = (Array.isArray(rawDrives) ? rawDrives : typeof rawDrives === 'string' ? [rawDrives] : [])
    .filter((d): d is string => typeof d === 'string')
    .map((d) => d.trim())
    .filter((d) => d !== '')
  return { mailbox, drives }
}

/**
 * The connections whose target names one list entry (Dan, 2026-10-20): a
 * mailbox as the connection's subject, a drive among its drives. Read from the
 * target, the connection's declaration of whom it acts as, which the Google
 * minter mints from and checks against the list (minters/google.ts); acts_as
 * holds nothing for a Google connection (actsAsOf measures Salesforce and
 * Snowflake only). Any service's row is read, so a target of this shape under
 * another service key refuses too, the harmless side (L648). Ordered by name.
 */
export function connectionsNamingSubject<R extends { name: string; target: unknown }>(rows: readonly R[], kind: 'mailbox' | 'drive', subject: string): R[] {
  const wanted = kind === 'mailbox' ? subject.trim().toLowerCase() : subject.trim()
  if (wanted === '') return []
  return rows
    .filter((r) => {
      const named = googleTargetSubjects(r.target)
      return kind === 'mailbox' ? named.mailbox === wanted : named.drives.includes(wanted)
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Who a verified login acts as, as the acts_as column holds it (1 to 320 characters), or null. */
export function actsAsOf(identity: MeasuredIdentityAnswer): string | null {
  const who = identity.kind === 'salesforce' ? identity.username : identity.kind === 'snowflake' ? identity.user : null
  return typeof who === 'string' && who.trim() !== '' && who.length <= 320 ? who : null
}
