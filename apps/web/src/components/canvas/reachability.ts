import type { Edge, Node } from '@xyflow/react'

/**
 * BFS from the trigger node. Returns the set of node ids that are reachable
 * by following edges source → target. Parallel_end is also reached via its
 * parallel parent's children even if no explicit edge exists (children always
 * fan back in to the end node at runtime).
 *
 * Nodes not in the returned set are disconnected and get dimmed on the canvas.
 */
export function reachableFromTrigger(nodes: Node[], edges: Edge[]): Set<string> {
  const reachable = new Set<string>()
  const triggerId = nodes.find((n) => n.id === 'trigger')?.id
  if (!triggerId) return reachable

  const outgoing = new Map<string, string[]>()
  for (const e of edges) {
    const arr = outgoing.get(e.source) ?? []
    arr.push(e.target)
    outgoing.set(e.source, arr)
  }

  // Parallel parent → children (so a reachable parallel marks its children reachable
  // even if no explicit edge was authored to each child).
  for (const n of nodes) {
    const children = (n as Node & { data?: { children?: unknown } }).data?.children
    if (Array.isArray(children) && children.every((c) => typeof c === 'string')) {
      const arr = outgoing.get(n.id) ?? []
      outgoing.set(n.id, [...arr, ...(children as string[])])
    }
  }

  const queue: string[] = [triggerId]
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const next of outgoing.get(id) ?? []) {
      if (!reachable.has(next)) queue.push(next)
    }
  }
  return reachable
}
