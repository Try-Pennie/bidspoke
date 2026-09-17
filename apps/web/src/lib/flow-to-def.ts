import type { Edge, Node } from '@xyflow/react'
import { sanitizeCodeNodeScripts } from '@bidspoke/script-hygiene'
import type { CanvasNodeData, EdgeDef, NodeType, WorkflowDef } from '@/types/workflow'

/**
 * The definition the canvas saves, serialised from React Flow's nodes and edges.
 *
 * Lives outside WorkflowCanvas so it can be tested as the pure function it is: every save,
 * the dirty signature and the test runner all go through it, so what it produces IS what
 * the server stores.
 *
 * Code node scripts are stripped of trailing whitespace HERE, on the client, and again by
 * the worker on every write (#1117). Both, not one: the dirty signature and the save read
 * this same function, so a server-only trim would make the stored definition differ from
 * what the canvas just sent and save verification would report a false mismatch.
 */
export function flowToDef(
  nodes: Node[],
  edges: Edge[],
  trigger: WorkflowDef['trigger']
): WorkflowDef {
  return sanitizeCodeNodeScripts({
    trigger,
    nodes: nodes.filter((n) => n.id !== 'trigger').map((n) => {
      const d = n.data as unknown as CanvasNodeData
      return {
        id: n.id,
        namespace: d.namespace,
        label: d.label || undefined,
        note: d.note || undefined,
        type: n.type as NodeType,
        position: n.position,
        config: d.config,
        variables: d.variables,
      }
    }),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      source_handle: e.sourceHandle ?? undefined,
      condition: (e.data as { condition?: EdgeDef['condition'] })?.condition,
      ...(e.hidden ? { hidden: true } : {}),
    })),
  })
}
