'use client'

// Node-state preview gallery (#227). Renders every canvas node type across the
// cross-cutting visual states (default / unconfigured / timeout warning /
// failed / completed) through the SAME nodeTypes registry + badge HOC the real
// canvas uses, so visual changes (warning glow, corner badges, execution rings)
// can be verified in a browser or via Playwright with no auth or live data.
// Public (see middleware) and read-only; harmless static cards.

import { ReactFlow, ReactFlowProvider, Background, Panel } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { nodeTypes } from '@/components/canvas/WorkflowCanvas'
import { buildPreviewNodes, PREVIEW_STATES } from '@/lib/preview-nodes'

export default function NodePreviewPage() {
  const nodes = buildPreviewNodes()
  return (
    <div style={{ width: '100vw', height: '100vh', background: '#f9f6f0' }}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={[]}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.1 }}
          minZoom={0.1}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Panel position="top-left">
            <div className="rounded-md border border-gray-200 bg-white px-3 py-2 text-xs text-graphite shadow-sm">
              <div className="font-semibold">Node-state preview</div>
              <div className="mt-1 text-slate-500">
                Rows = node types. Columns (left to right): {PREVIEW_STATES.join(' · ')}.
              </div>
            </div>
          </Panel>
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}
