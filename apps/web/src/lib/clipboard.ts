import type { NodeType } from '@/types/workflow'

export const CLIPBOARD_KEY = 'bidspoke:node-clipboard'

export interface ClipboardEntry {
  type: NodeType
  config: Record<string, unknown>
  variables: Record<string, unknown>
  position: { x: number; y: number }
}

/** Deep-clone a node's config/variables and persist to localStorage. */
export function writeClipboard(entry: ClipboardEntry): void {
  localStorage.setItem(CLIPBOARD_KEY, JSON.stringify({
    type: entry.type,
    config: JSON.parse(JSON.stringify(entry.config)),
    variables: JSON.parse(JSON.stringify(entry.variables)),
    position: entry.position,
  }))
}

/** Read the current clipboard entry, or null if empty / unparseable. */
export function readClipboard(): ClipboardEntry | null {
  try {
    return JSON.parse(localStorage.getItem(CLIPBOARD_KEY) ?? 'null') as ClipboardEntry | null
  } catch {
    return null
  }
}
