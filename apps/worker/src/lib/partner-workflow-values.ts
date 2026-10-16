/**
 * Which workflows read a partner's values from the Constants node (#2142, PM-15).
 *
 * The one scanner and matcher: the partners page's workflow values tab
 * (`GET /api/partners/:id/workflow-values`) calls it, and so does the delete
 * check (#2140, lib/partner-delete.ts), to list the workflows that will read
 * nothing for a partner after it is deleted, rather than keep a copy.
 *
 * The names searched for come from the function that builds them
 * (`partnerConstantName` in engine/nodes/constants.ts, L564): a test fails when
 * the executor emits a partner key this scanner does not search for.
 *
 * What counts as a read is what Code nodes and templates actually write (L41),
 * measured from the Engine Bidding mirror and the live definitions: a value is
 * read only through an access to the Constants node's output, never as a bare
 * word, so a local `pt.sellOff` cannot match:
 *
 *   - `steps.<constants namespace>.output.<key>` (with `?.` anywhere), in a
 *     template or a script;
 *   - `constants.<key>` or `constants['<key>']`, and the same through any local
 *     name a script assigns the output to (`const c = steps.constants.output`);
 *   - a destructure from the output or from such a name (`const { <key> } = constants`).
 *
 * For the two maps holding every partner's entry (`activeBidding` keyed by slug,
 * `subAccountIdsMap` keyed by sub-account id), a literal entry
 * (`activeBidding.tripoint`, `subAccountIdsMap['<id>']`) is a read of that one
 * partner's entry, and anything else (`activeBidding[sourceName]`,
 * `Object.keys(constants.subAccountIdsMap)`, the map passed on whole, or handed
 * to a local name, `const m = constants.subAccountIdsMap`, whose later entries
 * are not followed) reads the value for every partner. An entry is followed to
 * the end of its expression, however much space sits before it. Reading the
 * whole output by a computed name (`constants[name]`, `Object.keys(constants)`,
 * a spread) is reported on every value, as every partner.
 *
 * The scan errs toward reporting a reader (L648): a commented out access still
 * counts, because missing a reader would let a delete break a workflow while
 * an extra one only asks a person to look. What it cannot see is a value
 * reached after the output is handed to a function by name, or through a
 * bracketed `steps['<namespace>']`; neither appears in any definition read on
 * 2026-10-15.
 *
 * Only workflows that carry a Constants node can read one. Inactive workflows
 * are scanned like active ones and reported with `is_active`, because switching
 * one on makes it read the value again.
 */
import { PARTNER_CONSTANT_KINDS, PARTNER_CONSTANT_MAPS, partnerConstantName } from '../engine/nodes/constants'
import type { PartnerValueName, PartnerValueReaders, ReadHow, ReadingPlace } from './workflow-values-shape'

export type { PartnerValueKind, PartnerValueName, PartnerValueReaders, ReadHow, ReadingPlace, ReadingWorkflow, ShadowedDataKey } from './workflow-values-shape'
export { CLICK_URL_READERS_OUTSIDE_WORKFLOWS } from './workflow-values-shape'

export interface ScannableWorkflow {
  id: string
  name: string
  is_active: boolean
  definition: unknown
}

export interface ScanPartner {
  slug: string
  /** The partner's sub-account ids, its entries in `subAccountIdsMap`. */
  subAccountIds: readonly string[]
}

/** The namespace templates and Code nodes name the Constants node by in every live definition. */
const CONSTANTS_NAMESPACE = 'constants'

const IDENT = /^[A-Za-z_$][\w$]*$/
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A property step: `.` or `?.`, with any spacing. */
const DOT = String.raw`\s*\??\.\s*`
/**
 * Not the tail of a longer name, and not a property of something else
 * (`pt.constants`, `steps.constants`), while a spread (`...constants`) is allowed.
 */
const NOT_A_PROPERTY = String.raw`(?<![\w$])(?<!(?<!\.\.)\.)`

function accessOf(key: string): { template: string; code: string } {
  const prop = IDENT.test(key) ? `.${key}` : `['${key}']`
  return { template: `steps.${CONSTANTS_NAMESPACE}.output${prop}`, code: `constants${prop}` }
}

/** Every value the Constants node can emit for this partner, in the order the page shows them. */
export function partnerValueNames(slug: string): PartnerValueName[] {
  const flat = PARTNER_CONSTANT_KINDS.map((kind) => {
    const key = partnerConstantName(slug, kind)
    return { constant_name: key, kind, map: false, access: accessOf(key) }
  })
  const maps = PARTNER_CONSTANT_MAPS.map((kind) => ({ constant_name: kind, kind, map: true, access: accessOf(kind) }))
  return [...flat, ...maps]
}

// ── Reading the definition ────────────────────────────────────────────────────

type DefNode = { id?: unknown; namespace?: unknown; label?: unknown; type?: unknown; config?: unknown; variables?: unknown }
type DefEdge = { id?: unknown; condition?: unknown }

interface TextPlace {
  place: Omit<ReadingPlace, 'reads'>
  text: string
}

