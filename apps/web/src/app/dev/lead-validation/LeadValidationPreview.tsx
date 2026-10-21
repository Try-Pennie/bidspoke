'use client'

import { useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ReactFlow, ReactFlowProvider, Background, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import ConfigPanel from '@/components/canvas/ConfigPanel'
import { nodeTypes } from '@/components/canvas/nodes/registry'
import { PREVIEW_CONFIG, PREVIEW_NODE } from './lead-validation-preview-source'
import { PANEL_WIDTH_DEFAULTS, configPanelKind } from '@/lib/panel-widths'

/**
 * The lead validation step's card and settings panel as the canvas draws them
 * (#2590), for the settled designs' checks files and for screenshots (L606),
 * with no auth and no network. The card sits between a Constants step and a
 * Response, as in RML GigFi; the panel is the real ConfigPanel, open on it, at
 * the width the canvas opens it at when none is remembered (#2595), which is the
 * width the settled design was drawn at. `?panel=320` draws it narrower. `?checks=1` keeps only the first
 * check, the step at its smallest real size.
 */
export function LeadValidationPreview() {
  const params = useSearchParams()
  const count = Math.max(0, Math.min(PREVIEW_CONFIG.checks.length, Number(params.get('checks') ?? PREVIEW_CONFIG.checks.length) || 0))
  const opening = PANEL_WIDTH_DEFAULTS[configPanelKind('lead_validation')]
  const width = Number(params.get('panel') ?? opening) || opening
  const [config, setConfig] = useState<Record<string, unknown>>(() => ({ ...PREVIEW_CONFIG, checks: PREVIEW_CONFIG.checks.slice(0, count) }))

  const nodes: Node[] = useMemo(() => [
    { id: 'c', type: 'constants', position: { x: 0, y: 0 }, data: { namespace: 'constants', label: 'Constants', config: { data: {} }, isReachable: true, variables: {} } },
    { id: 'v', type: 'lead_validation', position: { x: 0, y: 190 }, selected: true, data: { namespace: PREVIEW_NODE.id, label: PREVIEW_NODE.title, config, isReachable: true, variables: {} } },
    { id: 'r', type: 'response', position: { x: 0, y: 380 }, data: { namespace: 'answer', label: 'Answer', config: { status_code: 200 }, isReachable: true, variables: {} } },
  ], [config])
  const edges: Edge[] = [
    { id: 'e1', source: 'c', target: 'v', sourceHandle: 'output', targetHandle: 'input' },
    { id: 'e2', source: 'v', target: 'r', sourceHandle: 'output', targetHandle: 'input' },
  ]
  const panelNode = nodes[1]

  return (
    <div className="flex h-screen bg-beige">
      <div className="min-w-0 flex-1">
        <ReactFlowProvider>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.3, maxZoom: 1.25 }} nodesDraggable={false} nodesConnectable={false} proOptions={{ hideAttribution: true }}>
            <Background />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
      <ConfigPanel
        node={panelNode}
        onUpdate={(_, d) => { if (d.config) setConfig(d.config as Record<string, unknown>) }}
        onClose={() => {}}
        nodeNamespaces={['constants', PREVIEW_NODE.id, 'answer']}
        refs={['steps.constants.output.states', 'trigger.payload.leadUuid']}
        width={width}
        onResize={() => {}}
      />
    </div>
  )
}
