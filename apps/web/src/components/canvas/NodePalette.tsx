'use client'

import type { NodeType } from '@/types/workflow'
import { nodeIconClass } from './nodes/node-colors'
import { Filter, GitBranch, Code, ArrowRight, LogOut, ArrowLeftRight, Plug, GitFork, Package, Cloud, Layers, Database, Timer, HandCoins, BadgeDollarSign, MousePointerClick, ShieldCheck } from 'lucide-react'

interface PaletteNode {
  type: NodeType
  label: string
  description: string
  icon: React.ElementType
  phase?: 2
}

const NODES: PaletteNode[] = [
  {
    type: 'filter',
    label: 'Filter',
    description: 'Pass or exit gate',
    icon: Filter,
  },
  {
    type: 'branch',
    label: 'Branch',
    description: 'N conditional paths',
    icon: GitBranch,
  },
  {
    type: 'code',
    label: 'Code',
    description: 'Sandboxed JS worker',
    icon: Code,
  },
  {
    type: 'response',
    label: 'Response',
    description: 'HTTP response',
    icon: ArrowRight,
  },
  {
    type: 'exit',
    label: 'Exit',
    description: 'Early termination',
    icon: LogOut,
  },
  {
    type: 'transform',
    label: 'Transform',
    description: 'Reshape & rename fields',
    icon: ArrowLeftRight,
  },
  {
    type: 'webhook',
    label: 'HTTP Request',
    description: 'Outgoing HTTP request',
    icon: Plug,
  },
  {
    type: 'parallel',
    label: 'Parallel',
    description: 'Run branches concurrently',
    icon: GitFork,
  },
  {
    type: 'bid_group',
    label: 'Bid Group',
    description: 'Send to N partners, pick a winner',
    icon: Layers,
  },
  {
    type: 'constants',
    label: 'Constants',
    description: 'Workflow constants + partner data',
    icon: Package,
  },
  {
    type: 'salesforce',
    label: 'Salesforce',
    description: 'Create, update, or query records',
    icon: Cloud,
  },
  {
    type: 'data_store',
    label: 'Data Store',
    description: 'KV read/write with TTL',
    icon: Database,
  },
  {
    type: 'latency_gate',
    label: 'Latency Gate',
    description: 'Mark a time, then gate on elapsed',
    icon: Timer,
  },
  {
    type: 'achieve_offers',
    label: 'Achieve Offers',
    description: 'Collect Achieve/FDR offers, log only',
    icon: HandCoins,
  },
  {
    type: 'buyer_select',
    label: 'Buyer Select',
    description: 'Sell the lead to the top ranked buyer',
    icon: BadgeDollarSign,
  },
  {
    type: 'buyer_click_send',
    label: 'Buyer Click Send',
    description: 'Send a clicked prospect to a click buyer once',
    icon: MousePointerClick,
  },
  {
    type: 'buyer_click_check',
    label: 'Buyer Click Check',
    description: 'May a click buyer be offered this lead',
    icon: ShieldCheck,
  },
]

/** The types a person can drag on, for the coverage test beside this file. */
export const PALETTE_TYPES: readonly NodeType[] = NODES.map((n) => n.type)

/**
 * Every saved node type that is deliberately NOT on the palette, with the reason
 * (#1411, L233). The coverage test fails on a type that is neither here nor in
 * NODES, so a new node type cannot be forgotten off the palette by accident.
 */
export const PALETTE_HIDDEN: Readonly<Partial<Record<NodeType, string>>> = {
  partner_bid: 'retired (#645): Bid Group replaced it; the engine still executes saved ones',
  branch_end: 'created by the canvas when a branch is dropped, never placed by hand',
  parallel_end: 'created by the canvas when a parallel is dropped, never placed by hand',
}

interface Props {
  onDragStart: (e: React.DragEvent, type: NodeType) => void
}

export default function NodePalette({ onDragStart }: Props) {
  return (
    <aside className="flex w-48 flex-col border-r border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-3 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Nodes</p>
        <p className="mt-0.5 text-xs text-gray-500">Drag onto canvas</p>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {NODES.map(({ type, label, description, icon: Icon }) => (
          <div
            key={type}
            draggable
            onDragStart={(e) => onDragStart(e, type)}
            className="flex cursor-grab items-start gap-2.5 rounded-lg border border-gray-200 p-2.5 hover:border-gray-300 hover:bg-beige active:cursor-grabbing"
          >
            <Icon className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${nodeIconClass(type)}`} />
            <div>
              <p className="text-xs font-medium text-gray-800">{label}</p>
              <p className="text-xs text-gray-500">{description}</p>
            </div>
          </div>
        ))}

      </div>
    </aside>
  )
}
