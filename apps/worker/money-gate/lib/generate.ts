/**
 * Builds a synthetic trigger payload from a workflow's SHAPE (#1704).
 *
 * Every value is invented from the field's class and format, never copied from a
 * real lead: the shape carries no values except small enumerated domains, so there
 * is nothing else to copy. Each invented value comes from a range no real one can
 * occupy (an SSN area the SSA never issues, a first of January birth date, an
 * example.com mailbox, an account number of zeros), which is what lets the fixture
 * scanner accuse everything else.
 *
 * A variant steers a payload towards an arm by path: `set` writes a value (creating
 * the path if the shape lacks it) and `unset` removes one. Identifiers are derived
 * from the seed, so two fixtures never share an idempotency key.
 */
import type { FieldShape, ValueClass, WorkflowShape } from './shape'

export interface GenerateOptions {
  seed: string
  set?: Record<string, unknown>
  unset?: string[]
  /** Paths present in at least this share of samples are generated. Default 0.5. */
  minPresence?: number
}

/** FNV-1a, 32 bit: a stable hash with no dependency, enough to vary synthetic ids. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

function hex(seed: string, n: number): string {
  let out = ''
  let i = 0
  while (out.length < n) out += fnv1a(`${seed}:${i++}`).toString(16).padStart(8, '0')
  return out.slice(0, n)
}

/** Digits drawn from the seed, never starting with anything but 9. */
function digits(seed: string, n: number): string {
  let out = '9'
  let i = 0
  while (out.length < n) out += String(fnv1a(`${seed}:d${i++}`) % 10)
  return out.slice(0, Math.max(n, 1))
}

const DOB_PATH = /(dob|birth)/i
const ACCOUNT_PATH = /(account|routing|iban|aba)/i

function lastSegment(path: string): string {
  return path.split(/[.[\]]+/).filter(Boolean).pop() ?? ''
}

function dominantClass(f: FieldShape): ValueClass {
  const entries = Object.entries(f.classes) as Array<[ValueClass, number]>
  // Containers win over leaves only when they dominate; null loses ties.
  entries.sort((a, b) => b[1] - a[1] || (a[0] === 'null' ? 1 : b[0] === 'null' ? -1 : a[0] < b[0] ? -1 : 1))
  const first = entries[0]?.[0] ?? 'null'
  if (first === 'null' && entries.length > 1) return entries[1][0]
  return first
}

function synthString(path: string, f: FieldShape, seed: string): string {
  if (f.domain && f.domain.length) return f.domain[fnv1a(`${seed}:${path}`) % f.domain.length]
  const fmt = f.string?.format ?? 'free'
  const s = `${seed}:${path}`
  const seg = lastSegment(path)
  const len = f.string?.max_len ?? 8
  switch (fmt) {
    case 'empty': return ''
    case 'uuid': {
      const h = hex(s, 32)
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
    }
    case 'email': return `synthetic.${hex(s, 8)}@example.com`
    case 'ssn_like': {
      const d = digits(s, 9)
      return len >= 11 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : d
    }
    case 'iso_date': return DOB_PATH.test(seg) ? '1980-01-01' : '2026-09-30'
    case 'iso_datetime': return DOB_PATH.test(seg) ? '1980-01-01T00:00:00.000Z' : '2026-10-01T15:00:00.000Z'
    case 'us_date': return DOB_PATH.test(seg) ? '01/01/1980' : '09/30/2026'
    case 'digits': return ACCOUNT_PATH.test(seg) ? '0'.repeat(Math.max(len, 6)) : digits(s, Math.max(len, 1))
    case 'decimal': return '1000.00'
    case 'url': return `https://example.com/${hex(s, 6)}`
    case 'alpha': return `Synth${'x'.repeat(Math.max(0, Math.min(len, 12) - 5))}`.slice(0, Math.max(len, 1))
    case 'alnum': return `S${hex(s, Math.max(1, Math.min(len, 64) - 1))}`
    default: return `synthetic ${hex(s, 6)}`
  }
}

function synthLeaf(path: string, f: FieldShape, seed: string): unknown {
  const cls = dominantClass(f)
  switch (cls) {
    case 'string': return synthString(path, f, seed)
    case 'integer': return 5 * 10 ** (f.number?.magnitude ?? 0)
    case 'number': return 5 * 10 ** (f.number?.magnitude ?? 0) + 0.5
    case 'boolean': return false
    case 'array': return []
    case 'object': return {}
    default: return null
  }
}

type Seg = { key: string; array: boolean }

function parsePath(path: string): Seg[] {
  return path.split('.').map((p) => (p.endsWith('[]') ? { key: p.slice(0, -2), array: true } : { key: p, array: false }))
}

function setAt(root: Record<string, unknown>, path: string, value: unknown): void {
  const segs = parsePath(path)
  let cur: Record<string, unknown> = root
  for (let i = 0; i < segs.length; i++) {
    const { key, array } = segs[i]
    const last = i === segs.length - 1
    if (array) {
      if (!Array.isArray(cur[key])) cur[key] = []
      const arr = cur[key] as unknown[]
      if (last) { if (Array.isArray(value)) cur[key] = value; else arr[0] = value; return }
      if (!arr[0] || typeof arr[0] !== 'object') arr[0] = {}
      cur = arr[0] as Record<string, unknown>
    } else {
      if (last) { cur[key] = value; return }
      if (!cur[key] || typeof cur[key] !== 'object' || Array.isArray(cur[key])) cur[key] = {}
      cur = cur[key] as Record<string, unknown>
    }
  }
}

function unsetAt(root: Record<string, unknown>, path: string): void {
  const segs = parsePath(path)
  let cur: unknown = root
  for (let i = 0; i < segs.length - 1; i++) {
    const { key, array } = segs[i]
    cur = (cur as Record<string, unknown>)?.[key]
    if (array) cur = (cur as unknown[])?.[0]
    if (!cur || typeof cur !== 'object') return
  }
  delete (cur as Record<string, unknown>)[segs[segs.length - 1].key]
}

export function generatePayload(shape: WorkflowShape, opts: GenerateOptions): unknown {
  const min = opts.minPresence ?? 0.5
  const root: Record<string, unknown> = {}
  const paths = Object.keys(shape.fields).sort()
  const kept = paths.filter((p) => shape.fields[p].present >= shape.sample_count * min)
  // Leaves only: a container path is created by its children, and an empty
  // container is kept only when it has none.
  for (const p of kept) {
    const f = shape.fields[p]
    const cls = dominantClass(f)
    const hasChild = kept.some((q) => q !== p && (q.startsWith(`${p}.`) || q.startsWith(`${p}[]`)))
    if ((cls === 'object' || cls === 'array') && hasChild) continue
    setAt(root, p, synthLeaf(p, f, opts.seed))
  }
  for (const [p, v] of Object.entries(opts.set ?? {})) setAt(root, p, v)
  for (const p of opts.unset ?? []) unsetAt(root, p)
  return root
}
