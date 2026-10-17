import { SealError } from './errors'

/**
 * Canonical JSON, and the binding every sealed login carries as its AAD (#2333).
 *
 * The bidding Worker builds the AAD when it seals and the ops Worker builds it
 * again when it opens, each from its own copy of the connection's fields. The
 * two must produce the same bytes, so the encoding cannot depend on the order a
 * caller happened to write its keys in. Object keys are sorted by UTF-16 code
 * unit (the default sort, the same on every host, unlike a locale sort), arrays
 * keep their order, and strings and numbers are written exactly as
 * JSON.stringify writes them.
 *
 * Anything JSON.stringify would silently drop or coerce (undefined, NaN, a
 * Date, a Map, a hole in an array, a function) is refused instead, because a
 * dropped field is a field the caller believes is bound and is not.
 */

function refuse(path: string, what: string): never {
  throw new SealError('seal_canonical_invalid', `${what} at ${path} has no canonical JSON form`)
}

function encode(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) refuse(path, 'a non finite number')
      return JSON.stringify(value)
    case 'object':
      break
    default:
      refuse(path, `a ${typeof value}`)
  }

  const object = value
  if (ancestors.has(object)) refuse(path, 'a cycle')
  ancestors.add(object)
  try {
    if (Array.isArray(object)) {
      const items: string[] = []
      for (let i = 0; i < object.length; i++) {
        if (!(i in object)) refuse(`${path}[${i}]`, 'a hole in an array')
        items.push(encode((object as unknown[])[i], `${path}[${i}]`, ancestors))
      }
      return `[${items.join(',')}]`
    }
    const proto: unknown = Object.getPrototypeOf(object)
    if (proto !== Object.prototype && proto !== null) refuse(path, 'an object that is not a plain object')
    if (Object.getOwnPropertySymbols(object).length > 0) refuse(path, 'a symbol key')
    const record = object as Record<string, unknown>
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(record[key], `${path}.${key}`, ancestors)}`)
    return `{${members.join(',')}}`
  } finally {
    ancestors.delete(object)
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, '$', new Set())
}

/** A kid names one ops key pair: lower case letters, digits and hyphens. */
export const KID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * What a sealed login is bound to. Opening it under any other organization,
 * connection, service, generation or kid is refused by the cipher itself.
 */
export interface ConnectionAad {
  organization_id: string
  connection_id: string
  service: string
  generation: number
  kid: string
}

const AAD_FIELDS = ['connection_id', 'generation', 'kid', 'organization_id', 'service'] as const

function invalidAad(detail: string): never {
  throw new SealError('seal_aad_invalid', detail)
}

/**
 * The canonical JSON of exactly the five binding fields. A missing or extra
 * field is refused rather than dropped or ignored.
 */
export function canonicalAad(aad: ConnectionAad): string {
  if (typeof aad !== 'object' || aad === null) invalidAad('the binding is not an object')
  const given = Object.keys(aad).sort()
  if (given.join(',') !== AAD_FIELDS.join(',')) {
    invalidAad(`the binding has fields [${given.join(', ')}], and must have exactly [${AAD_FIELDS.join(', ')}]`)
  }
  for (const field of ['organization_id', 'connection_id', 'service'] as const) {
    if (typeof aad[field] !== 'string' || aad[field].length === 0) invalidAad(`${field} must be a non empty string`)
  }
  if (!Number.isSafeInteger(aad.generation) || aad.generation < 1) {
    invalidAad('generation must be a whole number of at least 1')
  }
  if (typeof aad.kid !== 'string' || !KID_PATTERN.test(aad.kid)) invalidAad(`kid must match ${String(KID_PATTERN)}`)
  return canonicalJson({
    organization_id: aad.organization_id,
    connection_id: aad.connection_id,
    service: aad.service,
    generation: aad.generation,
    kid: aad.kid,
  })
}
