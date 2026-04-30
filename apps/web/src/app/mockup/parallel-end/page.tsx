'use client'

export const runtime = 'edge'

import { useMemo, useState } from 'react'
import { ReactFlow, ReactFlowProvider, Background, Controls } from '@xyflow/react'
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

const baseEdges: Edge[] = [
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

export default function ParallelEndMockupPage() {
  const [style, setStyle] = useState<'node' | 'pill'>('node')
  const nodes = useMemo(() => buildNodes(style), [style])

  return (
    <div className="flex h-screen flex-col bg-gray-50">
      <header className="flex items-center gap-4 border-b border-gray-200 bg-white px-4 py-3">
        <span className="font-semibold text-graphite">Parallel end node — mockup</span>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => setStyle('node')}
            className={`rounded px-3 py-1 ${style === 'node' ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-300'}`}
          >
            Full node
          </button>
          <button
            type="button"
            onClick={() => setStyle('pill')}
            className={`rounded px-3 py-1 ${style === 'pill' ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-300'}`}
          >
            Merge pill
          </button>
        </div>
      </header>
      <div className="flex-1">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={baseEdges}
            nodeTypes={nodeTypes}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  )
}
