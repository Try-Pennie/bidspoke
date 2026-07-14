import type { Node } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import type { ValidationError } from './workflow-validation'

/**
 * Which of the two unrelated conditions is making a node pulse (#563).
 *
 *   unconfigured: attached but missing required config (a code node with no
 *                 script, a branch arm with no conditions). Blocks saving a
 *                 live workflow.
 *   timeout:      configured fine, but its timeout sits below the reliability
 *                 floor or the history-based suggestion.
 *
 * They used to share one amber glow with no tooltip, so a brand-new empty node
 * was indistinguishable from a timeout misconfig. A user hit exactly that and
 * went hunting through the Timeout section of a node that had no timeout problem.
 */
export type NodeWarningVariant = 'unconfigured' | 'timeout'

/** Amber = unconfigured (matches the toolbar's "N nodes unconfigured" chip); violet = timeout. */
export const NODE_WARNING_CLASS: Record<NodeWarningVariant, string> = {
  unconfigured: 'node-warning',
  timeout: 'node-warning-timeout',
}

/**
 * The same two hues as a hex, for the minimap, whose nodes are SVG rects and so
 * cannot take a class (#656). These MUST equal the box-shadow colors of the
 * matching glow keyframes in globals.css — CSS can't import TS, so that pairing
 * is the one seam where the two surfaces can still drift. node-warning.test.ts
 * reads globals.css and pins them together.
 */
export const NODE_WARNING_COLOR: Record<NodeWarningVariant, string> = {
  unconfigured: '#f59e0b', // amber-500
  timeout: '#8b5cf6', // violet-500
}

/**
 * Ring drawn around a warning node on the minimap. The fill alone can't carry the
 * warning there: the node-type palette already owns both warning hues (a code node
 * IS amber, an achieve_offers node IS violet), so an unconfigured code node — the
 * canonical unconfigured node, since a freshly dropped code node has no script —
 * would be painted the exact color it already was. The ring is what makes it read
 * as flagged, and it's the honest translation of the glow, which is itself a ring.
 */
export const NODE_WARNING_RING: Record<NodeWarningVariant, string> = {
  unconfigured: '#7c2d12', // amber-950: dark enough to read against the amber fill
  timeout: '#2e1065', // violet-950
}

/**
 * Unconfigured wins when both apply: it's the one that blocks the save, and a
 * timeout value on a node that isn't set up yet is the lesser problem. The
 * corner badges still show both, so nothing is hidden.
 */
export function nodeWarningVariant(
  hasError: boolean | undefined,
  timeoutWarn: boolean,
): NodeWarningVariant | null {
  if (hasError) return 'unconfigured'
  if (timeoutWarn) return 'timeout'
  return null
}

/**
 * Stamp each node with whether it's flagged and WHY, so the canvas can show the
 * reason without the user opening the node. Returns the identical node object
 * when nothing changed, so React Flow re-renders only what moved.
 */
export function applyValidationToNodes(
  nodes: Node[],
  flagged: Map<string, ValidationError>,
): Node[] {
  return nodes.map((n) => {
    const error = flagged.get(n.id)
    const hasError = error !== undefined
    const errorMessage = error?.message
    const data = n.data as unknown as CanvasNodeData
    if (data.hasError === hasError && data.errorMessage === errorMessage) return n
    return { ...n, data: { ...(n.data as object), hasError, errorMessage } }
  })
}

/**
 * Signature of the current validation state, used to skip the setNodes pass when
 * nothing changed. Covers the messages too, not just the node ids: a branch node
 * can stay flagged while its reason changes ("No branches defined" → "A branch
 * arm has no conditions set"), and an id-only signature would pin the stale text
 * to the badge forever.
 */
export function validationSignature(flagged: Map<string, ValidationError>): string {
  return [...flagged.entries()]
    .map(([id, e]) => `${id}:${e.message}`)
    .sort()
    .join('|')
}
