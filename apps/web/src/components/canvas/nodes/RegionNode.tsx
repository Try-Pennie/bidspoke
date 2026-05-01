'use client'

import type { NodeProps } from '@xyflow/react'

export interface RegionNodeData {
  width: number
  height: number
  depth: number
  variant: 'branch' | 'parallel'
}

// Translucent backdrop rendered behind a branch / parallel cluster. A single
// constant alpha is applied per region; nesting darkens visually because the
// outer and inner regions both contribute alpha at the overlapping pixels.
// Pointer events pass through so clicks/drags reach the real nodes.
export function RegionNode({ data }: NodeProps) {
  const { width, height } = data as unknown as RegionNodeData
  return (
    <div
      style={{
        width,
        height,
        background: 'rgba(100, 116, 139, 0.07)',
        borderRadius: 16,
        pointerEvents: 'none',
      }}
    />
  )
}
