'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  type OnConnect,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { FilterNode } from './nodes/FilterNode'
import { BranchNode } from './nodes/BranchNode'
import { CodeNode } from './nodes/CodeNode'
import { ResponseNode } from './nodes/ResponseNode'
import { ExitNode } from './nodes/ExitNode'
import { TriggerNode } from './nodes/TriggerNode'
import { GenericNode } from './nodes/GenericNode'
import NodePalette from './NodePalette'
import ConfigPanel from './ConfigPanel'
import ImportDialog from './ImportDialog'
import { api } from '@/lib/api'
import { layoutWorkflow } from '@/lib/layout'
import type { Workflow, WorkflowDef, NodeType, NodeDef, EdgeDef, CanvasNodeData } from '@/types/workflow'
import type { ImportResult } from '@/lib/pipedream-import'
import { Save, Undo2, Redo2, Clock, Check, AlertCircle, Settings, Upload, Eye, X, Pencil, RotateCcw, Loader2, FlaskConical, MoreHorizontal } from 'lucide-react'
import { useRouter } from 'next/navigation'
import ExecutionStepPanel from './ExecutionStepPanel'
import ExecutionListPanel from './ExecutionListPanel'
import TestRunPanel from './TestRunPanel'
import TriggerConfigPanel from './TriggerConfigPanel'
import type { ExecutionStep } from '@/types/workflow'

// Defined outside component to prevent re-render on each render
const nodeTypes: NodeTypes = {
  trigger: TriggerNode,
  filter: FilterNode,
  branch: BranchNode,
  code: CodeNode,
  response: ResponseNode,
  exit: ExitNode,
  // Phase 2 placeholders — render with GenericNode until implemented
  integration: GenericNode,
  partner_bid: GenericNode,
  transform: GenericNode,
  parallel: GenericNode,
  bid_evaluation: GenericNode,
}

function makeTriggerNode(trigger: WorkflowDef['trigger']): Node {
  return {
    id: 'trigger',
    type: 'trigger',
    position: { x: 0, y: 0 },
    data: { trigger },
    deletable: false,
  }
}

const DEFAULT_TRIGGER: WorkflowDef['trigger'] = {
  type: 'http_webhook',
  config: { method: 'POST', auth_method: 'api_key' },
}

// ── Conversion helpers ────────────────────────────────────────────────────────

function defToNodes(nodes: NodeDef[], edges: EdgeDef[], trigger?: WorkflowDef['trigger']): Node[] {
  const workflowNodes = nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: { x: 0, y: 0 }, // overridden by layoutWorkflow
    data: { namespace: n.namespace, config: n.config, variables: n.variables ?? {} } satisfies CanvasNodeData,
  }))
  const allNodes = [makeTriggerNode(trigger ?? DEFAULT_TRIGGER), ...workflowNodes]
  return layoutWorkflow(allNodes, defToEdges(edges))
}

function defToEdges(edges: EdgeDef[]): Edge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.source_handle ?? null,
    data: { condition: e.condition },
  }))
}

function flowToDef(
  nodes: Node[],
  edges: Edge[],
  trigger: WorkflowDef['trigger']
): WorkflowDef {
  return {
    trigger,
    nodes: nodes.filter((n) => n.id !== 'trigger').map((n) => {
      const d = n.data as unknown as CanvasNodeData
      return {
        id: n.id,
        namespace: d.namespace,
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
    })),
  }
}

function uid() {
  return crypto.randomUUID()
}

function defaultNamespace(type: NodeType, existing: string[]): string {
  const base = type.replace('_', '_')
  let i = 1
  while (existing.includes(`${base}_${i}`)) i++
  return `${base}_${i}`
}

// ── Inner canvas (needs ReactFlowProvider context) ───────────────────────────

