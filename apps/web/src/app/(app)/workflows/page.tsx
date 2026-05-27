'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import type { WorkflowSummary, Folder } from '@/types/workflow'
import { Plus, MoreHorizontal, Power, Pencil, Copy, Trash2, Check, Search, X, ArrowUpDown, Loader2, Eye, EyeOff, Folder as FolderIcon, FolderPlus, FolderInput, ChevronRight, ChevronDown } from 'lucide-react'
import { FolderDndProvider, useDraggableRow, useDroppableFolder, DragHandle } from '@/components/folders/FolderDnd'
import type { DragEndEvent } from '@/components/folders/FolderDnd'
import { validateWorkflowDef } from '@/lib/workflow-validation'
import { formatDatetime } from '@/lib/dates'
import { Skeleton } from '@/components/ui/Skeleton'

function HealthDot({ rate }: { rate: number | null }) {
  if (rate === null) {
    return <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full border-2 border-gray-200" title="No run history" />
  }
  if (rate < 80) {
    return (
      <span className="relative flex h-2.5 w-2.5 flex-shrink-0" title={`${rate}% success rate`}>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-60" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
      </span>
    )
  }
  return (
    <span
      className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${rate >= 95 ? 'bg-green-500' : 'bg-amber-400'}`}
      title={`${rate}% success rate`}
    />
  )
}

type SortMode = 'time' | 'health'

export default function WorkflowsPage() {
  const router = useRouter()
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([])
  const [healthMap, setHealthMap] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  // Sort (default: updated_at order from API)
  const [sortMode, setSortMode] = useState<SortMode>('time')

  // ⋯ menu
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Inline rename
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // Inline delete confirm
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const removeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Duplicate loading
  const [duplicating, setDuplicating] = useState<string | null>(null)

  // FLIP animation refs for sort
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map())
  const prevPositions = useRef<Map<string, number>>(new Map())

  // Folders
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderSort, setFolderSort] = useState<'mru' | 'name'>('mru')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [folderMenuOpen, setFolderMenuOpen] = useState<string | null>(null)
  const folderMenuRef = useRef<HTMLDivElement>(null)
  const [creatingFolderParent, setCreatingFolderParent] = useState<string | null | undefined>(undefined)
  const [newFolderName, setNewFolderName] = useState('')
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renameFolderValue, setRenameFolderValue] = useState('')
  const [movingWorkflowId, setMovingWorkflowId] = useState<string | null>(null)
  const moveMenuRef = useRef<HTMLDivElement>(null)
  const [movingFolderId, setMovingFolderId] = useState<string | null>(null)
  const folderMoveMenuRef = useRef<HTMLDivElement>(null)
  const [isAnyDragging, setIsAnyDragging] = useState(false)

  useEffect(() => {
    Promise.all([api.workflows.list(), api.stats.get(7), api.folders.list()])
      .then(([wfs, stats, fs]) => {
        setWorkflows(wfs)
        const map: Record<string, number> = {}
        for (const wf of stats.by_workflow) {
          if (wf.success_rate != null) map[wf.workflow_id] = wf.success_rate
        }
        setHealthMap(map)
        setFolders(fs)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  // Restore collapsed state once on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem('bidspoke:folders:collapsed')
      if (raw) setCollapsed(new Set(JSON.parse(raw) as string[]))
    } catch {
      // ignore parse / quota errors
    }
  }, [])

  function toggleCollapse(folderId: string) {
    setCollapsed((s) => {
      const next = new Set(s)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      try { localStorage.setItem('bidspoke:folders:collapsed', JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }

  // Keyboard shortcut: / or ⌘K focuses search
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        searchRef.current?.focus()
      }
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // FLIP: run after sortMode re-render, animate rows from old positions to new
  useLayoutEffect(() => {
    if (prevPositions.current.size === 0) return
    for (const [id, el] of rowRefs.current) {
      const prev = prevPositions.current.get(id)
      if (prev == null) continue
      const next = el.getBoundingClientRect().top
      const dy = prev - next
      if (Math.abs(dy) < 1) continue
      el.style.transform = `translateY(${dy}px)`
      el.style.transition = 'none'
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const [, el] of rowRefs.current) {
          el.style.transition = 'transform 350ms cubic-bezier(0.25, 0.46, 0.45, 0.94)'
          el.style.transform = ''
        }
      })
    })
    prevPositions.current = new Map()
  }, [sortMode])

  // Close menu on outside click
  useEffect(() => {
    if (!openMenuId) return
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as globalThis.Node)) {
        setOpenMenuId(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openMenuId])

  // Close folder menu on outside click
  useEffect(() => {
    if (!folderMenuOpen) return
    function handler(e: MouseEvent) {
      if (folderMenuRef.current && !folderMenuRef.current.contains(e.target as globalThis.Node)) {
        setFolderMenuOpen(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [folderMenuOpen])

  // Close move-to-folder popup on outside click
  useEffect(() => {
    if (!movingWorkflowId && !movingFolderId) return
    function handler(e: MouseEvent) {
      const inWf = moveMenuRef.current?.contains(e.target as globalThis.Node)
      const inFolder = folderMoveMenuRef.current?.contains(e.target as globalThis.Node)
      if (!inWf && !inFolder) {
        setMovingWorkflowId(null)
        setMovingFolderId(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [movingWorkflowId, movingFolderId])

  // Health priority for sort: red=4, amber=3, green=2, no-history=1, inactive=0
  function healthPriority(wf: WorkflowSummary): number {
    if (!wf.is_active) return 0
    const rate = healthMap[wf.id]
    if (rate == null) return 1
    if (rate >= 95) return 2
    if (rate >= 80) return 3
    return 4
  }

  function toggleSort() {
    const prefersReduced =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!prefersReduced) {
      for (const [id, el] of rowRefs.current) {
        prevPositions.current.set(id, el.getBoundingClientRect().top)
      }
    }
    setSortMode((s) => (s === 'time' ? 'health' : 'time'))
  }

  const sortedWorkflows =
    sortMode === 'health'
      ? [...workflows].sort((a, b) => healthPriority(b) - healthPriority(a))
      : workflows

  const isSearchActive = searchQuery.length > 0
  const q = searchQuery.toLowerCase()
  const firstMatchId = isSearchActive
    ? sortedWorkflows.find((wf) => wf.name.toLowerCase().includes(q))?.id
    : undefined

  // Folder tree maps. Keys are nullable strings; we coerce to '__root__' so Map works cleanly.
  const ROOT = '__root__'
  const childFoldersByParent = useMemo(() => {
    const map = new Map<string, Folder[]>()
    for (const f of folders) {
      const key = f.parent_id ?? ROOT
      const arr = map.get(key) ?? []
      arr.push(f)
      map.set(key, arr)
    }
    return map
  }, [folders])

  const workflowsByFolder = useMemo(() => {
    const map = new Map<string, WorkflowSummary[]>()
    for (const w of sortedWorkflows) {
      const key = w.folder_id ?? ROOT
      const arr = map.get(key) ?? []
      arr.push(w)
      map.set(key, arr)
    }
    return map
  }, [sortedWorkflows])

  // Recursive descendant lookup — used by MRU computation and by the
  // move-into-folder picker so we can disable a folder's own descendants.
  const descendantsOf = useMemo(() => {
    const cache = new Map<string, Set<string>>()
    function walk(folderId: string): Set<string> {
      const cached = cache.get(folderId)
      if (cached) return cached
      const set = new Set<string>()
      for (const child of childFoldersByParent.get(folderId) ?? []) {
        set.add(child.id)
        for (const d of walk(child.id)) set.add(d)
      }
      cache.set(folderId, set)
      return set
    }
    for (const f of folders) walk(f.id)
    return cache
  }, [folders, childFoldersByParent])

  function folderMru(folderId: string): number {
    let max = 0
    const folder = folders.find((f) => f.id === folderId)
    if (folder) max = new Date(folder.updated_at).getTime()
    const ids = [folderId, ...(descendantsOf.get(folderId) ?? [])]
    for (const id of ids) {
      for (const w of workflowsByFolder.get(id) ?? []) {
        const t = new Date(w.updated_at).getTime()
        if (t > max) max = t
      }
    }
    return max
  }

  function compareFolders(a: Folder, b: Folder): number {
    if (folderSort === 'name') return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    return folderMru(b.id) - folderMru(a.id)
  }

  // Search match propagation — see env page for the same pattern.
  const { workflowMatches, folderNameMatches, visibleFolders } = useMemo(() => {
    if (!isSearchActive) {
      return { workflowMatches: new Set<string>(), folderNameMatches: new Set<string>(), visibleFolders: new Set<string>() }
    }
    const wm = new Set<string>()
    for (const w of workflows) if (w.name.toLowerCase().includes(q)) wm.add(w.id)
    const fnm = new Set<string>()
    for (const f of folders) if (f.name.toLowerCase().includes(q)) fnm.add(f.id)

    const vis = new Set<string>()
    for (const f of folders) {
      if (fnm.has(f.id)) {
        vis.add(f.id)
        for (const d of descendantsOf.get(f.id) ?? []) vis.add(d)
      }
    }
    for (const f of folders) {
      if (vis.has(f.id)) continue
      const ids = [f.id, ...(descendantsOf.get(f.id) ?? [])]
      for (const id of ids) {
        for (const w of workflowsByFolder.get(id) ?? []) {
          if (wm.has(w.id)) { vis.add(f.id); break }
        }
      }
    }
    // Propagate visibility up to ancestors
    for (const f of folders) {
      if (vis.has(f.id) && f.parent_id) {
        let p: string | null = f.parent_id
        while (p) {
          vis.add(p)
          p = folders.find((x) => x.id === p)?.parent_id ?? null
        }
      }
    }
    return { workflowMatches: wm, folderNameMatches: fnm, visibleFolders: vis }
  }, [isSearchActive, q, workflows, folders, descendantsOf, workflowsByFolder])

  async function handleCreateFolder() {
    const name = newFolderName.trim()
    if (!name) {
      setCreatingFolderParent(undefined)
      setNewFolderName('')
      return
    }
    const parent_id = creatingFolderParent ?? null
    try {
      const folder = await api.folders.create(name, parent_id)
      setFolders((fs) => [...fs, folder])
      // If creating a subfolder, make sure the parent stays expanded
      if (parent_id) {
        setCollapsed((s) => {
          if (!s.has(parent_id)) return s
          const next = new Set(s)
          next.delete(parent_id)
          try { localStorage.setItem('bidspoke:folders:collapsed', JSON.stringify([...next])) } catch { /* ignore */ }
          return next
        })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create folder')
    }
    setCreatingFolderParent(undefined)
    setNewFolderName('')
  }

  function startRenameFolder(folder: Folder) {
    setFolderMenuOpen(null)
    setRenamingFolderId(folder.id)
    setRenameFolderValue(folder.name)
  }

  async function commitRenameFolder(id: string) {
    const trimmed = renameFolderValue.trim()
    setRenamingFolderId(null)
    const original = folders.find((f) => f.id === id)
    if (!trimmed || !original || trimmed === original.name) return
    setFolders((fs) => fs.map((f) => (f.id === id ? { ...f, name: trimmed } : f)))
    try {
      await api.folders.update(id, { name: trimmed })
    } catch (e) {
      setFolders((fs) => fs.map((f) => (f.id === id ? original : f)))
      setError(e instanceof Error ? e.message : 'Failed to rename folder')
    }
  }

  async function handleDeleteFolder(folder: Folder) {
    setFolderMenuOpen(null)
    try {
      await api.folders.delete(folder.id)
      setFolders((fs) => fs.filter((f) => f.id !== folder.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete folder')
    }
  }

  async function handleMoveWorkflow(workflowId: string, folderId: string | null) {
    setMovingWorkflowId(null)
    setOpenMenuId(null)
    const original = workflows.find((w) => w.id === workflowId)
    if (!original) return
    setWorkflows((ws) => ws.map((w) => (w.id === workflowId ? { ...w, folder_id: folderId } : w)))
    // Ensure target folder is expanded so the workflow is visible after move
    if (folderId && collapsed.has(folderId)) {
      setCollapsed((s) => {
        const next = new Set(s)
        next.delete(folderId)
        try { localStorage.setItem('bidspoke:folders:collapsed', JSON.stringify([...next])) } catch { /* ignore */ }
        return next
      })
    }
    try {
      await api.workflows.setFolder(workflowId, folderId)
    } catch (e) {
      setWorkflows((ws) => ws.map((w) => (w.id === workflowId ? original : w)))
      setError(e instanceof Error ? e.message : 'Failed to move workflow')
    }
  }

  async function handleMoveFolder(folderId: string, parentId: string | null) {
    setMovingFolderId(null)
    setFolderMenuOpen(null)
    const original = folders.find((f) => f.id === folderId)
    if (!original || original.parent_id === parentId) return
    if (parentId && (descendantsOf.get(folderId)?.has(parentId) ?? false)) {
      setError('Cannot move a folder into one of its descendants')
      return
    }
    setFolders((fs) => fs.map((f) => (f.id === folderId ? { ...f, parent_id: parentId } : f)))
    if (parentId && collapsed.has(parentId)) {
      setCollapsed((s) => {
        const next = new Set(s)
        next.delete(parentId)
        try { localStorage.setItem('bidspoke:folders:collapsed', JSON.stringify([...next])) } catch { /* ignore */ }
        return next
      })
    }
    try {
      await api.folders.update(folderId, { parent_id: parentId })
    } catch (e) {
      setFolders((fs) => fs.map((f) => (f.id === folderId ? original : f)))
      setError(e instanceof Error ? e.message : 'Failed to move folder')
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    setIsAnyDragging(false)
    const { active, over } = event
    if (!over) return
    const activeKind = (active.data.current?.kind as 'workflow' | 'folder' | undefined) ?? undefined
    const overKind = (over.data.current?.kind as 'folder' | 'root' | undefined) ?? undefined
    if (!activeKind || !overKind) return

    const activeId = String(active.id).replace(/^(workflow|folder):/, '')
    const overId = overKind === 'root' ? null : String(over.id).replace(/^drop:/, '')

    // Dropping a folder on itself is a no-op (would hit cycle guard anyway)
    if (activeKind === 'folder' && activeId === overId) return

    if (activeKind === 'workflow') {
      handleMoveWorkflow(activeId, overId)
    } else if (activeKind === 'folder') {
      handleMoveFolder(activeId, overId)
    }
  }

  // View Transitions: tag the clicked element, then navigate inside startViewTransition
  function navigateToWorkflow(e: React.MouseEvent<HTMLElement>, id: string) {
    // Pass through middle-click / modifier-click so browser handles them normally
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    if (typeof document === 'undefined' || !('startViewTransition' in document)) return
    e.preventDefault()
    const el = e.currentTarget
    el.style.viewTransitionName = 'workflow-name'
    ;(document as Document & { startViewTransition(cb: () => void): void })
      .startViewTransition(() => router.push(`/workflows/${id}`))
  }

  async function handleCreate(folderId: string | null = null) {
    setCreating(true)
    try {
      const wf = await api.workflows.create('Untitled Workflow', folderId)
      router.push(`/workflows/${wf.id}?mode=edit`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create workflow')
      setCreating(false)
    }
  }

  async function handleToggleActive(wf: WorkflowSummary) {
    setOpenMenuId(null)
    const next = !wf.is_active

    // Before enabling, validate that all attached nodes are configured
    if (next) {
      try {
        const full = await api.workflows.get(wf.id)
        const errors = validateWorkflowDef(
          full.definition?.nodes ?? [],
          full.definition?.edges ?? []
        )
        if (errors.length > 0) {
          const names = errors.map((e) => e.label || e.namespace).join(', ')
          setError(`Can't activate "${wf.name}": these nodes need to be configured: ${names}. Open the workflow to fix them.`)
          return
        }
      } catch {
        // If we can't fetch the definition, fall through and let the API attempt it
      }
    }

    setWorkflows((ws) => ws.map((w) => w.id === wf.id ? { ...w, is_active: next } : w))
    try {
      await api.workflows.setActive(wf.id, next)
    } catch (e) {
      setWorkflows((ws) => ws.map((w) => w.id === wf.id ? { ...w, is_active: wf.is_active } : w))
      setError(e instanceof Error ? e.message : 'Failed to update workflow')
    }
  }

  async function handleToggleCaptureSightings(wf: WorkflowSummary) {
    setOpenMenuId(null)
    const current = wf.capture_sightings ?? true
    const next = !current
    setWorkflows((ws) => ws.map((w) => w.id === wf.id ? { ...w, capture_sightings: next } : w))
    try {
      await api.workflows.setCaptureSightings(wf.id, next)
    } catch (e) {
      setWorkflows((ws) => ws.map((w) => w.id === wf.id ? { ...w, capture_sightings: current } : w))
      setError(e instanceof Error ? e.message : 'Failed to update workflow')
    }
  }

  function startRename(wf: WorkflowSummary) {
    setOpenMenuId(null)
    setRenamingId(wf.id)
    setRenameValue(wf.name)
  }

  async function commitRename(id: string) {
    const trimmed = renameValue.trim()
    if (!trimmed) { setRenamingId(null); return }
    setWorkflows((ws) => ws.map((w) => w.id === id ? { ...w, name: trimmed } : w))
    setRenamingId(null)
    try {
      await api.workflows.save(id, { name: trimmed })
    } catch {
      // Reload to revert optimistic update
      api.workflows.list().then(setWorkflows).catch(() => {})
    }
  }

  async function handleDuplicate(id: string) {
    setOpenMenuId(null)
    setDuplicating(id)
    try {
      const copy = await api.workflows.duplicate(id)
      setWorkflows((ws) => [copy as unknown as WorkflowSummary, ...ws])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Duplicate failed')
    } finally {
      setDuplicating(null)
    }
  }

  function requestDelete(id: string) {
    setOpenMenuId(null)
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmingDelete(id)
    deleteTimerRef.current = setTimeout(() => setConfirmingDelete(null), 4000)
  }

  function cancelDelete() {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmingDelete(null)
  }

  async function handleDelete(id: string) {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmingDelete(null)
    const item = workflows.find((w) => w.id === id)
    setRemovingId(id)
    removeTimerRef.current = setTimeout(() => {
      setWorkflows((ws) => ws.filter((w) => w.id !== id))
      setRemovingId(null)
    }, 150)
    try {
      await api.workflows.delete(id)
    } catch (e) {
      if (removeTimerRef.current) clearTimeout(removeTimerRef.current)
      setRemovingId(null)
      if (item) setWorkflows((ws) => ws.find((w) => w.id === id) ? ws : [...ws, item])
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  // ============================================================
  // Folder + workflow row rendering
  // ============================================================

  // Indent: 16px base padding-left + 20px per nesting level.
  const indentPx = (depth: number) => 16 + depth * 20

  function FolderPickerList({
    onPick,
    excludeId,
    rootLabel = 'Root (no folder)',
  }: {
    onPick: (folderId: string | null) => void
    excludeId?: string
    rootLabel?: string
  }) {
    const exclude = excludeId ? new Set([excludeId, ...(descendantsOf.get(excludeId) ?? [])]) : new Set<string>()
    function renderLevel(parentId: string | null, depth: number): React.ReactNode[] {
      const kids = (childFoldersByParent.get(parentId ?? ROOT) ?? []).slice().sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      )
      const out: React.ReactNode[] = []
      for (const f of kids) {
        const disabled = exclude.has(f.id)
        out.push(
          <button
            key={f.id}
            disabled={disabled}
            onClick={() => onPick(f.id)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-beige disabled:cursor-not-allowed disabled:text-gray-300 disabled:hover:bg-transparent"
            style={{ paddingLeft: `${12 + depth * 14}px` }}
          >
            <FolderIcon className="h-3.5 w-3.5 text-gray-400" />
            <span className="truncate">{f.name}</span>
          </button>
        )
        out.push(...renderLevel(f.id, depth + 1))
      }
      return out
    }
    return (
      <div className="max-h-72 overflow-y-auto py-1">
        <button
          onClick={() => onPick(null)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-beige"
        >
          <span className="text-gray-400">↥</span>
          <span>{rootLabel}</span>
        </button>
        <div className="my-1 border-t border-gray-100" />
        {renderLevel(null, 0)}
      </div>
    )
  }

  function renderInlineCreateFolderRow(parentId: string | null, depth: number): React.ReactNode {
    return (
      <tr key={`create-folder-${parentId ?? 'root'}`} className="bg-blue-50/40">
        <td className="w-8 px-2 py-2" />
        <td colSpan={4} className="px-4 py-2" style={{ paddingLeft: `${indentPx(depth)}px` }}>
          <form
            onSubmit={(e) => { e.preventDefault(); handleCreateFolder() }}
            className="flex items-center gap-2"
          >
            <FolderIcon className="h-4 w-4 text-gray-400" />
            <input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onBlur={handleCreateFolder}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setCreatingFolderParent(undefined)
                  setNewFolderName('')
                }
              }}
              placeholder="Folder name"
              className="flex-1 rounded border border-gray-300 px-2 py-0.5 text-sm font-medium text-graphite focus:outline-none focus:ring-1 focus:ring-gray-400"
            />
          </form>
        </td>
      </tr>
    )
  }

  function WorkflowRow({ wf, depth, ancestorMatched }: { wf: WorkflowSummary; depth: number; ancestorMatched: boolean }) {
    const isMatch = !isSearchActive || workflowMatches.has(wf.id) || ancestorMatched
    const isFirstMatch = wf.id === firstMatchId
    const isFailing = healthMap[wf.id] != null && healthMap[wf.id] < 80
    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggableRow(`workflow:${wf.id}`, { kind: 'workflow' })
    const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, opacity: 0.6 } : undefined
    const combinedRef = (el: HTMLTableRowElement | null) => {
      setNodeRef(el)
      if (el) rowRefs.current.set(wf.id, el); else rowRefs.current.delete(wf.id)
    }
    return (
      <tr
        ref={combinedRef}
        style={style}
        className={[
          'group transition-opacity duration-150',
          removingId === wf.id ? 'opacity-0' : '',
          isSearchActive && !isMatch ? 'opacity-20 pointer-events-none select-none' : '',
          isFirstMatch ? 'bg-p-blue-light/50 hover:bg-p-blue-light/70' :
            isFailing ? 'bg-red-50/60 hover:bg-red-50' : 'hover:bg-beige',
        ].filter(Boolean).join(' ')}
      >
        <td className="w-8 px-2 py-3 align-middle">
          <DragHandle attributes={attributes} listeners={listeners} isDragging={isDragging} />
        </td>
        {/* Name + status badge */}
        <td className="px-4 py-3" style={depth > 0 ? { paddingLeft: `${indentPx(depth)}px` } : undefined}>
          <div className="flex items-center gap-2">
            <HealthDot rate={healthMap[wf.id] ?? null} />
            {renamingId === wf.id ? (
              <form
                onSubmit={(e) => { e.preventDefault(); commitRename(wf.id) }}
                className="flex items-center gap-1.5"
              >
                <input
                  autoFocus
                  className="rounded border border-gray-300 px-2 py-0.5 text-sm font-medium text-graphite focus:outline-none focus:ring-1 focus:ring-gray-400"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => commitRename(wf.id)}
                  onKeyDown={(e) => e.key === 'Escape' && setRenamingId(null)}
                />
                <button type="submit" className="rounded p-0.5 text-green-600 hover:bg-green-50">
                  <Check className="h-3.5 w-3.5" />
                </button>
              </form>
            ) : (
              <Link
                href={`/workflows/${wf.id}`}
                onClick={(e) => navigateToWorkflow(e, wf.id)}
                className="font-semibold text-graphite hover:text-p-blue-dark"
              >
                {wf.name}
              </Link>
            )}
            <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
              wf.is_active
                ? 'bg-green-50 text-green-700'
                : 'bg-gray-100 text-gray-500'
            }`}>
              {wf.is_active ? 'Active' : 'Inactive'}
            </span>
            {duplicating === wf.id && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-p-blue-dark" />
            )}
          </div>
          {wf.description && (
            <p className="mt-0.5 text-xs text-gray-400">{wf.description}</p>
          )}
        </td>

        <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
          {formatDatetime(wf.updated_at)}
        </td>
        <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{wf.updated_by_name ?? wf.updated_by_email?.split('@')[0] ?? '—'}</td>

        {/* Actions column */}
        <td className="px-4 py-3">
          <div ref={openMenuId === wf.id || movingWorkflowId === wf.id ? menuRef : undefined} className="relative">
            {/* ••• always in DOM to hold cell size; invisible when confirm showing */}
            <button
              onClick={() => setOpenMenuId(openMenuId === wf.id ? null : wf.id)}
              className={`rounded p-1.5 text-gray-400 hover:bg-gray-100 ${confirmingDelete === wf.id ? 'invisible pointer-events-none' : ''} ${openMenuId === wf.id ? 'bg-gray-100 text-gray-600' : ''}`}
              title="More options"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {/* Confirm — floats absolutely, extends left over adjacent column */}
            {confirmingDelete === wf.id && (
              <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-1.5 whitespace-nowrap">
                <button
                  onClick={() => handleDelete(wf.id)}
                  className="rounded bg-red-500 px-2 py-1 text-xs font-medium text-white hover:bg-red-600"
                >
                  Delete
                </button>
                <button onClick={cancelDelete} className="text-xs text-gray-400 hover:text-gray-600">
                  Cancel
                </button>
              </div>
            )}
            {/* Dropdown menu */}
            {openMenuId === wf.id && (
              <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                <button
                  onClick={() => handleToggleActive(wf)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-beige"
                >
                  <Power className="h-4 w-4 text-gray-400" />
                  {wf.is_active ? 'Disable' : 'Enable'}
                </button>
                <button
                  onClick={() => startRename(wf)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-beige"
                >
                  <Pencil className="h-4 w-4 text-gray-400" />
                  Rename
                </button>
                <button
                  onClick={() => handleDuplicate(wf.id)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-beige"
                >
                  <Copy className="h-4 w-4 text-gray-400" />
                  Duplicate
                </button>
                <button
                  onClick={() => handleToggleCaptureSightings(wf)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-beige"
                >
                  {(wf.capture_sightings ?? true) ? (
                    <EyeOff className="h-4 w-4 text-gray-400" />
                  ) : (
                    <Eye className="h-4 w-4 text-gray-400" />
                  )}
                  {(wf.capture_sightings ?? true) ? 'Stop capturing' : 'Capture sightings'}
                </button>
                <button
                  onClick={() => { setOpenMenuId(null); setMovingWorkflowId(wf.id) }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-beige"
                >
                  <FolderInput className="h-4 w-4 text-gray-400" />
                  Move to folder…
                </button>
                <div className="my-1 border-t border-gray-100" />
                <button
                  onClick={() => requestDelete(wf.id)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </button>
              </div>
            )}
            {/* Move-to-folder popover */}
            {movingWorkflowId === wf.id && (
              <div ref={moveMenuRef} className="absolute right-0 top-full z-50 mt-1 w-60 rounded-lg border border-gray-200 bg-white shadow-lg">
                <FolderPickerList onPick={(folderId) => handleMoveWorkflow(wf.id, folderId)} />
              </div>
            )}
          </div>
        </td>
      </tr>
    )
  }

  function FolderHeaderRow({ folder, depth, nameMatchedHere, expanded, isCollapsed }: {
    folder: Folder
    depth: number
    nameMatchedHere: boolean
    expanded: boolean
    isCollapsed: boolean
  }) {
    const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggableRow(`folder:${folder.id}`, { kind: 'folder' })
    const { setNodeRef: setDropRef, isOver } = useDroppableFolder(`drop:${folder.id}`, { kind: 'folder' })
    const setRef = (el: HTMLTableRowElement | null) => { setDragRef(el); setDropRef(el) }
    const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, opacity: 0.6 } : undefined
    return (
      <tr
        ref={setRef}
        style={style}
        className={`group bg-gray-50/70 hover:bg-gray-100/60 ${isOver ? 'bg-p-blue-light/60 ring-2 ring-inset ring-p-blue-dark' : ''}`}
      >
        <td className="w-8 px-2 py-2 align-middle">
          <DragHandle attributes={attributes} listeners={listeners} isDragging={isDragging} />
        </td>
        <td colSpan={4} className="px-4 py-2" style={{ paddingLeft: `${indentPx(depth)}px` }}>
          <div className="flex items-center gap-2">
            <button
              onClick={() => toggleCollapse(folder.id)}
              disabled={isSearchActive}
              className="rounded p-0.5 text-gray-400 hover:bg-gray-200/60 hover:text-gray-600 disabled:opacity-50"
              aria-label={isCollapsed ? 'Expand folder' : 'Collapse folder'}
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            <FolderIcon className={`h-4 w-4 ${nameMatchedHere ? 'text-p-blue-dark' : 'text-gray-400'}`} />
            {renamingFolderId === folder.id ? (
              <form
                onSubmit={(e) => { e.preventDefault(); commitRenameFolder(folder.id) }}
                className="flex-1"
              >
                <input
                  autoFocus
                  value={renameFolderValue}
                  onChange={(e) => setRenameFolderValue(e.target.value)}
                  onBlur={() => commitRenameFolder(folder.id)}
                  onKeyDown={(e) => e.key === 'Escape' && setRenamingFolderId(null)}
                  className="rounded border border-gray-300 px-2 py-0.5 text-sm font-semibold text-graphite focus:outline-none focus:ring-1 focus:ring-gray-400"
                />
              </form>
            ) : (
              <button
                onClick={() => toggleCollapse(folder.id)}
                disabled={isSearchActive}
                className={`flex-1 text-left text-sm font-semibold ${nameMatchedHere ? 'text-p-blue-dark' : 'text-graphite'} disabled:cursor-default`}
              >
                {folder.name}
              </button>
            )}
            <div ref={folderMenuOpen === folder.id || movingFolderId === folder.id ? folderMenuRef : undefined} className="relative">
              <button
                onClick={() => setFolderMenuOpen(folderMenuOpen === folder.id ? null : folder.id)}
                className={`rounded p-1.5 text-gray-400 hover:bg-gray-200/60 ${folderMenuOpen === folder.id ? 'bg-gray-200/60 text-gray-600' : ''}`}
                title="Folder options"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {folderMenuOpen === folder.id && (
                <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                  <button
                    onClick={() => startRenameFolder(folder)}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-beige"
                  >
                    <Pencil className="h-4 w-4 text-gray-400" />
                    Rename
                  </button>
                  <button
                    onClick={() => {
                      setFolderMenuOpen(null)
                      setCreatingFolderParent(folder.id)
                      setNewFolderName('')
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-beige"
                  >
                    <FolderPlus className="h-4 w-4 text-gray-400" />
                    New subfolder
                  </button>
                  <button
                    onClick={() => { setFolderMenuOpen(null); handleCreate(folder.id) }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-beige"
                  >
                    <Plus className="h-4 w-4 text-gray-400" />
                    New workflow here
                  </button>
                  <button
                    onClick={() => { setFolderMenuOpen(null); setMovingFolderId(folder.id) }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-beige"
                  >
                    <FolderInput className="h-4 w-4 text-gray-400" />
                    Move to folder…
                  </button>
                  <div className="my-1 border-t border-gray-100" />
                  <button
                    onClick={() => handleDeleteFolder(folder)}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </button>
                </div>
              )}
              {movingFolderId === folder.id && (
                <div ref={folderMoveMenuRef} className="absolute right-0 top-full z-50 mt-1 w-60 rounded-lg border border-gray-200 bg-white shadow-lg">
                  <FolderPickerList
                    onPick={(parentId) => handleMoveFolder(folder.id, parentId)}
                    excludeId={folder.id}
                  />
                </div>
              )}
            </div>
          </div>
        </td>
      </tr>
    )
  }

  function renderFolderGroup(folder: Folder, depth: number, ancestorMatched = false): React.ReactNode[] {
    if (isSearchActive && !visibleFolders.has(folder.id)) return []
    const isCollapsed = collapsed.has(folder.id)
    const expanded = isSearchActive ? true : !isCollapsed
    const nameMatchedHere = ancestorMatched || (isSearchActive && folderNameMatches.has(folder.id))
    const rows: React.ReactNode[] = []

    rows.push(
      <FolderHeaderRow
        key={`folder-${folder.id}`}
        folder={folder}
        depth={depth}
        nameMatchedHere={nameMatchedHere}
        expanded={expanded}
        isCollapsed={isCollapsed}
      />
    )

    if (expanded) {
      if (!isSearchActive && creatingFolderParent === folder.id) {
        rows.push(renderInlineCreateFolderRow(folder.id, depth + 1))
      }
      const childWorkflows = workflowsByFolder.get(folder.id) ?? []
      for (const wf of childWorkflows) {
        if (isSearchActive && !nameMatchedHere && !workflowMatches.has(wf.id)) continue
        rows.push(<WorkflowRow key={wf.id} wf={wf} depth={depth + 1} ancestorMatched={nameMatchedHere} />)
      }
      const subs = (childFoldersByParent.get(folder.id) ?? []).slice().sort(compareFolders)
      for (const sub of subs) {
        rows.push(...renderFolderGroup(sub, depth + 1, nameMatchedHere))
      }
    }

    return rows
  }

  function RootDropRow() {
    const { setNodeRef, isOver } = useDroppableFolder('drop:root', { kind: 'root' })
    return (
      <tr ref={setNodeRef} className={isOver ? 'bg-p-blue-light/60 ring-2 ring-inset ring-p-blue-dark' : 'bg-gray-50/40'}>
        <td colSpan={5} className="px-4 py-1.5 text-center text-xs text-gray-400">
          Drop here to move out of any folder
        </td>
      </tr>
    )
  }

  function renderRows(): React.ReactNode {
    const rootWorkflows = workflowsByFolder.get(ROOT) ?? []
    const rootFolders = (childFoldersByParent.get(ROOT) ?? []).slice().sort(compareFolders)
    return (
      <>
        {isAnyDragging && <RootDropRow />}
        {!isSearchActive && creatingFolderParent === null && renderInlineCreateFolderRow(null, 0)}
        {rootWorkflows.map((wf) => {
          if (isSearchActive && !workflowMatches.has(wf.id)) return null
          return <WorkflowRow key={wf.id} wf={wf} depth={0} ancestorMatched={false} />
        })}
        {rootFolders.map((f) => renderFolderGroup(f, 0, false))}
      </>
    )
  }

  return (
    <NavLayout>
      <div className="p-8">
        <div className="mb-6 flex items-center gap-4">
          <h1 className="text-3xl font-bold text-graphite">Workflows</h1>
          <div className="flex flex-1 items-center justify-end gap-3">
            {/* Search */}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && firstMatchId) router.push(`/workflows/${firstMatchId}`)
                  if (e.key === 'Escape') { setSearchQuery(''); searchRef.current?.blur() }
                }}
                placeholder="Search… /"
                className="h-8 w-44 rounded-lg border border-gray-200 bg-white pl-8 pr-7 text-sm text-gray-700 placeholder-gray-400 transition-[width] duration-200 focus:w-64 focus:outline-none focus:ring-1 focus:ring-p-blue-dark"
              />
              {searchQuery && (
                <button
                  onClick={() => { setSearchQuery(''); searchRef.current?.focus() }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <button
              onClick={() => {
                setCreatingFolderParent(null)
                setNewFolderName('')
              }}
              className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 hover:bg-beige"
              title="New folder"
            >
              <FolderPlus className="h-4 w-4" />
              New folder
            </button>
            <button
              onClick={() => handleCreate()}
              disabled={creating}
              className="flex items-center gap-2 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#3A8FD0] disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              {creating ? 'Creating…' : 'New Workflow'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="rounded-xl border border-gray-200 bg-white">
            <table className="w-full">
              <tbody className="divide-y divide-gray-100">
                {[...Array(4)].map((_, i) => (
                  <tr key={i}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Skeleton className="h-2.5 w-2.5 rounded-full" />
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="h-5 w-14 rounded-full" />
                      </div>
                    </td>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-20" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-6 w-6" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : workflows.length === 0 && folders.length === 0 ? (
          <div className="flex flex-col items-center py-20 text-center">
            {/* Mini workflow diagram */}
            <svg width="100" height="122" viewBox="0 0 100 122" fill="none" aria-hidden="true" className="mb-8">
              <rect x="10" y="0" width="80" height="26" rx="5" fill="#eef2ff" stroke="#a5b4fc" strokeWidth="1"/>
              <text x="50" y="17" textAnchor="middle" fill="#4338ca" fontSize="8" fontWeight="700" fontFamily="ui-sans-serif,system-ui,sans-serif" letterSpacing="1">TRIGGER</text>
              <circle cx="50" cy="26" r="2.5" fill="#a5b4fc"/>
              <line x1="50" y1="28.5" x2="50" y2="45.5" stroke="#e0e7ff" strokeWidth="1.5"/>
              <circle cx="50" cy="48" r="2.5" fill="#93c5fd"/>
              <rect x="10" y="50" width="80" height="26" rx="5" fill="#eff6ff" stroke="#93c5fd" strokeWidth="1"/>
              <text x="50" y="67" textAnchor="middle" fill="#2563eb" fontSize="8" fontWeight="700" fontFamily="ui-sans-serif,system-ui,sans-serif" letterSpacing="1">FILTER</text>
              <circle cx="50" cy="76" r="2.5" fill="#93c5fd"/>
              <line x1="50" y1="78.5" x2="50" y2="93.5" stroke="#d1fae5" strokeWidth="1.5"/>
              <circle cx="50" cy="96" r="2.5" fill="#86efac"/>
              <rect x="10" y="98" width="80" height="26" rx="5" fill="#f0fdf4" stroke="#86efac" strokeWidth="1"/>
              <text x="50" y="115" textAnchor="middle" fill="#15803d" fontSize="8" fontWeight="700" fontFamily="ui-sans-serif,system-ui,sans-serif" letterSpacing="1">RESPOND</text>
            </svg>

            <h2 className="text-xl font-bold text-graphite">Build your first workflow</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-gray-400">
              Connect a trigger to filters, decisions, and API calls. Automate what happens when a lead comes in.
            </p>
            <button
              onClick={() => handleCreate()}
              disabled={creating}
              className="mt-6 rounded-lg bg-p-blue-dark px-5 py-2.5 text-sm font-medium text-white hover:bg-[#3A8FD0] disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'New workflow'}
            </button>
          </div>
        ) : (
          <FolderDndProvider
            onDragStart={() => setIsAnyDragging(true)}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setIsAnyDragging(false)}
          >
          <div className="rounded-xl border border-gray-200 bg-white">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col className="w-8" />
                <col />
                <col className="w-52" />
                <col className="w-44" />
                <col className="w-16" />
              </colgroup>
              <thead className="border-b border-gray-100 bg-beige">
                <tr>
                  <th className="rounded-tl-xl w-8 px-2 py-3" />
                  <th className="px-4 py-3 text-left">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-gray-500">Name</span>
                      {folders.length > 0 && (
                        <button
                          onClick={() => setFolderSort((s) => (s === 'mru' ? 'name' : 'mru'))}
                          title={folderSort === 'mru' ? 'Folders sorted by most recently used. Click to sort by name.' : 'Folders sorted by name. Click to sort by most recently used.'}
                          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium transition-colors ${
                            folderSort === 'name'
                              ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
                              : 'bg-p-blue-light text-p-blue-dark'
                          }`}
                        >
                          <FolderIcon className="h-3 w-3" />
                          {folderSort === 'mru' ? 'Recent' : 'A–Z'}
                        </button>
                      )}
                    </div>
                  </th>
                  <th className="px-4 py-3 text-left">
                    <button
                      onClick={toggleSort}
                      title={sortMode === 'health' ? 'Sorted by health. Click to sort by last modified.' : 'Sorted by last modified. Click to sort by health (failing first).'}
                      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold transition-colors ${
                        sortMode === 'health'
                          ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
                          : 'bg-p-blue-light text-p-blue-dark'
                      }`}
                    >
                      <ArrowUpDown className="h-3 w-3" />
                      {sortMode === 'health' ? 'Health' : 'Last modified'}
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Modified by</th>
                  <th className="rounded-tr-xl px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {renderRows()}
              </tbody>
            </table>
            {isSearchActive && !firstMatchId && (
              <div className="px-4 py-8 text-center text-sm text-gray-400">
                No workflows match <span className="font-medium text-gray-600">&quot;{searchQuery}&quot;</span>
              </div>
            )}
          </div>
          </FolderDndProvider>
        )}
      </div>
    </NavLayout>
  )
}

