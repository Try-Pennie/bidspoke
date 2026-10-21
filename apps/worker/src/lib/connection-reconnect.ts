/**
 * The pure halves of POST /api/connections/:id/reconnect and the Google list
 * routes (#2338, build PR 6; R10, R19): reading their bodies, and building a
 * Reconnect's form values from what the stored row names plus the new login.
 * The routes (routes/api/connections.ts) hold the order and the calls.
 *
 * A Reconnect keeps what the connection names (D19: "keeping the client id and
 * asking for a new client secret"): its target is the row's, never the body's,
 * so the login is rebuilt by the catalogue's one builder, connectionParts, from
 * the row's target values and the new login fields. A body value for a target
 * field is accepted only when it is the row's own.
 */
import type { ConnectionDeclaration } from '@bidspoke/service-catalogue/schema'
import { CREATE_BODY_MAX_BYTES } from './connection-create'
import { DELEGATION_KINDS, type DelegationKind } from '../ops/run-vocabulary'

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const keyName = (k: string, fallback: string) => (/^[\w.-]{1,64}$/.test(k) ? k : fallback)

/** A body's text as JSON, within the create route's byte limit; an empty body is {}. */
function readJsonBody(text: string): { ok: true; raw: Record<string, unknown> } | { ok: false; problem: string } {
  if (text.length > CREATE_BODY_MAX_BYTES || new TextEncoder().encode(text).length > CREATE_BODY_MAX_BYTES) {
    return { ok: false, problem: `the body is over ${CREATE_BODY_MAX_BYTES} bytes` }
  }
  if (text.trim() === '') return { ok: true, raw: {} }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, problem: 'the body is not JSON' }
  }
  if (!isRecord(raw)) return { ok: false, problem: 'the body is not an object' }
  return { ok: true, raw }
}

function onlyKeys(raw: Record<string, unknown>, keys: readonly string[], what: string): string | null {
  const extra = Object.keys(raw).filter((k) => !keys.includes(k))
  return extra.length > 0 ? `the body holds ${extra.map((k) => keyName(k, 'a key')).join(', ')}, which ${what} does not read` : null
}

/**
 * A Reconnect's body: `{}` (or none) checks the stored login again; `{ fields }`
 * is a new login, by the form's field keys. By field name only, never a value.
 */
export type ReconnectBody = { ok: true; fields: Record<string, string> | null } | { ok: false; problem: string }

export function readReconnectBody(text: string): ReconnectBody {
  const read = readJsonBody(text)
  if (!read.ok) return read
  const extra = onlyKeys(read.raw, ['fields'], 'a Reconnect')
  if (extra) return { ok: false, problem: extra }
  const fields = read.raw.fields
  if (fields === undefined || fields === null) return { ok: true, fields: null }
  if (!isRecord(fields)) return { ok: false, problem: 'fields is not an object' }
  const notText = Object.entries(fields).filter(([, v]) => typeof v !== 'string').map(([k]) => keyName(k, 'a field'))
  if (notText.length > 0) return { ok: false, problem: `${notText.join(', ')} ${notText.length === 1 ? 'is' : 'are'} not text` }
  return { ok: true, fields: fields as Record<string, string> }
}

export type ReconnectValues =
  | { ok: true; values: Record<string, string> }
  /** A body field the service does not declare. */
  | { ok: false; code: 'connection_fields_undeclared'; fields: string[] }
  /** A body value for a target field that is not the row's own. */
  | { ok: false; code: 'reconnect_target_changed'; fields: string[] }
  /** The row names a target field with a value the form cannot hold. */
  | { ok: false; code: 'reconnect_target_unreadable'; fields: string[] }

/**
 * The form values a Reconnect's login is built from: every target field the
 * row names, as it names it, then the body's login fields. Fields the service
 * declares as both (Salesforce's client id) come from the row.
 */
export function reconnectValues(connection: ConnectionDeclaration, rowTarget: unknown, body: Readonly<Record<string, string>>): ReconnectValues {
  const target = isRecord(rowTarget) ? rowTarget : {}
  const values: Record<string, string> = {}
  const unreadable: string[] = []
  for (const f of connection.fields) {
    if (f.target === undefined || !Object.hasOwn(target, f.target)) continue
    const v = target[f.target]
    if (v === null || v === undefined) continue
    if (typeof v !== 'string') unreadable.push(f.key)
    else values[f.key] = v
  }
  if (unreadable.length > 0) return { ok: false, code: 'reconnect_target_unreadable', fields: unreadable }

  const declared = new Map(connection.fields.map((f) => [f.key, f]))
  const unknown = Object.keys(body).filter((k) => !declared.has(k))
  if (unknown.length > 0) return { ok: false, code: 'connection_fields_undeclared', fields: unknown.map((k) => keyName(k, 'a field')) }
  const changed: string[] = []
  for (const [key, value] of Object.entries(body)) {
    const f = declared.get(key)!
    if (f.target !== undefined) {
      if (value.trim() !== (values[key] ?? '').trim()) changed.push(key)
      continue
    }
    values[key] = value
  }
  if (changed.length > 0) return { ok: false, code: 'reconnect_target_changed', fields: changed }
  return { ok: true, values }
}

/** An entry of the Google list as a route reads it: its kind, the address or drive id, and a drive's name. */
export type DelegationEntryBody =
  | { ok: true; kind: DelegationKind; subject: string; display_name: string | null }
  | { ok: false; problem: string }

/**
 * The add route's body `{ kind, subject, display_name? }`. Size and type only:
 * whether the text is one mailbox address or one drive id is the ops table's
 * to judge, its one home (L83), and ops answers it by name.
 */
export function readDelegationEntryBody(text: string): DelegationEntryBody {
  const read = readJsonBody(text)
  if (!read.ok) return read
  const extra = onlyKeys(read.raw, ['kind', 'subject', 'display_name'], 'an addition to the list')
  if (extra) return { ok: false, problem: extra }
  const { kind, subject } = read.raw
  const displayName = read.raw.display_name ?? null
  if (typeof kind !== 'string' || !(DELEGATION_KINDS as readonly string[]).includes(kind)) return { ok: false, problem: 'kind is not mailbox or drive' }
  if (typeof subject !== 'string') return { ok: false, problem: 'subject is not text' }
  if (displayName !== null && typeof displayName !== 'string') return { ok: false, problem: 'display_name is not text' }
  return { ok: true, kind: kind as DelegationKind, subject, display_name: displayName }
}