function CanvasInner({ workflow, mode, executionId, executionSteps, executionPayload }: {
  workflow: Workflow
  mode: 'edit' | 'view'
  executionId?: string
  executionSteps?: Record<string, ExecutionStep>
  executionPayload?: unknown
}) {
  const router = useRouter()
  const { screenToFlowPosition } = useReactFlow()

  const initEdges = defToEdges(workflow.definition?.edges ?? [])
  const [nodes, setNodes, onNodesChange] = useNodesState(
    defToNodes(workflow.definition?.nodes ?? [], workflow.definition?.edges ?? [], workflow.definition?.trigger)
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState(initEdges)
  const [name, setName] = useState(workflow.name)
  const [isDirty, setIsDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedOk, setSavedOk] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [slackChannel, setSlackChannel] = useState(workflow.slack_channel ?? '')
  const [showImport, setShowImport] = useState(false)
  const [envKeys, setEnvKeys] = useState<string[]>([])
  const [replaying, setReplaying] = useState(false)
  const [refreshSignal, setRefreshSignal] = useState(0)
  const [showTest, setShowTest] = useState(false)
  const [testInitialPayload, setTestInitialPayload] = useState<string | undefined>(undefined)
  const [showOverflow, setShowOverflow] = useState(false)
  const overflowRef = useRef<HTMLDivElement>(null)
  // Undo/redo
  const [history, setHistory] = useState<{ nodes: Node[]; edges: Edge[] }[]>([])
  const [future, setFuture] = useState<{ nodes: Node[]; edges: Edge[] }[]>([])

  const triggerRef = useRef<WorkflowDef['trigger']>(
    workflow.definition?.trigger ?? DEFAULT_TRIGGER
  )

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null
  const nodeNamespaces = nodes.map((n) => (n.data as unknown as CanvasNodeData).namespace)

  useEffect(() => {
    api.env.list().then((vars) => setEnvKeys(vars.map((v) => v.key))).catch(() => {})
  }, [])

  useEffect(() => {
    if (!showOverflow) return
    function handler(e: MouseEvent) {
      if (overflowRef.current && !overflowRef.current.contains(e.target as globalThis.Node)) {
        setShowOverflow(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showOverflow])

  // Inject execution step data into node.data when an execution is active
  useEffect(() => {
    if (!executionSteps) return
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id === 'trigger') return n
        const namespace = (n.data as unknown as CanvasNodeData).namespace
        const step = executionSteps[namespace] ?? null
        return { ...n, data: { ...(n.data as object), executionStep: step } }
      })
    )
  }, [executionSteps, setNodes])

  // Color edges based on which nodes ran
  useEffect(() => {
    if (!executionSteps) {
      setEdges((es) => es.map((e) => ({ ...e, animated: false, style: undefined })))
      return
    }
    // Build nodeId → namespace map
    const idToNs = new Map<string, string>()
    for (const n of nodes) {
      if (n.id !== 'trigger') {
        idToNs.set(n.id, (n.data as unknown as CanvasNodeData).namespace)
      }
    }
    setEdges((es) =>
      es.map((edge) => {
        const sourceNs = idToNs.get(edge.source)
        const targetNs = idToNs.get(edge.target)
        // Source ran = it's the trigger, or its step is non-null in executionSteps
        const sourceRan =
          edge.source === 'trigger' ||
          (sourceNs !== undefined && executionSteps[sourceNs] != null)
        // Target ran = its step is non-null
        const targetRan = targetNs !== undefined && executionSteps[targetNs] != null
        const active = sourceRan && targetRan
        return {
          ...edge,
          animated: active,
          style: active
            ? { stroke: '#22c55e', strokeWidth: 2 }
            : { stroke: '#d1d5db', strokeWidth: 1 },
        }
      })
    )
  }, [executionSteps]) // eslint-disable-line react-hooks/exhaustive-deps

  const refs = [
    'trigger.payload',
    'trigger.source',
    ...nodeNamespaces.map((ns) => `steps.${ns}`),
    ...envKeys.map((k) => `env.${k}`),
  ]

  // ── History helpers ─────────────────────────────────────────────────────────

  const snapshot = useCallback(() => {
    setHistory((h) => [...h.slice(-30), { nodes, edges }])
    setFuture([])
  }, [nodes, edges])

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h
      const prev = h[h.length - 1]
      setFuture((f) => [{ nodes, edges }, ...f])
      setNodes(prev.nodes)
      setEdges(prev.edges)
      return h.slice(0, -1)
    })
  }, [nodes, edges, setNodes, setEdges])

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f
      const next = f[0]
      setHistory((h) => [...h, { nodes, edges }])
      setNodes(next.nodes)
      setEdges(next.edges)
      return f.slice(1)
    })
  }, [nodes, edges, setNodes, setEdges])

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      if (meta && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo() }
      if (meta && e.key === 's') { e.preventDefault(); handleSave() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  // ── Connect ─────────────────────────────────────────────────────────────────

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      snapshot()
      const newEdges = addEdge({ ...connection, id: uid() }, edges)
      setEdges(newEdges)
      setNodes((ns) => layoutWorkflow(ns, newEdges))
      setIsDirty(true)
    },
    [snapshot, edges, setEdges, setNodes]
  )

  // ── Drag-drop from palette ──────────────────────────────────────────────────

  const onDragStart = useCallback((e: React.DragEvent, type: NodeType) => {
    e.dataTransfer.setData('nodeType', type)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const type = e.dataTransfer.getData('nodeType') as NodeType
      if (!type) return
      const namespace = defaultNamespace(type, nodeNamespaces)
      snapshot()
      setNodes((ns) => {
        const newNodes = [
          ...ns,
          {
            id: uid(),
            type,
            position: { x: 0, y: 0 }, // dagre will position it
            data: { namespace, config: {}, variables: {} } satisfies CanvasNodeData,
          },
        ]
        return layoutWorkflow(newNodes, edges)
      })
      setIsDirty(true)
    },
    [nodeNamespaces, snapshot, setNodes, edges]
  )

  // ── Node update / delete ────────────────────────────────────────────────────

  const handleNodeUpdate = useCallback(
    (id: string, patch: Partial<CanvasNodeData>) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === id ? { ...n, data: { ...(n.data as object), ...patch } } : n
        )
      )
      setIsDirty(true)
    },
    [setNodes]
  )

  const handleNodeDelete = useCallback(
    (id: string) => {
      snapshot()
      const newEdges = edges.filter((e) => e.source !== id && e.target !== id)
      const newNodes = nodes.filter((n) => n.id !== id)
      setEdges(newEdges)
      setNodes(layoutWorkflow(newNodes, newEdges))
      setSelectedNodeId(null)
      setIsDirty(true)
    },
    [snapshot, nodes, edges, setNodes, setEdges]
  )

  // ── Save ────────────────────────────────────────────────────────────────────

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    setSavedOk(false)
    try {
      const definition = flowToDef(nodes, edges, triggerRef.current)
      await api.workflows.save(workflow.id, {
        name,
        definition,
        slack_channel: slackChannel || null,
      })
      setIsDirty(false)
      setSavedOk(true)
      setTimeout(() => setSavedOk(false), 2500)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // ── Import ──────────────────────────────────────────────────────────────────

  function handleImport(result: ImportResult) {
    snapshot()
    const importedEdges = defToEdges(result.def.edges)
    setEdges(importedEdges)
    setNodes(defToNodes(result.def.nodes, result.def.edges, result.def.trigger))
    setName(result.name)
    setIsDirty(true)
    setShowImport(false)
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-screen flex-col">
      {/* Top bar */}
      <header className="flex h-12 flex-shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push('/workflows')}
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            ← Workflows
          </button>
          <input
            className="rounded border-0 bg-transparent text-sm font-semibold text-gray-900 outline-none ring-0 hover:bg-gray-50 focus:bg-gray-50 focus:ring-1 focus:ring-blue-300 px-2 py-1"
            value={name}
            onChange={(e) => { setName(e.target.value); setIsDirty(true) }}
          />
          {isDirty && mode === 'edit' && <span className="text-xs text-amber-500">Unsaved</span>}
        </div>

        <div className="flex items-center gap-2">
          {/* Edit / View toggle */}
          <div className="flex overflow-hidden rounded border border-gray-200 text-xs">
            <button
              onClick={() => router.push(`/workflows/${workflow.id}?mode=edit`)}
              className={`flex items-center gap-1 px-2.5 py-1.5 font-medium ${
                mode === 'edit' ? 'bg-gray-100 text-gray-800' : 'text-gray-400 hover:bg-gray-50'
              }`}
            >
              <Pencil className="h-3 w-3" />
              Edit
            </button>
            <button
              onClick={() => router.push(`/workflows/${workflow.id}`)}
              className={`flex items-center gap-1 border-l border-gray-200 px-2.5 py-1.5 font-medium ${
                mode === 'view' ? 'bg-gray-100 text-gray-800' : 'text-gray-400 hover:bg-gray-50'
              }`}
            >
              <Eye className="h-3 w-3" />
              View
            </button>
          </div>

          {mode === 'edit' && (
            <>
              <button
                onClick={undo}
                disabled={history.length === 0}
                className="rounded p-1.5 text-gray-400 hover:bg-gray-100 disabled:opacity-30"
                title="Undo (⌘Z)"
              >
                <Undo2 className="h-4 w-4" />
              </button>
              <button
                onClick={redo}
                disabled={future.length === 0}
                className="rounded p-1.5 text-gray-400 hover:bg-gray-100 disabled:opacity-30"
                title="Redo (⌘⇧Z)"
              >
                <Redo2 className="h-4 w-4" />
              </button>
            </>
          )}

          {mode === 'edit' && (
            <button
              onClick={() => { setShowTest((s) => !s); setSelectedNodeId(null) }}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium ${
                showTest
                  ? 'border-blue-300 bg-blue-50 text-blue-700'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
              title="Run a test execution"
            >
              <FlaskConical className="h-3.5 w-3.5" />
              Test
            </button>
          )}

          {/* Overflow menu — Settings, Import, History */}
          <div ref={overflowRef} className="relative">
            <button
              onClick={() => setShowOverflow((s) => !s)}
              className={`rounded p-1.5 text-gray-400 hover:bg-gray-100 ${showOverflow ? 'bg-gray-100 text-gray-600' : ''}`}
              title="More options"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {showOverflow && (
              <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                <button
                  onClick={() => { setShowSettings((s) => !s); setShowOverflow(false) }}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-gray-50 ${showSettings ? 'text-blue-600' : 'text-gray-700'}`}
                >
                  <Settings className="h-4 w-4 text-gray-400" />
                  Settings
                </button>
                {mode === 'edit' && (
                  <button
                    onClick={() => { setShowImport(true); setShowOverflow(false) }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <Upload className="h-4 w-4 text-gray-400" />
                    Import from Pipedream
                  </button>
                )}
                <button
                  onClick={() => { router.push(`/workflows/${workflow.id}/versions`); setShowOverflow(false) }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <Clock className="h-4 w-4 text-gray-400" />
                  Version history
                </button>
              </div>
            )}
          </div>

          {mode === 'edit' && (
            <button
              onClick={handleSave}
              disabled={saving || !isDirty}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {savedOk ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {saving ? 'Saving…' : savedOk ? 'Saved' : 'Save'}
            </button>
          )}
        </div>
      </header>

      {mode === 'view' && executionId && (
        <div className="flex items-center justify-between border-b border-indigo-100 bg-indigo-50 px-4 py-1.5 text-xs">
          <div className="flex items-center gap-2 text-indigo-700">
            <Eye className="h-3.5 w-3.5" />
            <span className="font-medium">Viewing execution</span>
            <span className="font-mono text-indigo-400">{executionId.slice(0, 8)}…</span>
          </div>
          <div className="flex items-center gap-3">
            {executionPayload !== undefined && (
              <button
                onClick={() => {
                  setTestInitialPayload(JSON.stringify(executionPayload, null, 2))
                  setShowTest(true)
                  router.push(`/workflows/${workflow.id}?mode=edit`)
                }}
                className="flex items-center gap-1 text-indigo-600 hover:text-indigo-800"
                title="Load this payload into the test panel"
              >
                <FlaskConical className="h-3.5 w-3.5" />
                Use as test
              </button>
            )}
            <button
              disabled={replaying}
              onClick={async () => {
                setReplaying(true)
                try {
                  await api.executions.replay(executionId)
                  setRefreshSignal((s) => s + 1)
                } finally {
                  setReplaying(false)
                }
              }}
              className="flex items-center gap-1 text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
              title="Re-run with the same trigger payload"
            >
              {replaying
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <RotateCcw className="h-3.5 w-3.5" />}
              Replay
            </button>
            <button
              onClick={() => router.push(`/workflows/${workflow.id}`)}
              className="flex items-center gap-1 text-indigo-400 hover:text-indigo-600"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </button>
          </div>
        </div>
      )}

      {saveError && (
        <div className="flex items-center gap-2 bg-red-50 px-4 py-2 text-xs text-red-600">
          <AlertCircle className="h-3.5 w-3.5" />
          {saveError}
        </div>
      )}

      {showSettings && (
        <div className="flex items-center gap-4 border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs">
          <span className="font-medium text-gray-500">Slack channel override</span>
          <input
            className="rounded border border-gray-200 px-2 py-1 text-xs focus:border-blue-400 focus:outline-none"
            placeholder="#alerts (leave empty to use org default)"
            value={slackChannel}
            onChange={(e) => { setSlackChannel(e.target.value); setIsDirty(true) }}
          />
          <span className="text-gray-400">Overrides the default channel for this workflow&#39;s alerts.</span>
        </div>
      )}

      {/* Canvas area */}
      <div className="flex flex-1 overflow-hidden">
        {mode === 'edit' ? (
          <NodePalette onDragStart={onDragStart} />
        ) : (
          <ExecutionListPanel
            workflowId={workflow.id}
            selectedId={executionId}
            onSelect={(id) => router.push(`/workflows/${workflow.id}?execution=${id}`)}
            refreshSignal={refreshSignal}
          />
        )}

        <div className="flex-1" onDrop={mode === 'edit' ? onDrop : undefined} onDragOver={mode === 'edit' ? onDragOver : undefined}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={(changes) => {
              onNodesChange(changes)
              if (changes.some((c) => c.type === 'remove')) setIsDirty(true)
            }}
            onEdgesChange={(changes) => {
              onEdgesChange(changes)
              if (changes.some((c) => c.type === 'remove')) {
                setIsDirty(true)
                const removedIds = new Set(
                  changes.filter((c) => c.type === 'remove').map((c) => c.id)
                )
                const remaining = edges.filter((e) => !removedIds.has(e.id))
                setNodes((ns) => layoutWorkflow(ns, remaining))
              }
            }}
            onConnect={onConnect}
            onNodeClick={(_, node) => { setSelectedNodeId(node.id) }}
            onPaneClick={() => setSelectedNodeId(null)}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={mode === 'edit'}
            deleteKeyCode={mode === 'edit' ? 'Backspace' : null}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 0.75 }}
            minZoom={0.2}
            maxZoom={1.5}
          >
            <Background variant={BackgroundVariant.Dots} color="#d1d5db" gap={20} size={1.5} />
            <Controls />
            <MiniMap
              nodeColor={(n) => {
                const colorMap: Record<string, string> = {
                  filter: '#3b82f6',
                  branch: '#8b5cf6',
                  code: '#f59e0b',
                  response: '#10b981',
                  exit: '#ef4444',
                }
                return colorMap[n.type ?? ''] ?? '#9ca3af'
              }}
              maskColor="rgba(243,244,246,0.7)"
            />
          </ReactFlow>
        </div>

        {mode === 'edit' && showTest && (
          <TestRunPanel
            workflowId={workflow.id}
            onClose={() => { setShowTest(false); setTestInitialPayload(undefined) }}
            onComplete={() => setRefreshSignal((s) => s + 1)}
            initialPayload={testInitialPayload}
          />
        )}
        {selectedNode && mode === 'edit' && !showTest && selectedNode.id === 'trigger' && (
          <TriggerConfigPanel
            trigger={triggerRef.current}
            onChange={(t) => { triggerRef.current = t; setIsDirty(true) }}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
        {selectedNode && mode === 'edit' && !showTest && selectedNode.id !== 'trigger' && (
          <ConfigPanel
            node={selectedNode}
            onUpdate={handleNodeUpdate}
            onDelete={handleNodeDelete}
            onClose={() => setSelectedNodeId(null)}
            nodeNamespaces={nodeNamespaces}
            refs={refs}
          />
        )}
        {selectedNode && mode === 'view' && executionId && (
          <ExecutionStepPanel
            node={selectedNode}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
      </div>

      {showImport && (
        <ImportDialog
          onImport={handleImport}
          onClose={() => setShowImport(false)}
        />
      )}
    </div>
  )
}

// ── Public export: wraps with ReactFlowProvider ───────────────────────────────

export default function WorkflowCanvas({
  workflow,
  mode,
  executionId,
  executionSteps,
  executionPayload,
}: {
  workflow: Workflow
  mode: 'edit' | 'view'
  executionId?: string
  executionSteps?: Record<string, ExecutionStep>
  executionPayload?: unknown
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner
        workflow={workflow}
        mode={mode}
        executionId={executionId}
        executionSteps={executionSteps}
        executionPayload={executionPayload}
      />
    </ReactFlowProvider>
  )
}
