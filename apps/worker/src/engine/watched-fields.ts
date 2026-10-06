import {
  chainToStepPath,
  extractStepChains,
  hasDynamicStepsAccess,
  STEP_CHAIN_SOURCE,
  stripComments,
  stripOutputWrapper,
} from '@bidspoke/references'
import type { WorkflowDefinition } from '../types'

// Watched-field derivation (#420). Pulls every `steps.X.Y.Z` output field any
// node reads out of a workflow definition, so the field-presence capture can
// record whether each read field carried a value per execution. Under-derivation
// is the dangerous direction (a missed reference is silently unwatched), so the
// extractor leans toward capturing; over-capture is absorbed by the detector's
// stability gate downstream.

// The chain syntax, the output-wrapper rule and the canonical path form all
// come from the shared parser (#433), so the field this WATCHES is derived by
// the same rule the engine resolver READS by. Re-exported under their long-standing names
// because callers and tests here import them from this module.
export const extractChains = extractStepChains
export const normalizeRefSegments = stripOutputWrapper
export const chainToWatchedField = chainToStepPath

/**
 * Keys whose value is never a reference, so scanning them invents watched fields.
 *
 * `script` is raw code and goes through the bail-open code scanner instead.
 * The rest are PROSE a person wrote about the node. Main Flow's `Mutate BES`
 * carries a `note` explaining a port that was considered and not done, and the
 * path quoted inside that sentence was watched and then paged as a field that
 * never resolves on 25,198 runs (#1118). A sentence about a path is not a read
 * of it, and no executable reference can live in these keys, so skipping them
 * cannot unwatch anything real.
 */
const NON_REFERENCE_KEYS = new Set(['script', 'note', 'label', 'description'])

// Recursively walk any value; for every string, add each chain's canonical
// watched field to `into`. Keys in NON_REFERENCE_KEYS are skipped.
export function collectStructuredRefs(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const chain of extractChains(value)) into.add(chainToWatchedField(chain))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredRefs(item, into)
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (NON_REFERENCE_KEYS.has(k)) continue
      collectStructuredRefs(v, into)
    }
  }
}

// A local standing in for a `steps` chain: `const r = steps.a.b`. Built from
// the shared chain source rather than restating it, so an alias and a literal
// read are recognised by ONE definition of what a reference looks like (#433).
const ALIAS_RE = new RegExp(
  `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(${STEP_CHAIN_SOURCE})`,
  'g',
)

/**
 * Where the declaration STATEMENT ends, which is not where the chain match ends.
 *
 * The chain stops at a bracket, so `const hitCode = steps.a.b?.[0]?.hitCode?.code`
 * matches only as far as `b`, leaving `hitCode?.code` in the same statement to be
 * read as a use of the local being declared. Ending at the terminator covers the
 * whole initialiser, including one wrapped over several lines, which is exactly
 * the shape Main Flow's Calculate Pull Result No Debt is written in.
 *
 * Falls back to the end of the line when there is no semicolon, so a genuine read
 * on the NEXT line is still seen. A comma declaration (`const a = steps.x.y, b =
 * a.z`) has its second read skipped, which under-derives by one field in a shape
 * that does not appear in any live workflow.
 */
function declarationEnd(script: string, chainEnd: number): number {
  const semicolon = script.indexOf(';', chainEnd)
  const newline = script.indexOf('\n', chainEnd)
  if (semicolon !== -1 && (newline === -1 || semicolon < newline)) return semicolon
  if (newline !== -1) return newline
  return script.length
}

interface AliasDeclaration {
  local: string
  /** The path the local stands for, or null when it cannot be named statically. */
  base: string | null
  /** Where the declaration itself sits, so its own text is not read as a use. */
  start: number
  end: number
}

