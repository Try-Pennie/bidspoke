'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
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
import { BidEvaluationNode } from './nodes/BidEvaluationNode'
import { TransformNode } from './nodes/TransformNode'
import { IntegrationNode } from './nodes/IntegrationNode'
import { PartnerBidNode } from './nodes/PartnerBidNode'
import { ParallelNode } from './nodes/ParallelNode'
import { ParallelEndNode } from './nodes/ParallelEndNode'
import { ConstantsNode } from './nodes/ConstantsNode'
import { SalesforceNode } from './nodes/SalesforceNode'
import NodePalette from './NodePalette'
import ConfigPanel from './ConfigPanel'
import ImportDialog from './ImportDialog'
import { api } from '@/lib/api'
import { layoutWorkflow, findFreePosition, overlapsAny, NODE_W, nodeHeight } from '@/lib/layout'
import type { Workflow, WorkflowDef, NodeType, NodeDef, EdgeDef, CanvasNodeData } from '@/types/workflow'
import type { ImportResult } from '@/lib/pipedream-import'
import { Save, Undo2, Redo2, Clock, Check, AlertCircle, AlertTriangle, Settings, Upload, Eye, X, Pencil, RotateCcw, Loader2, FlaskConical, MoreHorizontal, ExternalLink } from 'lucide-react'
import { validateWorkflow, type ValidationError } from '@/lib/workflow-validation'
import { useRouter } from 'next/navigation'
import ExecutionStepPanel from './ExecutionStepPanel'
import TriggerExecutionPanel from './TriggerExecutionPanel'
import { reachableFromTrigger } from './reachability'
import ExecutionListPanel from './ExecutionListPanel'
import TestRunPanel from './TestRunPanel'
import TriggerConfigPanel from './TriggerConfigPanel'
import VersionHistoryPanel from './VersionHistoryPanel'
import type { ExecutionStep } from '@/types/workflow'
import { writeClipboard, readClipboard } from '@/lib/clipboard'

