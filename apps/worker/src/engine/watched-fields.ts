import { hasDynamicStepsAccess } from './nodes/code'
import type { WorkflowDefinition } from '../types'

// Watched-field derivation (#420). Pulls every `steps.X.Y.Z` output field any
// node reads out of a workflow definition, so the field-presence capture can
// record whether each read field carried a value per execution. Under-derivation
// is the dangerous direction (a missed reference is silently unwatched), so the
// extractor leans toward capturing; over-capture is absorbed by the detector's
// stability gate downstream.

// A `steps...` reference chain: `steps` (not part of a larger identifier) then
// one or more `.ident` / `?.ident` segments. Whitespace around separators is
// tolerated to match the existing code scanner. A bracket ends the chain, so
// `steps.x.list[0]` yields `steps.x.list`.
const CHAIN_RE =
  /(?<![\w$])steps(?:\s*\?\.\s*|\s*\.\s*)[A-Za-z_$][\w$]*(?:(?:\s*\?\.\s*|\s*\.\s*)[A-Za-z_$][\w$]*)*/g

export function extractChains(text: string): string[] {
  return [...text.matchAll(CHAIN_RE)].map((m) => m[0])
}

// Segments AFTER the `steps` root. Drops a leading output wrapper segment
// (`output` or the Pipedream-legacy `$return_value`) so `x.output.y`,
// `x.$return_value.y`, and `x.y` all normalize to `x.y`.
export function normalizeRefSegments(segments: string[]): string[] {
  if (segments[1] === 'output' || segments[1] === '$return_value') {
    return [segments[0], ...segments.slice(2)]
  }
  return segments
}

export function chainToWatchedField(chain: string): string {
  const parts = chain.replace(/\s+/g, '').replace(/\?\./g, '.').split('.')
  // parts[0] is the literal "steps" root.
  return normalizeRefSegments(parts.slice(1)).join('.')
}

// Recursively walk any value; for every string, add each chain's canonical
// watched field to `into`. Object keys named `script` are skipped (those are raw
// code and go through the bail-open code scanner instead of the structured path).
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
      if (k === 'script') continue
      collectStructuredRefs(v, into)
    }
  }
}

// A local standing in for a `steps` chain: `const r = steps.a.b`. The chain
// itself reuses the same shape CHAIN_RE matches, so an alias and a literal read
// are recognised by one definition of what a reference looks like.
const ALIAS_RE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*((?<![\w$])steps(?:\s*\?\.\s*|\s*\.\s*)[A-Za-z_$][\w$]*(?:(?:\s*\?\.\s*|\s*\.\s*)[A-Za-z_$][\w$]*)*)/g

/** Every `local = <steps chain>` declaration in the script, in source order. */
function aliasDeclarations(script: string): { local: string; base: string }[] {
  return [...script.matchAll(ALIAS_RE)].map((m) => ({
    local: m[1],
    base: chainToWatchedField(m[2]),
  }))
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
 * Field reads through `local`, as full paths rooted at `base`.
 *
 * A read followed by `(` is a METHOD CALL, not a field, and is skipped. That
 * matters more than it looks: watching `firstName.trim` would invent a field
 * that can never resolve on any run, and the day-one-dead check would then page
 * about a field that does not exist. Deciding it syntactically rather than from
 * a list of known method names means it holds for methods nobody listed (L217).
 */
function aliasFieldReads(script: string, local: string, base: string): string[] {
  const re = new RegExp(`\\b${local}(?:\\s*\\?\\.\\s*|\\s*\\.\\s*)([A-Za-z_$][\\w$]*)`, 'g')
  const out: string[] = []
  for (const m of script.matchAll(re)) {
    const after = script.slice(m.index + m[0].length)
    if (/^\s*\(/.test(after)) continue
    out.push(`${base}.${m[1]}`)
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
export function collectCodeRefs(script: string, into: Set<string>): CodeRefResult {
  if (hasDynamicStepsAccess(script)) return { readable: false, aliasGap: false }
  for (const chain of extractChains(script)) into.add(chainToWatchedField(chain))

  let aliasGap = false
  for (const { local, base } of aliasDeclarations(script)) {
    if (!aliasIsStable(script, local)) {
      aliasGap = true
      continue
    }
    for (const path of aliasFieldReads(script, local, base)) into.add(path)
  }
  return { readable: true, aliasGap }
}

export type WatchedFieldSource = 'structured' | 'code'

export interface WatchedField {
  path: string
  source: WatchedFieldSource
}

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

// Full watched-field map with each field's source and the code nodes whose
// scripts could not be statically read (bailed open). Structured references win
// on dedup (higher confidence than a code-scan match). Derived in-engine from the
// running definition, so it always matches the live version (no stored column, no
// drift).
export function deriveWatchedFieldMap(definition: WorkflowDefinition): WatchedFieldMap {
  const structured = new Set<string>()
  collectStructuredRefs(definition.nodes, structured)
  collectStructuredRefs(definition.edges, structured)

  const code = new Set<string>()
  const unreadableNodes: string[] = []
  const aliasOnlyNodes: string[] = []
  for (const node of definition.nodes) {
    const script = node.config?.script
    if (typeof script !== 'string') continue
    const { readable, aliasGap } = collectCodeRefs(script, code)
    if (!readable) unreadableNodes.push(node.namespace)
    else if (aliasGap) aliasOnlyNodes.push(node.namespace)
  }

  const fields: WatchedField[] = []
  const seen = new Set<string>()
  for (const path of [...structured].sort()) {
    fields.push({ path, source: 'structured' })
    seen.add(path)
  }
  for (const path of [...code].sort()) {
    if (seen.has(path)) continue
    fields.push({ path, source: 'code' })
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
