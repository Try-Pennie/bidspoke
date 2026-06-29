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
  const out: string[] = []
  let m: RegExpExecArray | null
  CHAIN_RE.lastIndex = 0
  while ((m = CHAIN_RE.exec(text)) !== null) {
    out.push(m[0])
  }
  return out
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

// Scan a code node's script for full literal `steps.X.Y.Z` field reads. Bails
// open (returns false, adds nothing) on the same dynamic-access patterns
// extractReferencedSteps bails on, so a node we cannot statically read is never
// given a wrong watch. A field read ONLY through a renamed local and never once
// as a full literal is missed by design (scan, not instrument); see the spec.
export function collectCodeRefs(script: string, into: Set<string>): boolean {
  if (hasDynamicStepsAccess(script)) return false
  for (const chain of extractChains(script)) into.add(chainToWatchedField(chain))
  return true
}

// The full watched-field set for a definition: structured references across the
// whole tree (node configs minus their `script`, node variables, edge
// conditions) plus deep field reads from each readable code-node script. Derived
// in-engine from the running definition, so it always matches the live version
// (no stored column, no drift).
export function deriveWatchedFields(definition: WorkflowDefinition): string[] {
  const set = new Set<string>()
  collectStructuredRefs(definition.nodes, set)
  collectStructuredRefs(definition.edges, set)
  for (const node of definition.nodes) {
    const script = node.config?.script
    if (typeof script === 'string') collectCodeRefs(script, set)
  }
  return [...set].sort()
}
