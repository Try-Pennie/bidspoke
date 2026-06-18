import type { ComponentType } from 'react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { nodeTypeGetsTimeoutBadge } from '@/lib/timeout-badge'
import { TimeoutWarningBadge } from './TimeoutWarningBadge'
import { NodeWarningGlow } from './NodeWarningGlow'
import { SuccessBadge } from './SuccessBadge'
import { NoteBadge } from './NoteBadge'

// Types that opt out of the wrapper-level corner badges because they aren't a
// single card filling the React Flow wrapper:
//   - branch_end: renders a centered pill inside a wider container (and a full
//     card in its other shape), so a wrapper-anchored badge would float away
//     from the pill. It keeps its own inline SuccessBadge/NoteBadge in both
//     shapes instead.
//   - region: a large translucent background rectangle (a grouping backdrop,
//     not a node card), so a corner badge would sit on empty canvas.
// Every other node type is a single card that fills the wrapper, so the badges
// anchor to the right corners (the same reasoning the timeout badge relies on).
const NO_CORNER_BADGE_TYPES = new Set(['branch_end', 'region'])

/**
 * Wraps a canvas node component so its card automatically renders the corner
 * badges — the timeout warning (sub-floor / below-suggested), the success-node
 * trophy, and the note marker. Applied once over the whole nodeTypes registry in
 * WorkflowCanvas so every current and future node type gets them without
 * touching the individual card components.
 *
 * Each badge renders as a sibling of the card rather than inside it, so it
 * anchors to React Flow's own node wrapper — which tightly wraps the card and is
 * a containing block (positioned + transformed) — landing in the same corners as
 * when the badges lived inside the card.
 */
export function withNodeBadges(Node: ComponentType<NodeProps>): ComponentType<NodeProps> {
  function NodeWithBadges(props: NodeProps) {
    const { config, namespace, isSuccessNode, note, hasError } = props.data as unknown as CanvasNodeData
    const cornerBadges = !NO_CORNER_BADGE_TYPES.has(props.type)
    return (
      <>
        <Node {...props} />
        {nodeTypeGetsTimeoutBadge(props.type) && (
          <TimeoutWarningBadge type={props.type} config={config} namespace={namespace} />
        )}
        {cornerBadges && <SuccessBadge visible={isSuccessNode} />}
        {cornerBadges && <NoteBadge note={note} />}
        {cornerBadges && (
          <NodeWarningGlow type={props.type} config={config} namespace={namespace} hasError={hasError} />
        )}
      </>
    )
  }
  NodeWithBadges.displayName = `withNodeBadges(${Node.displayName || Node.name || 'Node'})`
  return NodeWithBadges
}