// One accessor after the chain: `[0]`, `?.[0]`, `['ny']`. Only a LITERAL key is
// followed, and a quoted one only when it is a plain name: a watched path is
// dotted, so `['a.b']` would be read back as two keys and never resolve.
// Anything else in the brackets is an index chosen at run time.
const LITERAL_INDEX_RE = /^\s*(?:\?\.\s*)?\[\s*(?:(\d+)|(['"])([A-Za-z_$][\w$]*)\2)\s*\]/
const ANY_INDEX_RE = /^\s*(?:\?\.\s*)?\[/
const MEMBER_RE = /^\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/
// What may follow the accessors while the local still holds the accessed value:
// the end of the statement, a comma declaration, or a fallback (`?? null`,
// `|| {}`), which yields that value whenever there is one to watch.
const SAME_VALUE_END_RE = /^[ \t]*(?:$|[;,\r\n]|\?\?|\|\|)/

/**
 * What the initialiser does after the chain match, which stops at a bracket.
 *
 * `const row = steps.q.output.body.records?.[0]` matches only as far as
 * `records`, so taking the match alone as the alias base watched every `row.Id`
 * as `q.body.records.Id`: a key on an ARRAY, absent on every run however healthy
 * the data (#1799, 0 of 216 runs on the Liberty1 click handler). A literal index
 * is followed instead, giving `q.body.records.0.Id`, which the resolver reads
 * because an array answers to the key "0".
 *
 * Anything that changes the value (a run time index, a method call, a
 * comparison) leaves the local naming something no path describes, so the base
 * is null and the caller reports the reads as a gap rather than guessing.
 */
function aliasTail(script: string, chainEnd: number): { segments: string[] | null; end: number } {
  const segments: string[] = []
  let at = chainEnd
  for (;;) {
    const rest = script.slice(at)
    const index = LITERAL_INDEX_RE.exec(rest)
    if (index) {
      segments.push(index[1] ?? index[3])
      at += index[0].length
      continue
    }
    if (ANY_INDEX_RE.test(rest)) return { segments: null, end: at }
    // The chain itself already took every `.name` before the first bracket, so a
    // member read here can only follow an index.
    const member = segments.length > 0 ? MEMBER_RE.exec(rest) : null
    if (member) {
      segments.push(member[1])
      at += member[0].length
      continue
    }
    return { segments: SAME_VALUE_END_RE.test(rest) ? segments : null, end: at }
  }
}

/** Every `local = <steps chain>` declaration in the script, in source order. */
function aliasDeclarations(script: string): AliasDeclaration[] {
  return [...script.matchAll(ALIAS_RE)].map((m) => {
    const chainEnd = (m.index ?? 0) + m[0].length
    const tail = aliasTail(script, chainEnd)
    const chain = chainToWatchedField(m[2])
    return {
      local: m[1],
      base: tail.segments === null ? null : [chain, ...tail.segments].join('.'),
      start: m.index ?? 0,
      // A wrapped initialiser can carry its index onto the next line, past the
      // end of the line the chain started on, so cover whatever the tail took.
      end: Math.max(declarationEnd(script, chainEnd), tail.end),
    }
  })
}

/**
 * Whether `local` still means the chain it was declared as, everywhere.
 *
 * Refuses on a second declaration (a shadow in another scope, which this
 * line-level scanner cannot tell from a redeclaration) and on any later
 * assignment. Both make the local mean something else somewhere, and attributing
 * its reads to the original path would watch the wrong field, which is worse
 * than not watching it: a field that cannot resolve pages as permanently dead.
 */
function aliasIsStable(script: string, local: string): boolean {
  const declarations = script.match(new RegExp(`\\b(?:const|let|var)\\s+${local}\\s*=`, 'g')) ?? []
  if (declarations.length !== 1) return false
  // Any `local =` that is not the declaration is a reassignment. `==`, `===`
  // and `=>` are excluded so a comparison is not read as one.
  const assignments = script.match(new RegExp(`\\b${local}\\s*=(?![=>])`, 'g')) ?? []
  return assignments.length === 1
}

/**
 * The fields read through `local`, as names for the caller to root at its base.
 *
 * A read followed by `(` is a METHOD CALL, not a field, and is skipped. That
 * matters more than it looks: watching `firstName.trim` would invent a field
 * that can never resolve on any run, and the day-one-dead check would then page
 * about a field that does not exist. Deciding it syntactically rather than from
 * a list of known method names means it holds for methods nobody listed (L217).
 *
 * The declaration's OWN span is skipped for the same reason (#1118). Naming a
 * local after the field it holds is the obvious way to write this, and then the
 * local's name appears inside the path it is being assigned:
 *
 *   const response = steps.return_response.output.response.body
 *
 * Scanning the whole script found `response.body` inside that very line and
 * invented `return_response.response.body.body`, which was paged as never
 * resolving on 4,789 runs while the real path ran at 21,849 of 21,850. Measured
 * with a control: renaming the local made the phantom disappear, so the cause is
 * the name and not the shape of the value.
 */
function aliasFieldReads(script: string, declaration: AliasDeclaration): string[] {
  const { local, start, end } = declaration
  const re = new RegExp(`\\b${local}(?:\\s*\\?\\.\\s*|\\s*\\.\\s*)([A-Za-z_$][\\w$]*)`, 'g')
  const out: string[] = []
  for (const m of script.matchAll(re)) {
    const at = m.index ?? 0
    if (at >= start && at < end) continue
    const after = script.slice(at + m[0].length)
    if (/^\s*\(/.test(after)) continue
    out.push(m[1])
  }
  return out
}

export interface CodeRefResult {
  /** False when the script defeats static analysis entirely and nothing was added. */
  readable: boolean
  /** True when a `steps` alias in this script could not be resolved. */
  aliasGap: boolean
}

/**
 * Scan a code node's script for the output fields it reads.
 *
 * Two passes. Full literal `steps.X.Y.Z` chains, and then one level of alias
 * resolution: a field read only through a local (`const r = steps.a.b; r.final`)
 * is resolved back to `a.b.final` rather than left unwatched. That second pass
 * exists because the first alone left 108 deep fields unwatched across the live
 * workflows, including money-path ones, and the Eligibility Scout read that
 * started this whole detector is written in exactly that shape.
 *
 * Bails open on the same dynamic-access patterns extractReferencedSteps bails
 * on, so a node that cannot be read statically is never given a wrong watch.
 * An alias that cannot be resolved is REPORTED rather than guessed at, so the
 * coverage manifest can say the node may be incomplete.
 */
export function collectCodeRefs(rawScript: string, into: Set<string>): CodeRefResult {
  // Comments are not code, so a path written in one is not a read (#1118). Two
  // migration notes in a single Engine Bidding node were harvested this way and
  // paged as fields that never resolve on 481,959 and 313,171 runs, while the
  // real code beside them read the correct paths. Stripping first also means a
  // commented-out `steps[k]` no longer blinds the whole node.
  const script = stripComments(rawScript)

  if (hasDynamicStepsAccess(script)) return { readable: false, aliasGap: false }
  for (const chain of extractChains(script)) into.add(chainToWatchedField(chain))

  let aliasGap = false
  for (const declaration of aliasDeclarations(script)) {
    if (!aliasIsStable(script, declaration.local)) {
      aliasGap = true
      continue
    }
    const reads = aliasFieldReads(script, declaration)
    // A local that names no path is only a gap when something reads through it.
    if (declaration.base === null) {
      if (reads.length > 0) aliasGap = true
      continue
    }
    for (const field of reads) into.add(`${declaration.base}.${field}`)
  }
  return { readable: true, aliasGap }
}

export type WatchedFieldSource = 'structured' | 'code'

export interface WatchedField {
  path: string
  source: WatchedFieldSource
  /**
   * The namespaces of the nodes that read this field, or null when one of its
   * readers cannot be named (an edge whose source is not a node in the
   * definition).
   */
  readers: string[] | null
  /**
   * The ending steps this field is judged behind, or null when it is judged on
   * every run its producer ran. See ENDING_NODE_TYPES for why only these.
   */
  gate: string[] | null
}

/**
 * Node types that END a run by sending something back, and never route it on.
 *
 * A field read ONLY by such steps is judged only on runs where one of them ran
 * (#1215). Liberty1's refusal reasons are null on every click that is not
 * refused and are read only by the refusal Responses, so judged on every run
 * they paged as never resolving in a week with no refusals.
 *
 * Gating on readers in general is NOT safe, which is why it stops here. Measured
 * on 2026-10-05: Engine Bidding's create_prospect.body.id is read by code nodes
 * that run only when Salesforce returned an id, so gated on them it read 1.00
 * instead of 0.67, and a total collapse would have removed its rows rather than
 * lowered its rate, which pages nothing. An ending step reads a field to report
 * it, not to decide whether the run continues. A field any edge condition reads
 * steers the run and is never gated, even when the edge leaves a Response, and
 * nothing is gated in a workflow holding a script this cannot fully read,
 * because that script may read the field too.
 */
const ENDING_NODE_TYPES = new Set(['response', 'exit'])

export interface WatchedFieldMap {
  fields: WatchedField[]
  /** Nodes whose scripts defeat static analysis, so nothing in them is watched. */
  unreadableNodes: string[]
  /**
   * Nodes that alias a `steps` reference into a local this scanner could not
   * follow. Their watched set may be incomplete, which is a different and
   * milder statement than unreadable, and the coverage manifest shows it so
   * nobody reads a clean list as proof of total coverage.
   */
  aliasOnlyNodes: string[]
}

/**
 * Path prefixes a Constants node's own config already guarantees.
 *
 * A Constants node merges two sources (engine/nodes/constants.ts): the static
 * `config.data` a person typed, and partner copy loaded from the database
 * (`subAccountIdsMap`, `activeBidding`, and the per-partner sell-off and
 * click-url keys). A key written in the config carries a value on every run by
 * construction, so recording its presence measures nothing while costing the
 * daily rollup one expanded row per execution.
 *
 * That cost is not theoretical. #435 took the watched set from 17.5 to 34.0
 * keys per execution, and on 2026-09-03 1,430,834 of the 3,710,468 keys the
 * rollup expanded were `constants.*`. The refresh went from a 5.9s average
 * (14.7s worst) to 12.7s (122.0s worst), and one run crossed the 120s
 * statement timeout.
 *
 * The discriminator is the config VALUE, not the node type. A config key set to
 * null resolves to null on every run, which is a real finding and exactly what
 * the day-one-dead check exists to report, so a null keeps its watch. Only a
 * value that is actually there is dropped, because only that one is provably
 * always present.
 *
 * Database-sourced keys are absent from `config.data` and so are never dropped:
 * a missing sell-off title is a genuine defect the detector should catch.
 */
function guaranteedConstantPrefixes(definition: WorkflowDefinition): string[] {
  const prefixes: string[] = []
  for (const node of definition.nodes) {
    if (node.type !== 'constants') continue
    const data = node.config?.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (value === null || value === undefined) continue
      prefixes.push(`${node.namespace}.${key}`)
    }
  }
  return prefixes
}

/** Whether `path` names a guaranteed constant, or a field inside one. */
function isGuaranteedConstant(path: string, prefixes: string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(`${p}.`))
}

// Full watched-field map with each field's source and the code nodes whose
// scripts could not be statically read (bailed open). Structured references win
// on dedup (higher confidence than a code-scan match). Derived in-engine from the
// running definition, so it always matches the live version (no stored column, no
// drift).
export function deriveWatchedFieldMap(definition: WorkflowDefinition): WatchedFieldMap {
  const structured = new Set<string>()
  const code = new Set<string>()
  // Every node that reads each path. A null entry means some reader of the path
  // could not be named, and it stays null whatever else reads the path.
  const readers = new Map<string, Set<string> | null>()
  const noteReads = (paths: Set<string>, reader: string | null) => {
    for (const path of paths) {
      const known = readers.get(path)
      if (reader === null || known === null) readers.set(path, null)
      else readers.set(path, (known ?? new Set<string>()).add(reader))
    }
  }

  // An edge's condition is evaluated when its SOURCE node finishes, so that is
  // the node whose running means the condition was read.
  const namespaceById = new Map(definition.nodes.map((n) => [n.id, n.namespace]))
  for (const node of definition.nodes) {
    const found = new Set<string>()
    collectStructuredRefs(node, found)
    found.forEach((p) => structured.add(p))
    noteReads(found, node.namespace)
  }
  // A field an edge condition reads steers the run, whatever kind of node the
  // edge leaves from (a Response with continue_after_response can be one), so it
  // is never gated.
  const routed = new Set<string>()
  for (const edge of definition.edges) {
    const found = new Set<string>()
    collectStructuredRefs(edge, found)
    found.forEach((p) => {
      structured.add(p)
      routed.add(p)
    })
    noteReads(found, namespaceById.get(edge.source) ?? null)
  }

  const unreadableNodes: string[] = []
  const aliasOnlyNodes: string[] = []
  for (const node of definition.nodes) {
    const script = node.config?.script
    if (typeof script !== 'string') continue
    const found = new Set<string>()
    const { readable, aliasGap } = collectCodeRefs(script, found)
    found.forEach((p) => code.add(p))
    noteReads(found, node.namespace)
    if (!readable) unreadableNodes.push(node.namespace)
    else if (aliasGap) aliasOnlyNodes.push(node.namespace)
  }
  const readersOf = (path: string): string[] | null => {
    const known = readers.get(path)
    return known ? [...known].sort() : null
  }
  const typeOf = new Map(definition.nodes.map((n) => [n.namespace, n.type as string]))
  // A script this cannot fully read may read any field, so nothing in its
  // workflow can be said to be read only by ending steps.
  const everyReadKnown = unreadableNodes.length === 0 && aliasOnlyNodes.length === 0
  const gateOf = (path: string, named: string[] | null): string[] | null =>
    everyReadKnown &&
    !routed.has(path) &&
    named &&
    named.length > 0 &&
    named.every((ns) => ENDING_NODE_TYPES.has(typeOf.get(ns) ?? ''))
      ? named
      : null

  // Applied to both sources at the point the map is built, so a dropped field
  // is absent from the manifest the coverage page renders as well as from the
  // capture, rather than filtered in one place and not the other.
  const guaranteed = guaranteedConstantPrefixes(definition)

  const fields: WatchedField[] = []
  const seen = new Set<string>()
  for (const path of [...structured].sort()) {
    if (isGuaranteedConstant(path, guaranteed)) continue
    const named = readersOf(path)
    fields.push({ path, source: 'structured', readers: named, gate: gateOf(path, named) })
    seen.add(path)
  }
  for (const path of [...code].sort()) {
    if (seen.has(path)) continue
    if (isGuaranteedConstant(path, guaranteed)) continue
    const named = readersOf(path)
    fields.push({ path, source: 'code', readers: named, gate: gateOf(path, named) })
    seen.add(path)
  }
  return { fields, unreadableNodes, aliasOnlyNodes }
}

// The full watched-field set for a definition: structured references across the
// whole tree (node configs minus their `script`, node variables, edge
// conditions) plus deep field reads from each readable code-node script. A
// projection over deriveWatchedFieldMap so the Phase 0 finalize capture seam is
// byte-for-byte unchanged.
export function deriveWatchedFields(definition: WorkflowDefinition): string[] {
  return deriveWatchedFieldMap(definition)
    .fields.map((f) => f.path)
    .sort()
}
