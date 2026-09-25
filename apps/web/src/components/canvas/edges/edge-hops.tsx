'use client'

import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import { useStore } from '@xyflow/react'
import type { ReactFlowState } from '@xyflow/react'
import { crossingHops, turnY } from './edge-routes'

/**
 * The hops every wire on the canvas draws (#1570), computed once for the whole
 * canvas rather than once per wire, and handed to each wire by id.
 */
export const EdgeHopsContext = createContext<ReadonlyMap<string, number[]>>(new Map())

const NO_HOPS: number[] = []

/** The x positions this wire arches over. */
export function useEdgeHops(id: string): number[] {
  return useContext(EdgeHopsContext).get(id) ?? NO_HOPS
}

type Bounds = { id?: string | null; x: number; y: number; width: number; height: number }

function handle(list: Bounds[] | null | undefined, id: string | null | undefined): Bounds | undefined {
  if (!list || list.length === 0) return undefined
  return list.find((b) => (b.id ?? null) === (id ?? null)) ?? (id == null ? list[0] : undefined)
}

/**
 * Each drawn wire's ends, read from its handles the way React Flow places an edge:
 * out of the bottom centre of the source handle, into the top centre of the
 * target handle. Hidden wires, and wires whose target sits above their source (a
 * climbing cross link, drawn by the fallback path), are left out.
 */
export function routesFromState(state: Pick<ReactFlowState, 'edges' | 'nodeLookup'>): Array<{ id: string; sx: number; sy: number; tx: number; ty: number }> {
  const out: Array<{ id: string; sx: number; sy: number; tx: number; ty: number }> = []
  for (const e of state.edges) {
    if (e.hidden) continue
    const src = state.nodeLookup.get(e.source)
    const tgt = state.nodeLookup.get(e.target)
    if (!src || !tgt) continue
    const sh = handle(src.internals.handleBounds?.source as Bounds[] | undefined, e.sourceHandle)
    const th = handle(tgt.internals.handleBounds?.target as Bounds[] | undefined, e.targetHandle)
    if (!sh || !th) continue
    const sx = src.internals.positionAbsolute.x + sh.x + sh.width / 2
    const sy = src.internals.positionAbsolute.y + sh.y + sh.height
    const tx = tgt.internals.positionAbsolute.x + th.x + th.width / 2
    const ty = tgt.internals.positionAbsolute.y + th.y
    // A handle not yet measured to real numbers is left out rather than written
    // as JSON null and compared as 0, which would hop at the wrong place.
    if (![sx, sy, tx, ty].every(Number.isFinite)) continue
    if (ty <= sy) continue
    out.push({ id: e.id, sx, sy, tx, ty })
  }
  return out
}

type KeyState = Pick<ReactFlowState, 'edges' | 'nodes' | 'nodeLookup' | 'transform'>

/**
 * A store selector giving every wire's ends as one string, so the store compares
 * it by value and the wires re-render only when an end moves. The store calls a
 * selector on EVERY change, pan and zoom included, so the walk over the canvas is
 * skipped when only the view moved (same wires, same nodes, a new transform).
 * Anything else walks again, including React Flow's empty update after it
 * measures handles, which changes no list but does move wire ends.
 */
export function routesKeySelector(): (s: KeyState) => string {
  let last: { edges: unknown; nodes: unknown; transform: unknown; key: string } | null = null
  return (s) => {
    if (last && last.edges === s.edges && last.nodes === s.nodes && last.transform !== s.transform) {
      last.transform = s.transform
      return last.key
    }
    const key = JSON.stringify(routesFromState(s))
    last = { edges: s.edges, nodes: s.nodes, transform: s.transform, key }
    return key
  }
}

/** Computes every wire's hops from the canvas store and provides them to the wires below. */
export function EdgeHopsProvider({ children }: { children: ReactNode }) {
  const select = useMemo(() => routesKeySelector(), [])
  const key = useStore(select)
  const hops = useMemo(() => {
    const routes = (JSON.parse(key) as ReturnType<typeof routesFromState>).map((r) => ({ ...r, by: turnY({ sourceY: r.sy, targetY: r.ty }) }))
    return crossingHops(routes)
  }, [key])
  return <EdgeHopsContext.Provider value={hops}>{children}</EdgeHopsContext.Provider>
}
