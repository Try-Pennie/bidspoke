import type { ComponentType } from 'react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { nodeTypeGetsTimeoutBadge } from '@/lib/timeout-badge'
import { TimeoutWarningBadge } from './TimeoutWarningBadge'

/**
 * Wraps a canvas node component so its card automatically renders the
 * timeout-warning badge (sub-floor or below-suggested). Applied once over the
 * whole nodeTypes registry in WorkflowCanvas so every current and future node
 * type gets the indicator without touching the individual card components.
 *
 * The badge renders as a sibling of the card rather than inside it, so it
 * anchors to React Flow's own node wrapper — which tightly wraps the card and is
 * a containing block (positioned + transformed) — landing in the same bottom-left
 * corner as when the badge lived inside the card.
 */
export function withTimeoutBadge(Node: ComponentType<NodeProps>): ComponentType<NodeProps> {
  function NodeWithTimeoutBadge(props: NodeProps) {
    const { config, namespace } = props.data as unknown as CanvasNodeData
    return (
      <>
        <Node {...props} />
        {nodeTypeGetsTimeoutBadge(props.type) && (
          <TimeoutWarningBadge type={props.type} config={config} namespace={namespace} />
        )}
      </>
    )
  }
  NodeWithTimeoutBadge.displayName = `withTimeoutBadge(${Node.displayName || Node.name || 'Node'})`
  return NodeWithTimeoutBadge
}
