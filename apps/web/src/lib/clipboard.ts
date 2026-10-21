import type { NodeType } from '@/types/workflow'

export const CLIPBOARD_KEY = 'bidspoke:node-clipboard'

export interface ClipboardEntry {
  type: NodeType
  config: Record<string, unknown>
  variables: Record<string, unknown>
  position: { x: number; y: number }
  /**
   * The copied node's step id and display name (#2590). A lead validation swap
   * pastes the proven node rather than retyping it, and lead sightings and
   * Snowflake record a step by these, so a paste keeps them when it can
   * (pasteIdentity). An entry copied before they were carried has neither.
   */
  namespace?: string
  label?: string
}

/** Deep-clone a node's config/variables and persist to localStorage. */
export function writeClipboard(entry: ClipboardEntry): void {
  localStorage.setItem(CLIPBOARD_KEY, JSON.stringify({
    type: entry.type,
    config: JSON.parse(JSON.stringify(entry.config)),
    variables: JSON.parse(JSON.stringify(entry.variables)),
    position: entry.position,
    ...(entry.namespace ? { namespace: entry.namespace } : {}),
    ...(entry.label ? { label: entry.label } : {}),
  }))
}

/**
 * The step id and display name a pasted node takes: the copied ones when the
 * step id is free in this workflow, so a node pasted into another workflow is
 * the node that was proven, name and all. When it is taken (a paste beside the
 * original) the paste takes the type's default step id and no name, as every
 * paste did before, so two steps never share one.
 */
export function pasteIdentity(entry: ClipboardEntry, existingNamespaces: readonly string[]): { namespace?: string; label?: string } {
  if (!entry.namespace || existingNamespaces.includes(entry.namespace)) return {}
  return { namespace: entry.namespace, ...(entry.label ? { label: entry.label } : {}) }
}

/** Read the current clipboard entry, or null if empty / unparseable. */
export function readClipboard(): ClipboardEntry | null {
  try {
    return JSON.parse(localStorage.getItem(CLIPBOARD_KEY) ?? 'null') as ClipboardEntry | null
  } catch {
    return null
  }
}
