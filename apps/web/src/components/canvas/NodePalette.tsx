'use client'

import type { NodeType } from '@/types/workflow'
import { Filter, GitBranch, Code, ArrowRight, LogOut, Trophy } from 'lucide-react'

interface PaletteNode {
  type: NodeType
  label: string
  description: string
  icon: React.ElementType
  color: string
  phase?: 2
}

const NODES: PaletteNode[] = [
  {
    type: 'filter',
    label: 'Filter',
    description: 'Pass or exit gate',
    icon: Filter,
    color: 'text-blue-500',
  },
  {
    type: 'branch',
    label: 'Branch',
    description: 'N conditional paths',
    icon: GitBranch,
    color: 'text-purple-500',
  },
  {
    type: 'code',
    label: 'Code',
    description: 'Sandboxed JS worker',
    icon: Code,
    color: 'text-amber-500',
  },
  {
    type: 'response',
    label: 'Response',
    description: 'HTTP response',
    icon: ArrowRight,
    color: 'text-green-500',
  },
  {
    type: 'exit',
    label: 'Exit',
    description: 'Early termination',
    icon: LogOut,
    color: 'text-red-500',
  },
  {
    type: 'bid_evaluation',
    label: 'Bid Evaluation',
    description: 'Select winning bid',
    icon: Trophy,
    color: 'text-yellow-500',
  },
]

interface Props {
  onDragStart: (e: React.DragEvent, type: NodeType) => void
}

export default function NodePalette({ onDragStart }: Props) {
  return (
    <aside className="flex w-48 flex-col border-r border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-3 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Nodes</p>
        <p className="mt-0.5 text-xs text-gray-400">Drag onto canvas</p>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {NODES.map(({ type, label, description, icon: Icon, color }) => (
          <div
            key={type}
            draggable
            onDragStart={(e) => onDragStart(e, type)}
            className="flex cursor-grab items-start gap-2.5 rounded-lg border border-gray-200 p-2.5 hover:border-gray-300 hover:bg-gray-50 active:cursor-grabbing"
          >
            <Icon className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${color}`} />
            <div>
              <p className="text-xs font-medium text-gray-800">{label}</p>
              <p className="text-xs text-gray-400">{description}</p>
            </div>
          </div>
        ))}

        <div className="px-1 pt-3">
          <p className="text-xs font-medium text-gray-300">Phase 2</p>
        </div>
        {(['parallel', 'partner_bid', 'integration', 'transform'] as NodeType[]).map((type) => (
          <div
            key={type}
            className="flex cursor-not-allowed items-center gap-2 rounded-lg border border-dashed border-gray-200 p-2.5 opacity-40"
            title="Available in Phase 2"
          >
            <p className="text-xs text-gray-400">{type.replace('_', ' ')}</p>
          </div>
        ))}
      </div>
    </aside>
  )
}
