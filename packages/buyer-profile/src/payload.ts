import type { PayloadNormaliser } from './vocab'

/**
 * The wire body a sale sends, built from config rather than a code node: a whole
 * object template as the base, a list of target path and source template pairs,
 * and a list of path and normaliser pairs. The node resolves this only after the
 * sell-off decision passes, so the 90 percent of leads that are not sell-off pay
 * nothing for it.
 */
export interface SalePayloadSpec {
  /** A template that resolves to the base object, for example `{{trigger.payload}}`. */
  base: string
  set: ReadonlyArray<{ path: string; template: string }>
  normalise: ReadonlyArray<{ path: string; normaliser: PayloadNormaliser }>
}

export class SalePayloadError extends Error {
  readonly code: 'sale_payload_not_object' | 'sale_payload_field_unresolved'
  constructor(code: SalePayloadError['code'], detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'SalePayloadError'
    this.code = code
  }
}

type Resolve = (template: string) => unknown

const NORMALISERS: Record<PayloadNormaliser, (value: unknown) => unknown> = {
  // Matches the live script: String(x || '').replace(/\D/g, '').slice(0, 9)
  ssn_digits_9: (value) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '').replace(/\D/g, '').slice(0, 9),
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean)
  let cur = target
  for (const part of parts.slice(0, -1)) {
    const next = cur[part]
    if (!isPlainObject(next)) {
      const fresh: Record<string, unknown> = {}
      cur[part] = fresh
      cur = fresh
    } else {
      cur = next
    }
  }
  cur[parts[parts.length - 1]] = value
}

function getPath(target: Record<string, unknown>, path: string): unknown {
  let cur: unknown = target
  for (const part of path.split('.').filter(Boolean)) {
    if (!isPlainObject(cur)) return undefined
    cur = cur[part]
  }
  return cur
}

/**
 * Builds the body. The base is deep copied so the trigger payload the rest of the
 * workflow reads is never mutated. A base that is not a non empty object, or a
 * set entry that resolves to undefined, is a named failure before any claim
 * (L505): a hole in the body is never sent.
 */
export function buildSalePayload(spec: SalePayloadSpec, resolve: Resolve): Record<string, unknown> {
  const base = resolve(spec.base)
  if (!isPlainObject(base) || Object.keys(base).length === 0) {
    throw new SalePayloadError('sale_payload_not_object', `base template ${spec.base} did not resolve to a non empty object`)
  }
  const body = structuredClone(base)
  for (const entry of spec.set) {
    const value = resolve(entry.template)
    if (value === undefined) {
      throw new SalePayloadError('sale_payload_field_unresolved', `${entry.path} from ${entry.template} resolved to undefined`)
    }
    setPath(body, entry.path, value)
  }
  for (const entry of spec.normalise) {
    setPath(body, entry.path, NORMALISERS[entry.normaliser](getPath(body, entry.path)))
  }
  return body
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalise(value[key])
    return out
  }
  return value
}

/** SHA-256 hex of the body with object keys sorted at every level, so two builders of one body agree. */
export async function canonicalBodySha256(body: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalise(body)))
  // Web Crypto is a global in Workers, browsers and Node 20 plus; the cast keeps
  // both the DOM lib and the workers types happy about its declaration.
  const webCrypto = (globalThis as unknown as { crypto: Crypto }).crypto
  const digest = await webCrypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
