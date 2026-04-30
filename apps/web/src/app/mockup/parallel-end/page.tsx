'use client'

export const runtime = 'edge'

import { ReactFlow, ReactFlowProvider, Background } from '@xyflow/react'
import type { Node, Edge, NodeTypes } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { ParallelNode } from '@/components/canvas/nodes/ParallelNode'
import { ParallelEndNode } from '@/components/canvas/nodes/ParallelEndNode'
import { CodeNode } from '@/components/canvas/nodes/CodeNode'

const nodeTypes: NodeTypes = {
  parallel: ParallelNode,
  parallel_end: ParallelEndNode,
  code: CodeNode,
}

const edges: Edge[] = [
  { id: 'e1', source: 'p1', target: 'c_a', sourceHandle: 'child-0' },
  { id: 'e2', source: 'p1', target: 'c_b', sourceHandle: 'child-1' },
  { id: 'e3', source: 'c_a', target: 'p1_end', sourceHandle: 'output' },
  { id: 'e4', source: 'c_b', target: 'p1_end', sourceHandle: 'output' },
]

function buildNodes(endStyle: 'node' | 'pill'): Node[] {
  return [
    {
      id: 'p1',
      type: 'parallel',
      position: { x: 200, y: 40 },
      data: {
        namespace: 'fanout',
        label: 'Fanout',
        config: { wait_for: 'all', children: ['child_a', 'child_b'] },
        variables: {},
        _pairId: 'p1_end',
        isReachable: true,
      },
    },
    {
      id: 'c_a',
      type: 'code',
      position: { x: 50, y: 220 },
      data: {
        namespace: 'child_a',
        config: { script: '// child a' },
        variables: {},
        isReachable: true,
      },
    },
    {
      id: 'c_b',
      type: 'code',
      position: { x: 350, y: 220 },
      data: {
        namespace: 'child_b',
        config: { script: '// child b' },
        variables: {},
        isReachable: true,
      },
    },
    {
      id: 'p1_end',
      type: 'parallel_end',
      position: { x: 200, y: endStyle === 'pill' ? 420 : 400 },
      data: {
        namespace: 'fanout_end',
        config: {},
        variables: {},
        _pairId: 'p1',
        _endStyle: endStyle,
        isReachable: true,
      },
    },
  ]
}

function Pane({ style, label }: { style: 'node' | 'pill'; label: string }) {
  return (
    <div className="flex flex-1 flex-col border-r border-gray-200 last:border-r-0">
      <div className="border-b border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-graphite">
        {label}
      </div>
      <div className="flex-1">
        <ReactFlowProvider>
          <ReactFlow
            nodes={buildNodes(style)}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            zoomOnScroll={false}
            panOnScroll={false}
            preventScrolling={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  )
}

export default function ParallelEndMockupPage() {
  return (
    <div className="flex h-screen flex-col bg-gray-50">
      <header className="border-b border-gray-200 bg-white px-4 py-3">
        <span className="font-semibold text-graphite">Parallel end node — visual comparison</span>
      </header>
      <div className="flex flex-1">
        <Pane style="node" label="Option A — Full node" />
        <Pane style="pill" label="Option B — Merge pill" />
      </div>
    </div>
  )
}