// Defined outside component to prevent re-render on each render
const nodeTypes: NodeTypes = {
  trigger: TriggerNode,
  filter: FilterNode,
  branch: BranchNode,
  code: CodeNode,
  response: ResponseNode,
  exit: ExitNode,
  webhook: IntegrationNode,
  partner_bid: PartnerBidNode,
  transform: TransformNode,
  parallel: ParallelNode,
  parallel_end: ParallelEndNode,
  bid_evaluation: BidEvaluationNode,
  constants: ConstantsNode,
  salesforce: SalesforceNode,
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

function migrateParallelEdges(nodes: NodeDef[], edges: EdgeDef[]): EdgeDef[] {
  const parallelNodes = nodes.filter((n) => n.type === 'parallel' && (n.children?.length ?? 0) > 0)
  if (parallelNodes.length === 0) return edges

  let result = [...edges]

  for (const pNode of parallelNodes) {
    const childIds = new Set(pNode.children ?? [])
    // Already has fan-out edges — skip migration
    if (result.some((e) => e.source === pNode.id && (e.source_handle ?? '').startsWith('child-'))) continue

    // Remove sequential edges between children
    result = result.filter((e) => !(childIds.has(e.source) && childIds.has(e.target)))
    // Remove the old single sequential edge from parallel to its first child
    result = result.filter((e) => !(e.source === pNode.id && childIds.has(e.target)))

    // Add fan-out edges from parallel to each child
    const children = pNode.children ?? []
    for (let i = 0; i < children.length; i++) {
      result.push({
        id: `${pNode.id}-child-${i}`,
        source: pNode.id,
        target: children[i],
        source_handle: `child-${i}`,
      })
    }
  }

  return result
}

function defToNodes(nodes: NodeDef[], edges: EdgeDef[], trigger?: WorkflowDef['trigger']): Node[] {
  const migratedEdges = migrateParallelEdges(nodes, edges)
  const workflowNodes = nodes.map((n) => {
    // Parallel nodes store children at NodeDef.children (top-level) but the
    // config panel reads/writes config.children — merge them on load.
    const config = n.type === 'parallel' && n.children?.length
      ? { ...n.config, children: n.children }
      : n.config
    return {
      id: n.id,
      type: n.type,
      position: { x: 0, y: 0 }, // overridden by layoutWorkflow
      data: { namespace: n.namespace, label: n.label, config, variables: n.variables ?? {} } satisfies CanvasNodeData,
    }
  })
  const allNodes = [makeTriggerNode(trigger ?? DEFAULT_TRIGGER), ...workflowNodes]
  return layoutWorkflow(allNodes, defToEdges(migratedEdges))
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
      // For parallel nodes, resolve children from config.children (stored as node IDs)
      const children = n.type === 'parallel'
        ? ((d.config.children as string[] | undefined) ?? [])
        : undefined
      return {
        id: n.id,
        namespace: d.namespace,
        label: d.label || undefined,
        type: n.type as NodeType,
        position: n.position,
        config: d.config,
        variables: d.variables,
        ...(children !== undefined ? { children } : {}),
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

function defaultNodeConfig(type: NodeType): Record<string, unknown> {
  if (type === 'branch') {
    return {
      branches: [{ label: 'branch_1', condition: { groups: [{ conditions: [], logic: 'AND' }], logic: 'AND' } }],
      use_else: true,
    }
  }
  if (type === 'constants') {
    return { data: {} }
  }
  return {}
}

// ── Auto-connect helpers ─────────────────────────────────────────────────────

// The primary output handle to use when auto-connecting FROM an existing node.
// Returns null for terminal nodes (nothing comes after them) and branch nodes
// (ambiguous — the user should connect those manually).
function primarySourceHandle(type: string): string | null {
  if (type === 'response' || type === 'exit') return null
  if (type === 'branch') return null  // N-way split — no sensible default
  if (type === 'bid_evaluation') return null  // winner/no_winner — ambiguous default
  if (type === 'parallel') return null  // fan-out configured via picker, not auto-connect
  if (type === 'filter') return 'pass'
  return 'output'
}

// Find the best candidate to auto-connect FROM given a drop position.
// Returns the node whose bottom edge is highest above the drop point,
// within a generous horizontal tolerance.
function findDropSource(nodes: Node[], dropPos: { x: number; y: number }): Node | null {
  const H_TOLERANCE = 160 // px — drop doesn't need to be pixel-perfect

  const candidates = nodes.filter((n) => {
    const nh = nodeHeight(n.type)
    const centerX = n.position.x + NODE_W / 2
    return (
      dropPos.y > n.position.y + nh / 2 &&     // drop is below the node center
      Math.abs(dropPos.x - centerX) <= NODE_W / 2 + H_TOLERANCE
    )
  })

  if (candidates.length === 0) return null

  // Among candidates, pick the one whose bottom edge is closest above the drop point
  return candidates.reduce((best, n) => {
    const nBottom = n.position.y + nodeHeight(n.type)
    const bBottom = best.position.y + nodeHeight(best.type)
    return nBottom > bBottom ? n : best
  })
}

function findRunningNamespace(
  nodes: Node[],
  edges: Edge[],
  liveSteps: Record<string, ExecutionStep>
): string | null {
  // Walk the graph from the trigger's successor
  let currentId = edges.find((e) => e.source === 'trigger')?.target
  while (currentId) {
    const node = nodes.find((n) => n.id === currentId)
    if (!node) break
    const ns = (node.data as unknown as CanvasNodeData).namespace
    const step = liveSteps[ns]
    if (!step) return ns  // hasn't completed yet — probably running now
    if (step.status !== 'completed') return null  // terminal, stop here
    // Follow the edge the step took
    const outEdges = edges.filter((e) => e.source === currentId)
    const route = (step.output as Record<string, unknown> | null)?._route as string | undefined
    const nextEdge = (route ? outEdges.find((e) => e.sourceHandle === route) : null) ?? outEdges[0]
    currentId = nextEdge?.target
  }
  return null
}

// ── Inner canvas (needs ReactFlowProvider context) ───────────────────────────

function CanvasInner({ workflow, mode, executionId, executionSteps, executionPayload, executionSource, executionTraceId, executionStartedAt }: {
  workflow: Workflow
  mode: 'edit' | 'view'
  executionId?: string
  executionSteps?: Record<string, ExecutionStep>
  executionPayload?: unknown
  executionSource?: string | null
  executionTraceId?: string | null
  executionStartedAt?: string | null
}) {
  const router = useRouter()
  const { screenToFlowPosition, fitView } = useReactFlow()

  const initEdges = defToEdges(migrateParallelEdges(workflow.definition?.nodes ?? [], workflow.definition?.edges ?? []))
  const [nodes, setNodes, onNodesChange] = useNodesState(
    defToNodes(workflow.definition?.nodes ?? [], workflow.definition?.edges ?? [], workflow.definition?.trigger)
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState(initEdges)
  const [name, setName] = useState(workflow.name)
  const [isDirty, setIsDirty] = useState(false)
  const [triggerVersion, setTriggerVersion] = useState(0)
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
  const [savedPayloads, setSavedPayloads] = useState(workflow.test_payloads ?? [])
  const [showVersions, setShowVersions] = useState(false)
  const [liveSteps, setLiveSteps] = useState<Record<string, ExecutionStep>>({})
  const [testRunning, setTestRunning] = useState(false)
  const [lastTestExecId, setLastTestExecId] = useState<string | null>(null)
  const [showOverflow, setShowOverflow] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  const [edgeContextMenu, setEdgeContextMenu] = useState<{ edgeId: string; x: number; y: number } | null>(null)
  const [sidePanelWidth, setSidePanelWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 320
    const saved = Number.parseInt(window.localStorage.getItem('bidspoke.sidePanelWidth') ?? '', 10)
    if (Number.isFinite(saved) && saved >= 280 && saved <= 800) return saved
    return 320
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('bidspoke.sidePanelWidth', String(sidePanelWidth))
  }, [sidePanelWidth])
  const overflowRef = useRef<HTMLDivElement>(null)
  const sidePanelRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  // Undo/redo
  const [history, setHistory] = useState<{ nodes: Node[]; edges: Edge[] }[]>([])
  const [future, setFuture] = useState<{ nodes: Node[]; edges: Edge[] }[]>([])
  // Copy/paste clipboard — persisted to localStorage so it works across workflows
  function copyNode(node: Node) {
    const d = node.data as unknown as CanvasNodeData
    writeClipboard({ type: node.type as NodeType, config: d.config ?? {}, variables: d.variables ?? {}, position: node.position })
  }

  const triggerRef = useRef<WorkflowDef['trigger']>(
    workflow.definition?.trigger ?? DEFAULT_TRIGGER
  )
  const prevErrorIdsRef = useRef<string>('')

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null
  const nodeNamespaces = nodes.map((n) => (n.data as unknown as CanvasNodeData).namespace)
  const nodeOptions = nodes
    .filter((n) => n.id !== 'trigger' && n.type !== 'parallel_end')
    .map((n) => {
      const d = n.data as unknown as CanvasNodeData
      return { id: n.id, namespace: d.namespace, label: d.label }
    })

  // Compute validation errors for all attached, unconfigured nodes (edit mode only)
  const validationErrors: Map<string, ValidationError> = useMemo(
    () => (mode === 'edit' ? validateWorkflow(nodes, edges) : new Map()),
    [mode, nodes, edges]
  )

  // Inject hasError into node data so nodes can show the amber ring.
  // Auto-focus + select the name input for brand-new workflows so the first action is naming it
  useEffect(() => {
    if (mode === 'edit' && workflow.name === 'Untitled Workflow') {
      requestAnimationFrame(() => {
        nameRef.current?.focus()
        nameRef.current?.select()
      })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Guard with a ref so setNodes is only called when the error set actually changes —
  // otherwise the useMemo above creates a new Map reference on every render, causing
  // setNodes → new nodes → new Map → setNodes → infinite loop.
  useEffect(() => {
    const errorIds = [...validationErrors.keys()].sort().join(',')
    if (errorIds === prevErrorIdsRef.current) return
    prevErrorIdsRef.current = errorIds
    setNodes((ns) =>
      ns.map((n) => {
        const hasError = validationErrors.has(n.id)
        const current = (n.data as unknown as CanvasNodeData).hasError
        if (current === hasError) return n
        return { ...n, data: { ...(n.data as object), hasError } }
      })
    )
  }, [validationErrors, setNodes])

  useEffect(() => {
    api.env.list().then((vars) => setEnvKeys(vars.map((v) => v.key))).catch(() => {})
  }, [])

  // Warn on browser close / refresh when there are unsaved changes
  useEffect(() => {
    if (!isDirty) return
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [isDirty])

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

  // Sync node.data.executionStep with the current execution. When executionSteps
  // is cleared (e.g. user clicked Clear), this also strips executionStep from
  // every node so colors revert to default.
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id === 'trigger') return n
        const namespace = (n.data as unknown as CanvasNodeData).namespace
        const step = executionSteps ? (executionSteps[namespace] ?? null) : undefined
        return { ...n, data: { ...(n.data as object), executionStep: step } }
      })
    )
  }, [executionSteps, setNodes])

  // Mark nodes that aren't reachable from the trigger so the renderers + minimap
  // can dim them. Runs whenever the edge graph changes.
  useEffect(() => {
    const reachable = reachableFromTrigger(nodes, edges)
    setNodes((ns) => {
      let changed = false
      const next = ns.map((n) => {
        const isReachable = reachable.has(n.id)
        const current = (n.data as unknown as CanvasNodeData).isReachable
        if (current === isReachable) return n
        changed = true
        return { ...n, data: { ...(n.data as object), isReachable } }
      })
      return changed ? next : ns
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, nodes.length])

  const handleTestStart = useCallback((_execId: string) => {
    setLiveSteps({})
    setTestRunning(true)
  }, [])

  const handleLiveStep = useCallback((namespace: string, step: ExecutionStep) => {
    setLiveSteps((prev) => ({ ...prev, [namespace]: step }))
  }, [])

  const handleTestEnd = useCallback(() => {
    setTestRunning(false)
  }, [])

  const handleTestStepsLoaded = useCallback((steps: Record<string, ExecutionStep>, execId: string) => {
    setLiveSteps(steps)
    setLastTestExecId(execId)
  }, [])

  const handleNodeRerun = useCallback(async (namespace: string) => {
    if (!lastTestExecId) return
    const definition = flowToDef(nodes, edges, triggerRef.current)
    try {
      const result = await api.workflows.testNode(workflow.id, { namespace, execution_id: lastTestExecId, definition })
      setLiveSteps((prev) => ({
        ...prev,
        [namespace]: {
          status: result.status as ExecutionStep['status'],
          output: result.output,
          input: null,
          error_message: result.error_message,
          error_type: null,
          duration_ms: result.duration_ms,
          retries_used: 0,
        },
      }))
    } catch (e) {
      // Surface the failure in the step display instead of silently console-logging.
      // Common cause: the code-node deploy failed (CF upload error) — without this,
      // the user clicks Re-run, sees nothing happen, and has no clue the upload
      // never landed.
      const msg = e instanceof Error ? e.message : String(e)
      console.error('Re-run failed:', e)
      setLiveSteps((prev) => ({
        ...prev,
        [namespace]: {
          status: 'failed' as ExecutionStep['status'],
          output: null,
          input: null,
          error_message: `Re-run failed: ${msg}`,
          error_type: null,
          duration_ms: 0,
          retries_used: 0,
        },
      }))
    }
  }, [lastTestExecId, nodes, edges, workflow.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Apply live step data to nodes during a test run
  useEffect(() => {
    const hasLive = Object.keys(liveSteps).length > 0 || testRunning
    if (!hasLive) return

    // Infer which node is currently running by walking the graph
    const runningNs = testRunning ? findRunningNamespace(nodes, edges, liveSteps) : null

    setNodes((ns) =>
      ns.map((n) => {
        if (n.id === 'trigger') return n
        const namespace = (n.data as unknown as CanvasNodeData).namespace
        const step = liveSteps[namespace]

        if (step) {
          return { ...n, data: { ...(n.data as object), executionStep: step } }
        }
        if (namespace === runningNs) {
          // Show as currently running
          return { ...n, data: { ...(n.data as object), executionStep: { status: 'running' as const, input: null, output: null, error_message: null, error_type: null, duration_ms: 0, retries_used: 0 } } }
        }
        // Clear any previous execution step
        return { ...n, data: { ...(n.data as object), executionStep: undefined } }
      })
    )
  }, [liveSteps, testRunning]) // eslint-disable-line react-hooks/exhaustive-deps

  // Color edges based on which nodes ran (view mode uses executionSteps; test mode uses liveSteps)
  useEffect(() => {
    const stepsToUse = executionSteps ?? (Object.keys(liveSteps).length > 0 ? liveSteps : undefined)
    if (!stepsToUse) {
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
        const sourceStep = sourceNs !== undefined ? stepsToUse[sourceNs] : undefined
        const targetStep = targetNs !== undefined ? stepsToUse[targetNs] : undefined
        const sourceRan = edge.source === 'trigger' || sourceStep != null
        const targetRan = targetStep != null
        const sourceFailed = sourceStep?.status === 'failed' || sourceStep?.status === 'failed_with_fallback'
        const targetFailed = targetStep?.status === 'failed' || targetStep?.status === 'failed_with_fallback'

        if (sourceRan && targetRan) {
          // Path was taken — red if either endpoint failed, green otherwise
          if (sourceFailed || targetFailed) {
            return { ...edge, animated: true, style: { stroke: '#ef4444', strokeWidth: 2 } }
          }
          return { ...edge, animated: true, style: { stroke: '#22c55e', strokeWidth: 2 } }
        } else if (sourceRan) {
          // Source ran but this branch wasn't taken (e.g. filter pass when exit fired)
          return { ...edge, animated: false, style: { stroke: '#d1d5db', strokeWidth: 1.5 } }
        } else {
          // Not yet reached — show as default gray so edges stay visible
          return { ...edge, animated: false, style: undefined }
        }
      })
    )
  }, [executionSteps, liveSteps]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const removeFromChain = useCallback((nodeId: string) => {
    snapshot()
    const inEdges = edges.filter((e) => e.target === nodeId)
    const outEdges = edges.filter((e) => e.source === nodeId && e.sourceHandle === 'output')
    const connectedIds = new Set([...inEdges.map((e) => e.id), ...outEdges.map((e) => e.id)])
    const remaining = edges.filter((e) => !connectedIds.has(e.id))
    const bridgeEdges: Edge[] = []
    if (inEdges.length === 1 && outEdges.length === 1) {
      bridgeEdges.push({
        id: uid(),
        source: inEdges[0].source,
        target: outEdges[0].target,
        sourceHandle: inEdges[0].sourceHandle ?? 'output',
      })
    }
    const newEdges = [...remaining, ...bridgeEdges]
    setEdges(newEdges)
    setNodes((ns) => layoutWorkflow(ns, newEdges))
    setIsDirty(true)
    setContextMenu(null)
  }, [snapshot, edges, setEdges, setNodes])

  // Disconnect: cut only the node's incoming edges. The node and its entire
  // downstream subgraph float away as a disconnected cluster (still internally
  // connected), dimmed by the reachability effect.
  const disconnectNode = useCallback((nodeId: string) => {
    snapshot()
    const newEdges = edges.filter((e) => e.target !== nodeId)
    setEdges(newEdges)
    setNodes((ns) => layoutWorkflow(ns, newEdges))
    setIsDirty(true)
    setContextMenu(null)
  }, [snapshot, edges, setEdges, setNodes])

  // Disconnect a single edge — used by the right-click menu on edges.
  const deleteEdge = useCallback((edgeId: string) => {
    snapshot()
    const newEdges = edges.filter((e) => e.id !== edgeId)
    setEdges(newEdges)
    setNodes((ns) => layoutWorkflow(ns, newEdges))
    setIsDirty(true)
    setEdgeContextMenu(null)
  }, [snapshot, edges, setEdges, setNodes])


  // ── Keyboard shortcuts ──────────────────────────────────────────────────────

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      if (meta && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo() }
      if (meta && e.key === 's') { e.preventDefault(); handleSave() }
      if (e.key === 'Escape') { setContextMenu(null); setEdgeContextMenu(null) }

      // Copy/paste — skip when focus is inside any side panel (config, test, trigger).
      // This covers Monaco and all other inputs in those panels without relying on
      // fragile element-type checks.
      const target = e.target instanceof Node ? e.target : null
      if (target && sidePanelRef.current?.contains(target)) return

      // Also skip for any plain editable element outside the side panels (e.g. name input in toolbar)
      const inInput = e.composedPath().some(
        (el) => el instanceof HTMLInputElement
          || el instanceof HTMLTextAreaElement
          || (el instanceof HTMLElement && el.isContentEditable)
      )
      if (inInput) return

      // Cmd+C — copy selected node (not the trigger) to localStorage
      if (meta && e.key === 'c' && selectedNodeId && selectedNodeId !== 'trigger') {
        const node = nodes.find((n) => n.id === selectedNodeId)
        if (node) copyNode(node)
      }

      // Cmd+V — paste from localStorage clipboard
      if (meta && e.key === 'v') {
        const cb = readClipboard()
        if (cb) {
          e.preventDefault()
          pasteNode(cb)
        }
      }

      // Cmd+D — duplicate selected node in place
      if (meta && e.key === 'd' && selectedNodeId && selectedNodeId !== 'trigger') {
        e.preventDefault()
        const node = nodes.find((n) => n.id === selectedNodeId)
        if (node) duplicateNode(node)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  // ── Connection validation ────────────────────────────────────────────────────

  // The trigger node has a single output — it can only connect to one downstream node.
  // All other nodes are unrestricted (filter/branch already split via separate handles).
  const isValidConnection = useCallback(
    (connection: { source: string | null; sourceHandle?: string | null; target?: string | null }) => {
      // Trigger can only have one outgoing edge
      if (connection.source === 'trigger') {
        return !edges.some((e) => e.source === 'trigger')
      }
      // Each source handle can only connect to one target
      if (connection.source && connection.sourceHandle) {
        return !edges.some(
          (e) => e.source === connection.source && e.sourceHandle === connection.sourceHandle
        )
      }
      return true
    },
    [edges]
  )

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

      const newId = uid()
      // Auto-connect: find the nearest node above the drop point and wire it up
      const rawPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const snapTo = (v: number) => Math.round(v / 20) * 20
      const dropPos = { x: snapTo(rawPos.x), y: snapTo(rawPos.y) }
      const sourceNode = findDropSource(nodes, dropPos)
      const sourceHandle = sourceNode ? primarySourceHandle(sourceNode.type ?? '') : null
      const existingOutEdge = (sourceNode && sourceHandle)
        ? edges.find((e) => e.source === sourceNode.id && e.sourceHandle === sourceHandle)
        : null
      // True when we can simply append after sourceNode (handle is free)
      const autoConnected = !!(sourceNode && sourceHandle && !existingOutEdge)
      // True when we need to INSERT between sourceNode and its current target
      const insertBetween = !!(sourceNode && sourceHandle && existingOutEdge)

      // Parallel drops create a start+end pair with a placeholder edge between them
      if (type === 'parallel') {
        const endId = uid()
        const endNamespace = defaultNamespace('parallel_end', [...nodeNamespaces, namespace])
        const startNode = {
          id: newId,
          type: 'parallel' as NodeType,
          position: { x: 0, y: 0 },
          data: { namespace, config: {}, variables: {}, _pairId: endId } satisfies CanvasNodeData,
        }
        const endNode = {
          id: endId,
          type: 'parallel_end' as NodeType,
          position: { x: 0, y: 0 },
          data: { namespace: endNamespace, config: { wait_for: 'all', timeout_ms: 15000, on_timeout: 'partial', on_child_error: 'fail' }, variables: {}, _pairId: newId } satisfies CanvasNodeData,
        }
        // Hidden backbone edge so Dagre ranks end below start even before children are wired
        const backboneEdge = { id: uid(), source: newId, target: endId, sourceHandle: 'output', hidden: true }
        let newEdges = [...edges, backboneEdge]
        if (autoConnected) {
          newEdges = [...newEdges, { id: uid(), source: sourceNode!.id, target: newId, sourceHandle: sourceHandle! }]
        } else if (insertBetween) {
          newEdges = [
            ...edges.filter((e) => e.id !== existingOutEdge!.id),
            backboneEdge,
            { id: uid(), source: sourceNode!.id, target: newId, sourceHandle: sourceHandle! },
            { id: uid(), source: endId, target: existingOutEdge!.target, sourceHandle: 'output' },
          ]
        }
        setEdges(newEdges)
        setNodes((ns) => layoutWorkflow([...ns, startNode, endNode], newEdges))
        setIsDirty(true)
        return
      }

      const newNode = {
        id: newId,
        type,
        position: { x: 0, y: 0 }, // dagre will position it
        data: { namespace, config: defaultNodeConfig(type), variables: {} } satisfies CanvasNodeData,
      }

      let newEdges = edges
      if (autoConnected) {
        newEdges = [...edges, { id: uid(), source: sourceNode!.id, target: newId, sourceHandle: sourceHandle! }]
      } else if (insertBetween) {
        newEdges = [
          ...edges.filter((e) => e.id !== existingOutEdge!.id),
          { id: uid(), source: sourceNode!.id, target: newId, sourceHandle: sourceHandle! },
          { id: uid(), source: newId, target: existingOutEdge!.target, sourceHandle: 'output' },
        ]
      }

      setEdges(newEdges)
      if (autoConnected || insertBetween) {
        setNodes((ns) => layoutWorkflow([...ns, newNode], newEdges))
      } else {
        // No suitable source found — drop free-floating at the cursor position
        setNodes((ns) => [...ns, { ...newNode, position: dropPos, draggable: true }])
      }
      setIsDirty(true)
    },
    [nodeNamespaces, snapshot, setNodes, setEdges, edges, nodes, screenToFlowPosition]
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
      const node = nodes.find((n) => n.id === id)
      if (!node) return

      // Find the parallel pair — explicit _pairId first, then structural
      // fallback for parallels created before _pairId tracking was added.
      let pairId = (node.data as unknown as CanvasNodeData)?._pairId
      if (!pairId) {
        if (node.type === 'parallel') {
          // Walk forward from the parallel start (through children or the
          // hidden backbone edge) to find the parallel_end.
          const visited = new Set<string>([id])
          const queue = [id]
          while (queue.length > 0) {
            const cur = queue.shift()!
            for (const e of edges) {
              if (e.source !== cur || visited.has(e.target)) continue
              visited.add(e.target)
              const target = nodes.find((n) => n.id === e.target)
              if (target?.type === 'parallel_end') {
                pairId = target.id
                queue.length = 0
                break
              }
              queue.push(e.target)
            }
          }
        } else if (node.type === 'parallel_end') {
          // Walk backward from the end to find its parallel_start.
          const visited = new Set<string>([id])
          const queue = [id]
          while (queue.length > 0) {
            const cur = queue.shift()!
            for (const e of edges) {
              if (e.target !== cur || visited.has(e.source)) continue
              visited.add(e.source)
              const source = nodes.find((n) => n.id === e.source)
              if (source?.type === 'parallel') {
                pairId = source.id
                queue.length = 0
                break
              }
              queue.push(e.source)
            }
          }
        }
      }

      const idsToRemove = new Set([id, ...(pairId ? [pairId] : [])])

      // Collect upstream sources (pointing INTO deletion set) and downstream
      // targets (pointed TO by deletion set) so the surviving graph can be
      // spliced back together — otherwise deleting a middle node leaves the
      // downstream subtree orphaned on the canvas.
      const upstreamSources = new Set<string>()
      const downstreamTargets = new Set<string>()
      for (const e of edges) {
        if (idsToRemove.has(e.target) && !idsToRemove.has(e.source)) upstreamSources.add(e.source)
        if (idsToRemove.has(e.source) && !idsToRemove.has(e.target)) downstreamTargets.add(e.target)
      }

      const keptEdges = edges.filter((e) => !idsToRemove.has(e.source) && !idsToRemove.has(e.target))

      // Splice: connect each upstream to each downstream (skip duplicates).
      // For the common single-in/single-out case this is just one edge.
      const spliceEdges = [] as typeof edges
      for (const source of upstreamSources) {
        for (const target of downstreamTargets) {
          const already = keptEdges.some((e) => e.source === source && e.target === target)
          if (already) continue
          spliceEdges.push({
            id: `splice-${source}-${target}-${Date.now()}`,
            source,
            target,
          })
        }
      }

      const newEdges = [...keptEdges, ...spliceEdges]
      const newNodes = nodes.filter((n) => !idsToRemove.has(n.id))
      setEdges(newEdges)
      setNodes(layoutWorkflow(newNodes, newEdges))
      setSelectedNodeId(null)
      setIsDirty(true)
    },
    [snapshot, nodes, edges, setNodes, setEdges]
  )

  // Shared logic for paste and duplicate
  function pasteNode(cb: { type: NodeType; config: Record<string, unknown>; variables: Record<string, unknown>; position: { x: number; y: number } }) {
    const ns = defaultNamespace(cb.type, nodeNamespaces)
    const newId = uid()
    snapshot()
    setNodes((prev) => {
      const position = findFreePosition(cb.position.x + NODE_W + 24, cb.position.y, cb.type, prev)
      return [
      ...prev,
      {
        id: newId,
        type: cb.type,
        position,
        data: {
          namespace: ns,
          config: JSON.parse(JSON.stringify(cb.config)),
          variables: JSON.parse(JSON.stringify(cb.variables)),
        } satisfies CanvasNodeData,
      },
    ]})
    setSelectedNodeId(newId)
    setIsDirty(true)
  }

  function duplicateNode(node: Node) {
    const d = node.data as unknown as CanvasNodeData
    pasteNode({
      type: node.type as NodeType,
      config: d.config ?? {},
      variables: d.variables ?? {},
      position: node.position,
    })
  }

  const handleNodeDuplicate = useCallback(
    (id: string) => {
      const node = nodes.find((n) => n.id === id)
      if (node) duplicateNode(node)
    },
    [nodes, nodeNamespaces, snapshot, setNodes] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const handleParallelEdgesChange = useCallback(
    (
      add: { id: string; source: string; target: string; sourceHandle: string }[],
      removeIds: string[]
    ) => {
      snapshot()
      setEdges((prev) => {
        const filtered = prev.filter((e) => !removeIds.includes(e.id))
        const newEdges = add.map((a) => ({
          id: a.id,
          source: a.source,
          target: a.target,
          sourceHandle: a.sourceHandle,
          data: {},
        }))
        return [...filtered, ...newEdges]
      })
      setIsDirty(true)
    },
    [snapshot, setEdges] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // ── Save ────────────────────────────────────────────────────────────────────

  async function handleSave() {
    // Block saving a live workflow that has unconfigured nodes
    if (workflow.is_active && validationErrors.size > 0) {
      const names = Array.from(validationErrors.values())
        .map((e) => e.label || e.namespace)
        .join(', ')
      setSaveError(`Can't save a live workflow with unconfigured nodes: ${names}. Fix them or disable the workflow first.`)
      return
    }
    setSaving(true)
    setSaveError(null)
    setSavedOk(false)
    try {
      const definition = flowToDef(nodes, edges, triggerRef.current)
      const result = await api.workflows.save(workflow.id, {
        name,
        definition,
        slack_channel: slackChannel || null,
      })
      setIsDirty(false)
      if (result.deploy_errors?.length) {
        const msg = result.deploy_errors
          .map((e) => `${e.namespace}: ${e.error}`)
          .join('\n')
        setSaveError(`Saved, but ${result.deploy_errors.length === 1 ? 'one code node' : `${result.deploy_errors.length} code nodes`} failed to deploy:\n${msg}`)
      } else {
        setSavedOk(true)
        setTimeout(() => setSavedOk(false), 2500)
        router.push(`/workflows/${workflow.id}?mode=view`)
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // ── Import ──────────────────────────────────────────────────────────────────

  function handleImport(result: ImportResult) {
    snapshot()
    // Set nodes first so ReactFlow registers them before edges try to connect
    setNodes(defToNodes(result.def.nodes, result.def.edges, result.def.trigger))
    setEdges(defToEdges(result.def.edges))
    setName(result.name)
    setIsDirty(true)
    setShowImport(false)
    // Fit after the render cycle so the new graph is in view
    requestAnimationFrame(() => fitView({ padding: 0.3, maxZoom: 0.75 }))
  }

  // ── Version restore ─────────────────────────────────────────────────────────

  async function handleVersionRestore(versionId: string) {
    await api.versions.restore(workflow.id, versionId)
    const updated = await api.workflows.get(workflow.id)
    const newNodes = defToNodes(
      updated.definition?.nodes ?? [],
      updated.definition?.edges ?? [],
      updated.definition?.trigger
    )
    const newEdges = defToEdges(updated.definition?.edges ?? [])
    setNodes(newNodes)
    setEdges(newEdges)
    triggerRef.current = updated.definition?.trigger ?? DEFAULT_TRIGGER
    setName(updated.name)
    setIsDirty(false)
    setShowVersions(false)
    requestAnimationFrame(() => fitView({ padding: 0.3, maxZoom: 0.75 }))
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-screen flex-col">
      {/* Top bar */}
      <header className={`flex h-12 flex-shrink-0 items-center justify-between border-b px-4 ${
        mode === 'edit' ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-white'
      }`}>
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              if (typeof document !== 'undefined' && 'startViewTransition' in document) {
                ;(document as Document & { startViewTransition(cb: () => void): void })
                  .startViewTransition(() => router.push('/workflows'))
              } else {
                router.push('/workflows')
              }
            }}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            ← Workflows
          </button>
          <div className="h-5 w-px bg-gray-200" />
          <div className="group flex items-center gap-1">
            <input
              ref={nameRef}
              style={{ viewTransitionName: 'workflow-name' }}
              className={`rounded border-0 bg-transparent text-base font-bold tracking-tight text-graphite outline-none ring-0 px-2 py-1 focus:ring-1 focus:ring-p-blue-light ${
                mode === 'edit' ? 'hover:bg-gray-100/70 focus:bg-gray-100/70' : ''
              }`}
              value={name}
              onChange={(e) => { setName(e.target.value); setIsDirty(true) }}
              readOnly={mode !== 'edit'}
            />
            {mode === 'edit' && (
              <Pencil className="h-3 w-3 flex-shrink-0 text-gray-300 opacity-0 transition-opacity group-hover:opacity-100" />
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Group: Mode */}
          <div className="flex overflow-hidden rounded border border-gray-200 text-xs">
            <button
              onClick={() => router.push(`/workflows/${workflow.id}?mode=edit`)}
              className={`flex items-center gap-1 px-2.5 py-1.5 font-medium ${
                mode === 'edit' ? 'bg-p-blue-dark text-white' : 'bg-white text-gray-400 hover:bg-beige'
              }`}
            >
              <Pencil className="h-3 w-3" />
              Edit
            </button>
            <button
              onClick={() => router.push(`/workflows/${workflow.id}?mode=view`)}
              className={`flex items-center gap-1 border-l border-gray-200 px-2.5 py-1.5 font-medium ${
                mode === 'view' ? 'bg-gray-100 text-gray-800' : 'bg-white text-gray-400 hover:bg-beige'
              }`}
            >
              <Eye className="h-3 w-3" />
              View
            </button>
          </div>

          <div className="h-5 w-px bg-gray-200" />

          {/* Group: History (edit only) */}
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
              <div className="h-5 w-px bg-gray-200" />
            </>
          )}

          {/* Group: Utilities */}
          {mode === 'edit' && (
            <button
              onClick={() => { setShowTest((s) => !s); setSelectedNodeId(null) }}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium ${
                showTest
                  ? 'border-p-blue-light bg-p-blue-light text-p-blue-dark'
                  : 'border-gray-200 text-gray-600 hover:bg-beige'
              }`}
              title="Run a test execution"
            >
              <FlaskConical className="h-3.5 w-3.5" />
              Test
            </button>
          )}

          {/* Version history — always visible */}
          <button
            onClick={() => setShowVersions((s) => !s)}
            className={`rounded p-1.5 hover:bg-gray-100 ${showVersions ? 'bg-gray-100 text-gray-700' : 'text-gray-400'}`}
            title="Version history"
          >
            <Clock className="h-4 w-4" />
          </button>

          {/* Overflow menu — Settings, Import */}
          <div ref={overflowRef} className="relative">
            <button
              onClick={() => setShowOverflow((s) => !s)}
              className={`rounded p-1.5 text-gray-400 hover:bg-gray-100 ${showOverflow ? 'bg-gray-100 text-gray-600' : ''}`}
              title="More options"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {showOverflow && (
              <div className="absolute right-0 top-full z-50 mt-1 w-52 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                <button
                  onClick={() => { setShowSettings((s) => !s); setShowOverflow(false) }}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-beige ${showSettings ? 'font-medium text-graphite' : 'text-gray-700'}`}
                >
                  <Settings className="h-4 w-4 text-gray-400" />
                  Settings
                </button>
                {mode === 'edit' && (
                  <button
                    onClick={() => { setShowImport(true); setShowOverflow(false) }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-beige"
                  >
                    <Upload className="h-4 w-4 text-gray-400" />
                    Import from Pipedream
                  </button>
                )}
              </div>
            )}
          </div>

          {mode === 'edit' && <div className="h-5 w-px bg-gray-200" />}

          {/* Validation warning */}
          {mode === 'edit' && validationErrors.size > 0 && (
            <div className="flex items-center gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              {validationErrors.size} node{validationErrors.size !== 1 ? 's' : ''} unconfigured
            </div>
          )}

          {/* Group: State */}
          {mode === 'edit' && (
            <button
              onClick={handleSave}
              disabled={saving || !isDirty}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-40 ${
                saving    ? 'bg-p-blue-dark' :
                savedOk   ? 'bg-green-600 hover:bg-green-700' :
                isDirty   ? 'bg-amber-500 hover:bg-amber-600' :
                            'bg-gray-300 cursor-default'
              }`}
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

        {/* Center column: banners stacked on top of the React Flow canvas. Right rail lives as a sibling
            of this column so it spans the full height of the canvas row (up to just under the header). */}
        <div className="flex flex-1 flex-col min-w-0">
          {mode === 'view' && executionId && (
            <div className="flex items-center justify-between border-b border-p-blue-light bg-p-blue-light px-4 py-1.5 text-xs">
              <div className="flex items-center gap-2 text-p-blue-dark">
                <Eye className="h-3.5 w-3.5" />
                <span className="font-medium">Viewing execution</span>
                <span className="font-mono text-p-blue-dark">{executionId.slice(0, 8)}…</span>
              </div>
              <div className="flex items-center gap-3">
                <a
                  href={`/workflows/${workflow.id}/executions/${executionId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-p-blue-dark hover:text-navy"
                  title="Open full execution report"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Full report
                </a>
                {executionPayload !== undefined && (
                  <button
                    onClick={() => {
                      setTestInitialPayload(JSON.stringify(executionPayload, null, 2))
                      setShowTest(true)
                      router.push(`/workflows/${workflow.id}?mode=edit`)
                    }}
                    className="flex items-center gap-1 text-p-blue-dark hover:text-navy"
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
                  className="flex items-center gap-1 text-p-blue-dark hover:text-navy disabled:opacity-50"
                  title="Re-run with the same trigger payload"
                >
                  {replaying
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <RotateCcw className="h-3.5 w-3.5" />}
                  Replay
                </button>
                <button
                  onClick={() => router.push(`/workflows/${workflow.id}?mode=view`)}
                  className="flex items-center gap-1 text-p-blue-dark hover:text-p-blue-dark"
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
            <div className="flex items-center gap-4 border-b border-gray-200 bg-beige px-4 py-2 text-xs">
              <span className="font-medium text-gray-500">Slack channel override</span>
              <input
                className="rounded border border-gray-200 px-2 py-1 text-xs focus:border-p-blue-dark focus:outline-none"
                placeholder="#alerts (leave empty to use org default)"
                value={slackChannel}
                onChange={(e) => { setSlackChannel(e.target.value); setIsDirty(true) }}
              />
              <span className="text-gray-400">Overrides the default channel for this workflow&#39;s alerts.</span>
            </div>
          )}

          <div className="relative flex-1 min-h-0" onDrop={mode === 'edit' ? onDrop : undefined} onDragOver={mode === 'edit' ? onDragOver : undefined}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={(changes) => {
              onNodesChange(changes)
              if (changes.some((c) => c.type === 'remove' || c.type === 'position')) setIsDirty(true)

              // Skip slot-in logic when multiple nodes just finished dragging
              // together — that's a group move, not a single-node re-placement.
              const finishedPositionChanges = changes.filter(
                (c) => c.type === 'position' && c.dragging === false
              )
              const isGroupDrag = finishedPositionChanges.length > 1
              if (isGroupDrag) return

              for (const change of changes) {
                if (change.type !== 'position' || change.dragging !== false) continue
                // Don't let the trigger node be reordered
                if (change.id === 'trigger') {
                  setNodes((ns) => layoutWorkflow(ns, edges))
                  continue
                }

                const node = nodes.find((n) => n.id === change.id)
                if (!node) continue
                const finalPos = (change as { position?: { x: number; y: number } }).position ?? node.position
                const otherNodes = nodes.filter((n) => n.id !== change.id)
                const isConnected = edges.some((e) => e.source === change.id || e.target === change.id)

                if (!isConnected) {
                  // SLOT-IN: isolated node dragged near the workflow → auto-connect
                  const sourceNode = findDropSource(otherNodes, finalPos)
                  const sourceHandle = sourceNode ? primarySourceHandle(sourceNode.type ?? '') : null
                  const existingOutEdge = (sourceNode && sourceHandle)
                    ? edges.find((e) => e.source === sourceNode.id && e.sourceHandle === sourceHandle)
                    : null

                  if (sourceNode && sourceHandle && !existingOutEdge) {
                    // Append: handle is free, simply connect sourceNode → this node
                    const newEdges = [...edges, { id: uid(), source: sourceNode.id, target: change.id, sourceHandle }]
                    setEdges(newEdges)
                    setNodes((ns) => layoutWorkflow(ns, newEdges))
                    setIsDirty(true)
                  } else if (sourceNode && sourceHandle && existingOutEdge) {
                    // Insert between: remove sourceNode→oldTarget, add sourceNode→this→oldTarget
                    const newEdges = [
                      ...edges.filter((e) => e.id !== existingOutEdge.id),
                      { id: uid(), source: sourceNode.id, target: change.id, sourceHandle },
                      { id: uid(), source: change.id, target: existingOutEdge.target, sourceHandle: 'output' },
                    ]
                    setEdges(newEdges)
                    setNodes((ns) => layoutWorkflow(ns, newEdges))
                    setIsDirty(true)
                  } else {
                  // If no valid slot found, keep free-floating but push away from any overlap
                  if (overlapsAny(finalPos, node.type, otherNodes)) {
                    const safePos = findFreePosition(finalPos.x, finalPos.y, node.type, otherNodes)
                    setNodes((ns) => ns.map((n) => n.id === change.id ? { ...n, position: safePos } : n))
                  }
                  // If no valid slot found, node stays where it was dropped (free-floating)
                  }
                } else {
                  // REORDER: connected node dragged to a new position in the flow
                  const newSource = findDropSource(otherNodes, finalPos)
                  const newSourceHandle = newSource ? primarySourceHandle(newSource.type ?? '') : null

                  // No valid target, or target is the same node, or target can't have outgoing edges → snap back
                  const inEdges = edges.filter((e) => e.target === change.id)
                  const currentSourceId = inEdges.length === 1 ? inEdges[0].source : null

                  if (!newSource || !newSourceHandle || newSource.id === currentSourceId) {
                    setNodes((ns) => layoutWorkflow(ns, edges))
                    continue
                  }

                  // The edge that newSource currently uses to connect to its successor
                  const newSourceOutEdge = edges.find(
                    (e) => e.source === newSource.id && e.sourceHandle === newSourceHandle
                  )
                  // newSource already connects to this node — nothing to do
                  if (newSourceOutEdge?.target === change.id) {
                    setNodes((ns) => layoutWorkflow(ns, edges))
                    continue
                  }

                  // N's primary output edge (non-filter/branch nodes have a single 'output' handle)
                  const primaryOut = edges.find(
                    (e) => e.source === change.id && e.sourceHandle === 'output'
                  )

                  // Remove: N's in-edges, N's primary out-edge, newSource's out-edge
                  const toRemove = new Set([
                    ...inEdges.map((e) => e.id),
                    ...(primaryOut ? [primaryOut.id] : []),
                    ...(newSourceOutEdge ? [newSourceOutEdge.id] : []),
                  ])
                  let newEdges = edges.filter((e) => !toRemove.has(e.id))

                  // Bridge the gap: connect N's old predecessor → N's old successor
                  if (inEdges.length === 1 && primaryOut) {
                    newEdges.push({
                      id: uid(),
                      source: inEdges[0].source,
                      target: primaryOut.target,
                      sourceHandle: inEdges[0].sourceHandle ?? 'output',
                    })
                  }

                  // Insert N at new position: newSource → N
                  newEdges.push({ id: uid(), source: newSource.id, target: change.id, sourceHandle: newSourceHandle })

                  // N → newSource's old successor (if any)
                  if (newSourceOutEdge) {
                    newEdges.push({ id: uid(), source: change.id, target: newSourceOutEdge.target, sourceHandle: 'output' })
                  }

                  setEdges(newEdges)
                  setNodes((ns) => layoutWorkflow(ns, newEdges))
                  setIsDirty(true)
                }
              }
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
            isValidConnection={isValidConnection}
            onNodeClick={(e, node) => {
              // Shift / Cmd click → add to multi-selection (handled by React Flow);
              // don't clobber selectedNodeId, which drives the ConfigPanel.
              if (e.shiftKey || e.metaKey || e.ctrlKey) {
                setContextMenu(null)
                return
              }
              setSelectedNodeId(node.id)
              setContextMenu(null)
            }}
            onPaneClick={() => { setSelectedNodeId(null); setContextMenu(null); setEdgeContextMenu(null) }}
            onNodeContextMenu={mode === 'edit' ? (e, node) => {
              if (node.id === 'trigger') return
              e.preventDefault()
              setEdgeContextMenu(null)
              setContextMenu({ nodeId: node.id, x: e.clientX, y: e.clientY })
            } : undefined}
            onEdgeContextMenu={mode === 'edit' ? (e, edge) => {
              e.preventDefault()
              setContextMenu(null)
              setEdgeContextMenu({ edgeId: edge.id, x: e.clientX, y: e.clientY })
            } : undefined}
            nodeTypes={nodeTypes}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={mode === 'edit'}
            nodesConnectable={mode === 'edit'}
            deleteKeyCode={mode === 'edit' ? 'Backspace' : null}
            snapToGrid={mode === 'edit'}
            snapGrid={[20, 20]}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 0.75 }}
            minZoom={0.2}
            maxZoom={1.5}
            multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
            selectionKeyCode="Shift"
            selectNodesOnDrag={false}
          >
            <Background variant={BackgroundVariant.Dots} color="#cbd5e1" gap={20} size={1.5} style={{ backgroundColor: '#f8fafc' }} />
            <Controls />
            {mode === 'edit' && nodes.length === 1 && !showTest && (
              <Panel position="bottom-center" className="mb-8 pointer-events-none">
                <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-gray-200 bg-white/90 px-8 py-5 text-center shadow-sm backdrop-blur-[2px]">
                  <p className="text-sm font-medium text-gray-500">Drag a step from the left to start building</p>
                  <p className="text-xs text-gray-400">Filter · Branch · Webhook · Code · Transform</p>
                </div>
              </Panel>
            )}
            <MiniMap
              nodeColor={(n) => {
                const data = n.data as unknown as CanvasNodeData | undefined
                if (data?.isReachable === false) return '#d1d5db' // gray-300
                const colorMap: Record<string, string> = {
                  trigger:        '#439FE1', // indigo
                  filter:         '#3b82f6', // blue
                  branch:         '#a855f7', // purple
                  code:           '#f59e0b', // amber
                  response:       '#10b981', // green
                  exit:           '#ef4444', // red
                  transform:      '#f97316', // orange
                  webhook:        '#14b8a6', // teal
                  bid_evaluation: '#f43f5e', // rose
                  partner_bid:    '#0ea5e9', // sky
                  parallel:       '#64748b', // slate
                  parallel_end:   '#64748b', // slate
                  salesforce:     '#3b82f6', // blue
                }
                return colorMap[n.type ?? ''] ?? '#9ca3af'
              }}
              maskColor="rgba(243,244,246,0.7)"
            />
          </ReactFlow>

          {contextMenu && (() => {
            const cmInEdges = edges.filter((e) => e.target === contextMenu.nodeId)
            const cmOutEdges = edges.filter((e) => e.source === contextMenu.nodeId && e.sourceHandle === 'output')
            const hasInEdges = cmInEdges.length > 0
            const isInChain = hasInEdges || cmOutEdges.length > 0
            return (
              <div
                className="fixed z-50 min-w-[200px] rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
                style={{ left: contextMenu.x, top: contextMenu.y }}
                onContextMenu={(e) => e.preventDefault()}
              >
                {hasInEdges && (
                  <button
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-beige"
                    onClick={() => disconnectNode(contextMenu.nodeId)}
                    title="Detach this node and its downstream subgraph from the main flow"
                  >
                    <X className="h-3.5 w-3.5 text-gray-400" />
                    Disconnect
                  </button>
                )}
                {isInChain && (
                  <button
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-beige"
                    onClick={() => removeFromChain(contextMenu.nodeId)}
                    title="Splice this single node out; the chain reconnects around it"
                  >
                    <X className="h-3.5 w-3.5 text-gray-400" />
                    Remove from chain
                  </button>
                )}
                {!isInChain && (
                  <div className="px-3 py-1.5 text-xs text-gray-400">No connections</div>
                )}
              </div>
            )
          })()}

          {edgeContextMenu && (
            <div
              className="fixed z-50 min-w-[160px] rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
              style={{ left: edgeContextMenu.x, top: edgeContextMenu.y }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-beige"
                onClick={() => deleteEdge(edgeContextMenu.edgeId)}
              >
                <X className="h-3.5 w-3.5 text-gray-400" />
                Disconnect
              </button>
            </div>
          )}
          </div>
        </div>

        <div ref={sidePanelRef} className="contents">
          {/* TestRunPanel stays mounted while the test tool is open so its
              local state (steps, result banner, running status) survives
              when the user clicks into a node and back to the trigger. */}
          {mode === 'edit' && showTest && (
            <div
              style={{
                display: !selectedNode || selectedNode.id === 'trigger' ? 'contents' : 'none',
              }}
            >
              <TestRunPanel
                workflowId={workflow.id}
                currentDefinition={flowToDef(nodes, edges, triggerRef.current)}
                onClose={() => { setShowTest(false); setTestInitialPayload(undefined) }}
                onComplete={() => setRefreshSignal((s) => s + 1)}
                initialPayload={testInitialPayload}
                savedPayloads={savedPayloads}
                onSavedPayloadsChange={setSavedPayloads}
                onTestStart={handleTestStart}
                onLiveStep={handleLiveStep}
                onTestEnd={handleTestEnd}
                onTestStepsLoaded={handleTestStepsLoaded}
                width={sidePanelWidth}
                onResize={setSidePanelWidth}
              />
            </div>
          )}
          {selectedNode && mode === 'edit' && selectedNode.id === 'trigger' && !showTest && (
            <TriggerConfigPanel
              workflowId={workflow.id}
              workflowName={workflow.name}
              trigger={triggerRef.current}
              nodeNamespaces={nodeNamespaces.filter((n) => n !== 'trigger')}
              onChange={(t) => { triggerRef.current = t; setIsDirty(true); setTriggerVersion(v => v + 1) }}
              onClose={() => setSelectedNodeId(null)}
              width={sidePanelWidth}
              onResize={setSidePanelWidth}
            />
          )}
          {selectedNode && mode === 'edit' && selectedNode.id !== 'trigger' && (
            <ConfigPanel
              node={selectedNode}
              onUpdate={handleNodeUpdate}
              onDelete={handleNodeDelete}
              onClose={() => setSelectedNodeId(null)}
              onDuplicate={handleNodeDuplicate}
              nodeNamespaces={nodeNamespaces}
              nodeOptions={nodeOptions}
              refs={refs}
              edges={edges}
              onEdgesChange={handleParallelEdgesChange}
              canRerun={!!lastTestExecId}
              onRerun={handleNodeRerun}
              width={sidePanelWidth}
              onResize={setSidePanelWidth}
            />
          )}
        </div>
        {selectedNode && mode === 'view' && executionId && selectedNode.id === 'trigger' && (
          <TriggerExecutionPanel
            workflowId={workflow.id}
            payload={executionPayload}
            source={executionSource}
            traceId={executionTraceId}
            startedAt={executionStartedAt}
            onClose={() => setSelectedNodeId(null)}
            width={sidePanelWidth}
            onResize={setSidePanelWidth}
          />
        )}
        {selectedNode && mode === 'view' && executionId && selectedNode.id !== 'trigger' && (
          <ExecutionStepPanel
            node={selectedNode}
            onClose={() => setSelectedNodeId(null)}
            width={sidePanelWidth}
            onResize={setSidePanelWidth}
          />
        )}
        {selectedNode && mode === 'view' && !executionId && selectedNode.id === 'trigger' && (
          <TriggerConfigPanel
            readOnly
            workflowId={workflow.id}
            workflowName={workflow.name}
            trigger={triggerRef.current}
            onChange={() => {}}
            onClose={() => setSelectedNodeId(null)}
            width={sidePanelWidth}
            onResize={setSidePanelWidth}
          />
        )}
        {selectedNode && mode === 'view' && !executionId && selectedNode.id !== 'trigger' && (
          <ConfigPanel
            readOnly
            node={selectedNode}
            onClose={() => setSelectedNodeId(null)}
            nodeNamespaces={nodeNamespaces}
            nodeOptions={nodeOptions}
            refs={refs}
            edges={edges}
            width={sidePanelWidth}
            onResize={setSidePanelWidth}
          />
        )}
        {showVersions && (
          <VersionHistoryPanel
            workflowId={workflow.id}
            onClose={() => setShowVersions(false)}
            onRestore={handleVersionRestore}
            width={sidePanelWidth}
            onResize={setSidePanelWidth}
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
  executionSource,
  executionTraceId,
  executionStartedAt,
}: {
  workflow: Workflow
  mode: 'edit' | 'view'
  executionId?: string
  executionSteps?: Record<string, ExecutionStep>
  executionPayload?: unknown
  executionSource?: string | null
  executionTraceId?: string | null
  executionStartedAt?: string | null
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner
        workflow={workflow}
        mode={mode}
        executionId={executionId}
        executionSteps={executionSteps}
        executionPayload={executionPayload}
        executionSource={executionSource}
        executionTraceId={executionTraceId}
        executionStartedAt={executionStartedAt}
      />
    </ReactFlowProvider>
  )
}
