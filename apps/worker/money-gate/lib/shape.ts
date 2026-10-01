/**
 * The SHAPE of real trigger payloads, never their values (#1704, L222).
 *
 * The money gate's fixtures are synthetic leads built from what real leads look
 * like: which field paths arrive, what class of value each holds, what format a
 * string takes and, for a few fields, the small set of values they range over (a
 * state code, a loan purpose). Nothing else about a real lead may leave this
 * module. The export script reads production payloads through it, and the
 * committed shapes file is everything it writes.
 *
 * A value survives only as a member of an enumerated DOMAIN, and only when every
 * one of these holds:
 *   - the path does not name something about a person (IDENTIFYING_PATH);
 *   - the field takes at most MAX_DOMAIN distinct values across the sample;
 *   - each of those values was seen in at least MIN_DOMAIN_SEEN samples;
 *   - the value is short, carries no digit run and no at sign, and is made of
 *     plain word characters (DOMAIN_VALUE).
 * Numbers never survive at all: only whether they are integers and their order of
 * magnitude, because a credit score or an income is a fact about one person.
 */

export type ValueClass = 'string' | 'integer' | 'number' | 'boolean' | 'null' | 'object' | 'array'

export type StringFormat =
  | 'empty' | 'uuid' | 'email' | 'iso_date' | 'iso_datetime' | 'us_date' | 'ssn_like'
  | 'digits' | 'decimal' | 'url' | 'alpha' | 'alnum' | 'free'

export interface FieldShape {
  /** Samples in which the path was present at all. */
  present: number
  /** Count of samples per value class (one sample can hold several via arrays). */
  classes: Partial<Record<ValueClass, number>>
  string?: { format: StringFormat; min_len: number; max_len: number }
  number?: { integer: boolean; magnitude: number }
  domain?: string[]
}

export interface WorkflowShape {
  workflow_id: string
  workflow_name: string
  sample_count: number
  /** Source names (API key labels) the samples arrived under, by the same domain rule. */
  sources?: string[]
  fields: Record<string, FieldShape>
}

export interface ShapesFile {
  version: 1
  exported_at: string
  workflows: WorkflowShape[]
}

export const MAX_DOMAIN = 12
export const MIN_DOMAIN_SEEN = 3

/** A path naming a person, a contact point, an identifier or an account. Matched per segment. */
export const IDENTIFYING_PATH =
  /(name|email|mail|phone|mobile|ssn|social|tax|tin|dob|birth|address|street|addr|city|zip|postal|ip|uuid|id$|^id|token|account|routing|iban|card|license|passport|employer|url|lat|lng|lon|signature|cert|consent_text)/i

const DOMAIN_VALUE = /^[A-Za-z_][A-Za-z0-9 _\-.,/&()]{0,39}$/
const DIGIT_RUN = /\d{3,}/

export function classify(v: unknown): ValueClass {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  if (typeof v === 'string') return 'string'
  return 'object'
}

export function stringFormat(s: string): StringFormat {
  if (s.length === 0) return 'empty'
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return 'uuid'
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return 'email'
  if (/^\d{3}-?\d{2}-?\d{4}$/.test(s) && s.replace(/-/g, '').length === 9) return 'ssn_like'
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'iso_date'
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return 'iso_datetime'
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return 'us_date'
  if (/^\d+$/.test(s)) return 'digits'
  if (/^-?\d+\.\d+$/.test(s)) return 'decimal'
  if (/^https?:\/\//i.test(s)) return 'url'
  if (/^[A-Za-z]+$/.test(s)) return 'alpha'
  if (/^[A-Za-z0-9]+$/.test(s)) return 'alnum'
  return 'free'
}

function isIdentifyingPath(path: string): boolean {
  return path.split(/[.[\]]+/).filter(Boolean).some((seg) => IDENTIFYING_PATH.test(seg))
}

function isDomainValue(s: string): boolean {
  return DOMAIN_VALUE.test(s) && !DIGIT_RUN.test(s) && !s.includes('@')
}

interface Acc {
  present: number
  classes: Partial<Record<ValueClass, number>>
  formats: Partial<Record<StringFormat, number>>
  minLen: number
  maxLen: number
  allInteger: boolean
  maxAbs: number
  sawNumber: boolean
  /** value -> number of samples it appeared in; dropped (null) once it can no longer be a domain */
  values: Map<string, number> | null
}

function newAcc(): Acc {
  return { present: 0, classes: {}, formats: {}, minLen: Infinity, maxLen: 0, allInteger: true, maxAbs: 0, sawNumber: false, values: new Map() }
}

function walk(v: unknown, path: string, touched: Map<string, Set<ValueClass>>, strings: Map<string, string[]>, numbers: Map<string, number[]>) {
  // JSON cannot carry undefined, so a key holding it is a key that is absent.
  if (v === undefined) return
  const cls = classify(v)
  if (path) {
    if (!touched.has(path)) touched.set(path, new Set())
    touched.get(path)!.add(cls)
  }
  if (cls === 'array') {
    for (const item of v as unknown[]) walk(item, `${path}[]`, touched, strings, numbers)
    return
  }
  if (cls === 'object') {
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) walk(child, path ? `${path}.${k}` : k, touched, strings, numbers)
    return
  }
  if (!path) return
  if (cls === 'string') {
    if (!strings.has(path)) strings.set(path, [])
    strings.get(path)!.push(v as string)
  } else if (cls === 'integer' || cls === 'number') {
    if (!numbers.has(path)) numbers.set(path, [])
    numbers.get(path)!.push(v as number)
  }
}