function stringsIn(value: unknown, out: string[], skipKey?: string): void {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (k !== skipKey) stringsIn(v, out)
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function definitionOf(w: ScannableWorkflow): { nodes: DefNode[]; edges: DefEdge[] } {
  const def = w.definition as { nodes?: unknown; edges?: unknown } | null | undefined
  return {
    nodes: Array.isArray(def?.nodes) ? (def.nodes as DefNode[]).filter((n) => n && typeof n === 'object') : [],
    edges: Array.isArray(def?.edges) ? (def.edges as DefEdge[]).filter((e) => e && typeof e === 'object') : [],
  }
}

const constantsNodesOf = (nodes: DefNode[]): DefNode[] => nodes.filter((n) => n.type === 'constants')

/** Whether a workflow carries a Constants node, the only workflows the scan can find a reader in. */
export function carriesConstantsNode(w: ScannableWorkflow): boolean {
  return constantsNodesOf(definitionOf(w).nodes).length > 0
}

/** Every place in a definition that can read the Constants output, with its text. The Constants node's own data is not a read. */
function textPlaces(nodes: DefNode[], edges: DefEdge[]): TextPlace[] {
  const out: TextPlace[] = []
  for (const n of nodes) {
    const texts: string[] = []
    stringsIn(n.config, texts, n.type === 'constants' ? 'data' : undefined)
    stringsIn(n.variables, texts)
    if (texts.length === 0) continue
    out.push({
      place: { node_id: str(n.id), namespace: str(n.namespace), label: str(n.label), node_type: str(n.type), edge_id: null },
      text: texts.join('\n'),
    })
  }
  for (const e of edges) {
    const texts: string[] = []
    stringsIn(e.condition, texts)
    if (texts.length === 0) continue
    out.push({ place: { node_id: null, namespace: null, label: null, node_type: null, edge_id: str(e.id) }, text: texts.join('\n') })
  }
  return out
}

// ── Matching ──────────────────────────────────────────────────────────────────

/** How a text reaches the Constants output: the `steps.<ns>.output` paths and the local names standing for it. */
function rootPattern(text: string, namespaces: readonly string[]): string {
  const nsRoot = String.raw`${NOT_A_PROPERTY}steps${DOT}(?:${namespaces.map(esc).join('|')})${DOT}output(?![\w$])`
  const names = new Set<string>(['constants'])
  const alias = new RegExp(String.raw`(?:\b(?:const|let|var)\s+|,\s*)([A-Za-z_$][\w$]*)\s*=\s*${nsRoot}\s*(?:\?\?\s*\{\s*\}\s*)?(?=[;,]|\/[/*]|\r?\n|$)`, 'g')
  for (const m of text.matchAll(alias)) names.add(m[1])
  const nameRoot = String.raw`${NOT_A_PROPERTY}(?:${[...names].map(esc).join('|')})(?![\w$])`
  return `(?:${nsRoot}|${nameRoot})`
}

/** Whether the text reads the whole output at once: by a computed name, enumerated, spread or serialised. */
function readsWholeOutput(text: string, root: string): boolean {
  const element = new RegExp(String.raw`${root}\s*(?:\?\.)?\s*(?=\[)`, 'g')
  for (const m of text.matchAll(element)) {
    if (!literalElement(text.slice((m.index ?? 0) + m[0].length))) return true
  }
  const whole = new RegExp(String.raw`(?:Object${DOT}(?:keys|values|entries|assign)\s*\(\s*(?:\{\s*\}\s*,\s*)?|JSON${DOT}stringify\s*\(\s*|\.\.\.\s*)${root}(?!\s*(?:\??\.|\[))`)
  if (whole.test(text)) return true
  return destructuresFrom(text, root).some((names) => names.includes(REST))
}

/** A destructure's `...rest`, which takes every key not named before it. */
const REST = '...'

/**
 * The top level property names of every object destructure whose source is the
 * output (`const { a, b: x, c = {}, ...rest } = constants`), with REST for a
 * rest element. The pattern is walked by bracket depth, not matched by a
 * regex, so a nested default or pattern (`{ a = {}, b: { c } }`) is read whole.
 */
function destructuresFrom(text: string, root: string): string[][] {
  const out: string[][] = []
  const source = new RegExp(String.raw`^\s*=\s*${root}(?!\s*(?:\??\.|\[))`)
  for (const m of text.matchAll(/(?:const|let|var)\s*\{/g)) {
    const open = (m.index ?? 0) + m[0].length - 1
    const close = matchingBrace(text, open)
    if (close === null || !source.test(text.slice(close + 1))) continue
    out.push(
      topLevelParts(text.slice(open + 1, close)).map((part) => {
        const trimmed = part.trim()
        return trimmed.startsWith(REST) ? REST : trimmed.split(/[:=]/)[0].trim().replace(/^['"]|['"]$/g, '')
      })
    )
  }
  return out
}

/** The index of the brace closing the one at `open`, skipping string literals, or null if it never closes. */
function matchingBrace(text: string, open: number): number | null {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = text.indexOf(ch, i + 1)
      if (end < 0) return null
      i = end
    } else if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--
      if (depth === 0) return ch === '}' ? i : null
    }
  }
  return null
}

/** The comma separated parts of a pattern, splitting only at its own level. */
function topLevelParts(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(start, i))
      start = i + 1
    }
  }
  parts.push(inner.slice(start))
  return parts.filter((p) => p.trim() !== '')
}

