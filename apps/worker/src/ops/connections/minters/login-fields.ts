/**
 * Reading an opened login and a declared target (#2335, PR 4 of phase 5). A
 * login is a JSON object sealed by the bidding Worker; a field it lacks makes
 * it unusable as stored, which only a person can fix (refused, so needs_reauth
 * at once). A target is the connection's public declaration; a field it lacks
 * is refused by rule (not_allowed, target_invalid), since the login is not at
 * fault. Neither error carries a value, only the kind and reason.
 */
import { LoginMintError } from '../refusals'
import type { OpenedLogin } from '../service-rules'

type Fields = Readonly<Record<string, unknown>>

function asObject(value: unknown): Fields | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : null
}

/** The login's fields. A login that is not a JSON object is malformed. */
export function loginFields(login: OpenedLogin): Fields {
  let parsed: unknown
  try {
    parsed = JSON.parse(login.plaintext)
  } catch {
    throw new LoginMintError('refused', 'login_malformed')
  }
  const fields = asObject(parsed)
  if (fields === null) throw new LoginMintError('refused', 'login_malformed')
  return fields
}

/** A non empty string field of the login. */
export function loginString(fields: Fields, name: string): string {
  const value = Object.hasOwn(fields, name) ? fields[name] : undefined
  if (typeof value !== 'string' || value.trim() === '') throw new LoginMintError('refused', 'login_malformed')
  return value
}

/** The target's fields. A target that is not an object is invalid. */
export function targetFields(target: unknown): Fields {
  const fields = asObject(target)
  if (fields === null) throw new LoginMintError('not_allowed', 'target_invalid')
  return fields
}

/** A non empty string field of the target. */
export function targetString(fields: Fields, name: string): string {
  const value = Object.hasOwn(fields, name) ? fields[name] : undefined
  if (typeof value !== 'string' || value.trim() === '') throw new LoginMintError('not_allowed', 'target_invalid')
  return value
}