export function buildWorkflowShape(input: { workflow_id: string; workflow_name: string; payloads: unknown[] }): WorkflowShape {
  const accs = new Map<string, Acc>()
  for (const payload of input.payloads) {
    const touched = new Map<string, Set<ValueClass>>()
    const strings = new Map<string, string[]>()
    const numbers = new Map<string, number[]>()
    walk(payload, '', touched, strings, numbers)
    for (const [path, classes] of touched) {
      if (!accs.has(path)) accs.set(path, newAcc())
      const a = accs.get(path)!
      a.present++
      for (const c of classes) a.classes[c] = (a.classes[c] ?? 0) + 1
    }
    for (const [path, list] of strings) {
      const a = accs.get(path)!
      const distinctInSample = new Set<string>()
      for (const s of list) {
        const f = stringFormat(s)
        a.formats[f] = (a.formats[f] ?? 0) + 1
        a.minLen = Math.min(a.minLen, s.length)
        a.maxLen = Math.max(a.maxLen, s.length)
        distinctInSample.add(s)
      }
      if (a.values) {
        for (const s of distinctInSample) {
          if (!isDomainValue(s)) { a.values = null; break }
          a.values.set(s, (a.values.get(s) ?? 0) + 1)
          if (a.values.size > MAX_DOMAIN) { a.values = null; break }
        }
      }
    }
    for (const [path, list] of numbers) {
      const a = accs.get(path)!
      a.sawNumber = true
      a.values = null
      for (const n of list) {
        if (!Number.isInteger(n)) a.allInteger = false
        a.maxAbs = Math.max(a.maxAbs, Math.abs(n))
      }
    }
  }

  const fields: Record<string, FieldShape> = {}
  for (const path of [...accs.keys()].sort()) {
    const a = accs.get(path)!
    const f: FieldShape = { present: a.present, classes: a.classes }
    const formats = Object.entries(a.formats) as Array<[StringFormat, number]>
    if (formats.length) {
      formats.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      f.string = { format: formats[0][0], min_len: a.minLen, max_len: a.maxLen }
    }
    if (a.sawNumber) {
      f.number = { integer: a.allInteger, magnitude: a.maxAbs > 0 ? Math.floor(Math.log10(a.maxAbs)) : 0 }
    }
    if (a.values && a.values.size > 0 && !isIdentifyingPath(path) && [...a.values.values()].every((n) => n >= MIN_DOMAIN_SEEN)) {
      f.domain = [...a.values.keys()].sort()
    }
    fields[path] = f
  }
  return { workflow_id: input.workflow_id, workflow_name: input.workflow_name, sample_count: input.payloads.length, fields }
}

export function renderShapesFile(file: ShapesFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

/** The only thing the export prints: names and counts, never a field's content. */
export function summarizeShapes(file: ShapesFile): string {
  return file.workflows
    .map((w) => {
      const paths = Object.keys(w.fields).length
      const domains = Object.values(w.fields).filter((f) => f.domain).length
      return `${w.workflow_name}: ${w.sample_count} samples, ${paths} field paths, ${domains} enumerated domains`
    })
    .join('\n')
}