/** A literal element access at the start of `rest` (`['x']`, `["x"]`, `` [`x`] `` with no substitution), and its name. */
function literalElement(rest: string): string | null {
  const m = /^\[\s*(?:'([^'\\]*)'|"([^"\\]*)"|`([^`\\$]*)`)\s*\]/.exec(rest)
  return m ? (m[1] ?? m[2] ?? m[3]) : null
}

/** The entry a map read goes on to, when it names one literally; null when it reads the map whole or by a computed key. */
function literalEntry(rest: string): string | null {
  const dot = /^\s*\??\.\s*([A-Za-z_$][\w$]*)(?![\w$])(?!\s*\()/.exec(rest)
  if (dot) return dot[1]
  const el = /^\s*(?:\?\.)?\s*(?=\[)/.exec(rest)
  return el ? literalElement(rest.slice(el[0].length)) : null
}

interface KeyRead {
  /** The text following the access, for a map's entry. Null for a destructure, which reads the map whole. */
  rest: string | null
}

/** Every read of `key` from the output in the text. */
function readsOfKey(text: string, root: string, key: string): KeyRead[] {
  const out: KeyRead[] = []
  const patterns: RegExp[] = [new RegExp(String.raw`${root}\s*(?:\?\.)?\s*\[\s*(?:'${esc(key)}'|"${esc(key)}"|\`${esc(key)}\`)\s*\]`, 'g')]
  if (IDENT.test(key)) patterns.push(new RegExp(String.raw`${root}${DOT}${esc(key)}(?![\w$])`, 'g'))
  for (const p of patterns) {
    for (const m of text.matchAll(p)) out.push({ rest: text.slice((m.index ?? 0) + m[0].length) })
  }
  for (const named of destructuresFrom(text, root)) if (named.includes(key)) out.push({ rest: null })
  return out
}

/**
 * Whether the text reads this value, and how: by name (this partner's flat
 * value, or its literal entry in a map), for every partner (the map whole or by
 * a computed entry, or the whole output), or not at all.
 */
function howTextReads(text: string, root: string, value: PartnerValueName, partner: ScanPartner, wholeOutput: boolean): ReadHow | null {
  let how: ReadHow | null = wholeOutput ? 'every_partner' : null
  for (const read of readsOfKey(text, root, value.constant_name)) {
    if (!value.map) return 'by_name'
    const entry = read.rest === null ? null : literalEntry(read.rest)
    if (entry === null) how = 'every_partner'
    else if (value.kind === 'activeBidding' ? entry === partner.slug : partner.subAccountIds.includes(entry)) return 'by_name'
  }
  return how
}

/**
 * Every value the Constants node can emit for this partner, with the workflows
 * that read it and any workflow data key it shadows. Pure: the caller reads the
 * workflows (readOrgWorkflows) and the partner, and turns a failed read into a
 * failed answer, never an empty one.
 */
export function scanPartnerValueReaders(workflows: readonly ScannableWorkflow[], partner: ScanPartner): PartnerValueReaders[] {
  const values = partnerValueNames(partner.slug)
  const result: PartnerValueReaders[] = values.map((v) => ({ ...v, readers: [], shadowed_data_keys: [] }))

  for (const w of workflows) {
    const { nodes, edges } = definitionOf(w)
    const constantsNodes = constantsNodesOf(nodes)
    if (constantsNodes.length === 0) continue
    const namespaces = constantsNodes.map((n) => str(n.namespace)).filter((ns): ns is string => ns !== null && ns !== '')

    for (const cn of constantsNodes) {
      const config = cn.config as { data?: unknown } | null | undefined
      const data = config?.data && typeof config.data === 'object' ? (config.data as Record<string, unknown>) : {}
      for (const r of result) {
        if (Object.prototype.hasOwnProperty.call(data, r.constant_name)) {
          r.shadowed_data_keys.push({ workflow_id: w.id, workflow_name: w.name, is_active: w.is_active, node_id: str(cn.id) ?? '', namespace: str(cn.namespace) ?? '' })
        }
      }
    }

    const places = textPlaces(nodes, edges).map((tp) => {
      const root = rootPattern(tp.text, namespaces.length > 0 ? namespaces : [CONSTANTS_NAMESPACE])
      return { ...tp, root, wholeOutput: readsWholeOutput(tp.text, root) }
    })
    for (const r of result) {
      const found: ReadingPlace[] = []
      for (const p of places) {
        const how = howTextReads(p.text, p.root, r, partner, p.wholeOutput)
        if (how) found.push({ ...p.place, reads: how })
      }
      if (found.length === 0) continue
      r.readers.push({
        workflow_id: w.id,
        workflow_name: w.name,
        is_active: w.is_active,
        reads: found.some((f) => f.reads === 'by_name') ? 'by_name' : 'every_partner',
        places: found,
      })
    }
  }
  return result
}
