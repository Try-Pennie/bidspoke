'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import type { EnvVar, EnvVarFolder } from '@/types/workflow'
import {
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Loader2,
  Search,
  X,
  MoreHorizontal,
  Folder as FolderIcon,
  FolderPlus,
  FolderInput,
  ChevronRight,
  ChevronDown,
  Pencil,
} from 'lucide-react'
import { formatDatetime } from '@/lib/dates'
import { Skeleton } from '@/components/ui/Skeleton'
import { FolderDndProvider, useDraggableRow, useDroppableFolder, DragHandle, InlineFolderCreate } from '@/components/folders/FolderDnd'
import type { DragEndEvent } from '@/components/folders/FolderDnd'

type NewVar = { key: string; value: string; is_secret: boolean }

const ROOT = '__root__'

export default function EnvPage() {
  const [vars, setVars] = useState<EnvVar[]>([])
  const [folders, setFolders] = useState<EnvVarFolder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Add-variable form
  const [showForm, setShowForm] = useState(false)
  const [newVar, setNewVar] = useState<NewVar>({ key: '', value: '', is_secret: false })
  const [creating, setCreating] = useState(false)
  const [formFolderId, setFormFolderId] = useState<string | null>(null)
  const keyInputRef = useRef<HTMLInputElement | null>(null)

  // Secret reveal
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({})
  const [revealing, setRevealing] = useState<Set<string>>(new Set())
  const [revealUnavailable, setRevealUnavailable] = useState<Set<string>>(new Set())

  // Inline delete confirm
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const removeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  // Folders
  const [folderSort, setFolderSort] = useState<'mru' | 'name'>('mru')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [folderMenuOpen, setFolderMenuOpen] = useState<string | null>(null)
  const folderMenuRef = useRef<HTMLDivElement>(null)
  const [creatingFolderParent, setCreatingFolderParent] = useState<string | null | undefined>(undefined)
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renameFolderValue, setRenameFolderValue] = useState('')
  const [movingVarId, setMovingVarId] = useState<string | null>(null)
  const moveMenuRef = useRef<HTMLDivElement>(null)
  const [movingFolderId, setMovingFolderId] = useState<string | null>(null)
  const folderMoveMenuRef = useRef<HTMLDivElement>(null)
  const [rowMenuOpen, setRowMenuOpen] = useState<string | null>(null)
  const rowMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (showForm) {
      const frame = requestAnimationFrame(() => keyInputRef.current?.focus())
      return () => cancelAnimationFrame(frame)
    }
  }, [showForm])

  useEffect(() => {
    Promise.all([api.env.list(), api.envFolders.list()])
      .then(([vs, fs]) => {
        setVars(vs)
        setFolders(fs)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    try {
      const raw = localStorage.getItem('bidspoke:env-folders:collapsed')
      if (raw) setCollapsed(new Set(JSON.parse(raw) as string[]))
    } catch {
      // ignore
    }
  }, [])

  // Search keyboard shortcuts
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

  // Close menus on outside click
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

  useEffect(() => {
    if (!rowMenuOpen) return
    function handler(e: MouseEvent) {
      if (rowMenuRef.current && !rowMenuRef.current.contains(e.target as globalThis.Node)) {
        setRowMenuOpen(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [rowMenuOpen])

  useEffect(() => {
    if (!movingVarId && !movingFolderId) return
    function handler(e: MouseEvent) {
      const inVar = moveMenuRef.current?.contains(e.target as globalThis.Node)
      const inFolder = folderMoveMenuRef.current?.contains(e.target as globalThis.Node)
      if (!inVar && !inFolder) {
        setMovingVarId(null)
        setMovingFolderId(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [movingVarId, movingFolderId])

  function toggleCollapse(folderId: string) {
    setCollapsed((s) => {
      const next = new Set(s)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      try { localStorage.setItem('bidspoke:env-folders:collapsed', JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }

  // ============================================================
  // Tree maps + search match propagation
  // ============================================================

  const childFoldersByParent = useMemo(() => {
    const map = new Map<string, EnvVarFolder[]>()
    for (const f of folders) {
      const key = f.parent_id ?? ROOT
      const arr = map.get(key) ?? []
      arr.push(f)
      map.set(key, arr)
    }
    return map
  }, [folders])

  const varsByFolder = useMemo(() => {
    const map = new Map<string, EnvVar[]>()
    for (const v of vars) {
      const key = v.folder_id ?? ROOT
      const arr = map.get(key) ?? []
      arr.push(v)
      map.set(key, arr)
    }
    return map
  }, [vars])

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

  function folderName(id: string): string {
    return folders.find((f) => f.id === id)?.name ?? ''
  }

  function folderMru(folderId: string): number {
    let max = 0
    const folder = folders.find((f) => f.id === folderId)
    if (folder) max = new Date(folder.updated_at).getTime()
    const ids = [folderId, ...(descendantsOf.get(folderId) ?? [])]
    for (const id of ids) {
      for (const v of varsByFolder.get(id) ?? []) {
        const t = new Date(v.updated_at).getTime()
        if (t > max) max = t
      }
    }
    return max
  }

  function compareFolders(a: EnvVarFolder, b: EnvVarFolder): number {
    if (folderSort === 'name') return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    return folderMru(b.id) - folderMru(a.id)
  }

  const isSearchActive = searchQuery.length > 0
  const q = searchQuery.toLowerCase()

  // Search match propagation:
  //   varMatches:        var.key contains q
  //   folderNameMatches: folder.name contains q (treats every descendant as a "match group")
  //   visibleFolders:    folder is shown in the search view (own name matches OR a descendant matches)
  //   ancestorIsMatched: for an item, is any ancestor folder a name-match?
  const { varMatches, folderNameMatches, visibleFolders } = useMemo(() => {
    if (!isSearchActive) {
      return { varMatches: new Set<string>(), folderNameMatches: new Set<string>(), visibleFolders: new Set<string>() }
    }
    const vm = new Set<string>()
    for (const v of vars) if (v.key.toLowerCase().includes(q)) vm.add(v.id)
    const fnm = new Set<string>()
    for (const f of folders) if (f.name.toLowerCase().includes(q)) fnm.add(f.id)

    // Visible = folder name matches OR any descendant folder name matches OR any var in self/descendants matches
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
        for (const v of varsByFolder.get(id) ?? []) {
          if (vm.has(v.id)) {
            vis.add(f.id)
            break
          }
        }
      }
    }
    // Also visible: any ancestor of a visible folder needs to be visible too
    for (const f of folders) {
      if (vis.has(f.id) && f.parent_id) {
        let p: string | null = f.parent_id
        while (p) {
          vis.add(p)
          p = folders.find((x) => x.id === p)?.parent_id ?? null
        }
      }
    }
    return { varMatches: vm, folderNameMatches: fnm, visibleFolders: vis }
  }, [isSearchActive, q, vars, folders, descendantsOf, varsByFolder])

  // True if any ancestor of this folder (or the folder itself) has its name in folderNameMatches.
  function isInNameMatchedFolder(folderId: string | null): boolean {
    if (!folderId || !isSearchActive) return false
    let cursor: string | null = folderId
    while (cursor) {
      if (folderNameMatches.has(cursor)) return true
      cursor = folders.find((x) => x.id === cursor)?.parent_id ?? null
    }
    return false
  }

  // ============================================================
  // Handlers
  // ============================================================

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!newVar.key) return
    setCreating(true)
    try {
      const created = await api.env.create({ ...newVar, folder_id: formFolderId })
      setVars((vs) => [...vs, created])
      setNewVar({ key: '', value: '', is_secret: false })
      setShowForm(false)
      setFormFolderId(null)
      if (formFolderId && collapsed.has(formFolderId)) {
        // Make sure the destination folder is expanded so the new var shows
        setCollapsed((s) => {
          const next = new Set(s)
          next.delete(formFolderId)
          try { localStorage.setItem('bidspoke:env-folders:collapsed', JSON.stringify([...next])) } catch { /* ignore */ }
          return next
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create')
    } finally {
      setCreating(false)
    }
  }

  function requestDelete(id: string) {
    setRowMenuOpen(null)
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
    const item = vars.find((v) => v.id === id)
    setRemovingId(id)
    removeTimerRef.current = setTimeout(() => {
      setVars((vs) => vs.filter((v) => v.id !== id))
      setRemovingId(null)
    }, 150)
    try {
      await api.env.delete(id)
    } catch (err) {
      if (removeTimerRef.current) clearTimeout(removeTimerRef.current)
      setRemovingId(null)
      if (item) setVars((vs) => vs.find((v) => v.id === id) ? vs : [...vs, item])
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  async function handleCreateFolder(name: string, parent_id: string | null) {
    setCreatingFolderParent(undefined)
    try {
      const folder = await api.envFolders.create(name, parent_id)
      setFolders((fs) => [...fs, folder])
      if (parent_id) {
        setCollapsed((s) => {
          if (!s.has(parent_id)) return s
          const next = new Set(s)
          next.delete(parent_id)
          try { localStorage.setItem('bidspoke:env-folders:collapsed', JSON.stringify([...next])) } catch { /* ignore */ }
          return next
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder')
    }
  }

  function startRenameFolder(folder: EnvVarFolder) {
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
      await api.envFolders.update(id, { name: trimmed })
    } catch (err) {
      setFolders((fs) => fs.map((f) => (f.id === id ? original : f)))
      setError(err instanceof Error ? err.message : 'Failed to rename folder')
    }
  }

  async function handleDeleteFolder(folder: EnvVarFolder) {
    setFolderMenuOpen(null)
    try {
      await api.envFolders.delete(folder.id)
      setFolders((fs) => fs.filter((f) => f.id !== folder.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete folder')
    }
  }

  async function handleMoveVar(varId: string, folderId: string | null) {
    setMovingVarId(null)
    setRowMenuOpen(null)
    const original = vars.find((v) => v.id === varId)
    if (!original || original.folder_id === folderId) return
    setVars((vs) => vs.map((v) => (v.id === varId ? { ...v, folder_id: folderId } : v)))
    if (folderId && collapsed.has(folderId)) {
      setCollapsed((s) => {
        const next = new Set(s)
        next.delete(folderId)
        try { localStorage.setItem('bidspoke:env-folders:collapsed', JSON.stringify([...next])) } catch { /* ignore */ }
        return next
      })
    }
    try {
      await api.env.setFolder(varId, folderId)
    } catch (err) {
      setVars((vs) => vs.map((v) => (v.id === varId ? original : v)))
      setError(err instanceof Error ? err.message : 'Failed to move variable')
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
        try { localStorage.setItem('bidspoke:env-folders:collapsed', JSON.stringify([...next])) } catch { /* ignore */ }
        return next
      })
    }
    try {
      await api.envFolders.update(folderId, { parent_id: parentId })
    } catch (err) {
      setFolders((fs) => fs.map((f) => (f.id === folderId ? original : f)))
      setError(err instanceof Error ? err.message : 'Failed to move folder')
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const activeKind = (active.data.current?.kind as 'var' | 'folder' | undefined) ?? undefined
    const overKind = (over.data.current?.kind as 'folder' | 'root' | undefined) ?? undefined
    if (!activeKind || !overKind) return

    const activeId = String(active.id).replace(/^(var|folder):/, '')
    const overId = overKind === 'root' ? null : String(over.id).replace(/^drop:/, '')

    if (activeKind === 'var') {
      handleMoveVar(activeId, overId)
    } else if (activeKind === 'folder') {
      handleMoveFolder(activeId, overId)
    }
  }

  function openNewVariableInFolder(folderId: string | null) {
    setFolderMenuOpen(null)
    setFormFolderId(folderId)
    setShowForm(true)
  }

  // ============================================================
  // Render helpers
  // ============================================================

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
      <InlineFolderCreate
        key={`create-folder-${parentId ?? 'root'}`}
        parentId={parentId}
        paddingLeft={indentPx(depth)}
        colSpan={5}
        leadingTd
        onSubmit={(name, pid) => handleCreateFolder(name, pid)}
        onCancel={() => setCreatingFolderParent(undefined)}
      />
    )
  }

  function VarRow({ v, depth, ancestorMatched }: { v: EnvVar; depth: number; ancestorMatched: boolean }) {
    const isMatch = !isSearchActive || varMatches.has(v.id) || ancestorMatched
    const dimmed = isSearchActive && !isMatch
    const dragId = `var:${v.id}`
    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggableRow(dragId, { kind: 'var' })
    const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, opacity: 0.6 } : undefined

    return (
      <tr
        ref={setNodeRef}
        style={style}
        className={[
          'group env-row transition-opacity duration-150 hover:bg-beige',
          removingId === v.id ? 'opacity-0 -translate-y-1' : '',
          dimmed ? 'opacity-20 pointer-events-none select-none' : '',
        ].filter(Boolean).join(' ')}
      >
        <td className="w-8 px-2 py-3 align-middle">
          <DragHandle attributes={attributes} listeners={listeners} isDragging={isDragging} />
        </td>
        <td
          className="px-4 py-3 font-mono text-xs font-medium text-graphite whitespace-nowrap"
          style={depth > 0 ? { paddingLeft: `${indentPx(depth)}px` } : undefined}
        >
          {v.key}
        </td>
        <td className="px-4 py-3 font-mono text-xs text-gray-500">
          {v.is_secret ? (
            <div className="flex items-center gap-1.5">
              {revealUnavailable.has(v.id)
                ? <span className="font-sans text-gray-400 italic">Rotate to enable reveal</span>
                : <span>{revealedValues[v.id] ?? '••••••••'}</span>
              }
              {revealedValues[v.id] ? (
                <button
                  type="button"
                  onClick={() => setRevealedValues((prev) => { const next = { ...prev }; delete next[v.id]; return next })}
                  className="text-gray-300 hover:text-gray-500"
                >
                  <EyeOff className="h-3.5 w-3.5" />
                </button>
              ) : revealing.has(v.id) ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-300" />
              ) : revealUnavailable.has(v.id) ? null : (
                <button
                  type="button"
                  onClick={async () => {
                    setRevealing((s) => new Set([...s, v.id]))
                    try {
                      const { value } = await api.env.reveal(v.id)
                      setRevealedValues((prev) => ({ ...prev, [v.id]: value }))
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : ''
                      if (msg.includes('422')) {
                        setRevealUnavailable((s) => new Set([...s, v.id]))
                      } else {
                        setError(msg || 'Failed to reveal')
                      }
                    } finally {
                      setRevealing((s) => { const next = new Set(s); next.delete(v.id); return next })
                    }
                  }}
                  className="text-gray-300 hover:text-gray-500"
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ) : (
            v.value ?? '—'
          )}
        </td>
        <td className="px-4 py-3">
          <span
            className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
              v.is_secret ? 'bg-orange-50 text-orange-700' : 'bg-gray-100 text-gray-600'
            }`}
          >
            {v.is_secret ? 'Secret' : 'Plain'}
          </span>
        </td>
        <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
          {formatDatetime(v.updated_at)}
        </td>
        <td className="relative px-4 py-3">
          <div ref={rowMenuOpen === v.id || movingVarId === v.id ? rowMenuRef : undefined} className="relative">
            <button
              onClick={() => setRowMenuOpen(rowMenuOpen === v.id ? null : v.id)}
              className={`rounded p-1.5 text-gray-400 hover:bg-gray-100 ${confirmingDelete === v.id ? 'invisible pointer-events-none' : ''} ${rowMenuOpen === v.id ? 'bg-gray-100 text-gray-600' : ''}`}
              title="More options"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {confirmingDelete === v.id && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 whitespace-nowrap">
                <button
                  onClick={() => handleDelete(v.id)}
                  className="rounded bg-red-500 px-2 py-1 text-xs font-medium text-white hover:bg-red-600"
                >
                  Delete
                </button>
                <button onClick={cancelDelete} className="text-xs text-gray-400 hover:text-gray-600">
                  Cancel
                </button>
              </div>
            )}
            {rowMenuOpen === v.id && (
              <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                <button
                  onClick={() => { setRowMenuOpen(null); setMovingVarId(v.id) }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-beige"
                >
                  <FolderInput className="h-4 w-4 text-gray-400" />
                  Move to folder…
                </button>
                <div className="my-1 border-t border-gray-100" />
                <button
                  onClick={() => requestDelete(v.id)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </button>
              </div>
            )}
            {movingVarId === v.id && (
              <div ref={moveMenuRef} className="absolute right-0 top-full z-50 mt-1 w-60 rounded-lg border border-gray-200 bg-white shadow-lg">
                <FolderPickerList onPick={(folderId) => handleMoveVar(v.id, folderId)} />
              </div>
            )}
          </div>
        </td>
      </tr>
    )
  }

  function FolderHeaderRow({ folder, depth, ancestorMatched }: { folder: EnvVarFolder; depth: number; ancestorMatched: boolean }) {
    const isCollapsed = collapsed.has(folder.id)
    // When searching, always expand visible folders so matches are reachable
    const expanded = isSearchActive ? true : !isCollapsed
    const dropId = `drop:${folder.id}`
    const dragId = `folder:${folder.id}`
    const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggableRow(dragId, { kind: 'folder' })
    const { setNodeRef: setDropRef, isOver } = useDroppableFolder(dropId, { kind: 'folder' })
    const setRef = (el: HTMLTableRowElement | null) => {
      setDragRef(el)
      setDropRef(el)
    }
    const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, opacity: 0.6 } : undefined
    const nameMatched = isSearchActive && (folderNameMatches.has(folder.id) || ancestorMatched)

    return (
      <>
        <tr
          ref={setRef}
          style={style}
          className={`group bg-gray-50/70 hover:bg-gray-100/60 ${isOver ? 'bg-p-blue-light/60 ring-2 ring-inset ring-p-blue-dark' : ''}`}
        >
          <td className="w-8 px-2 py-2 align-middle">
            <DragHandle attributes={attributes} listeners={listeners} isDragging={isDragging} />
          </td>
          <td colSpan={5} className="px-4 py-2" style={{ paddingLeft: `${indentPx(depth)}px` }}>
            <div className="flex items-center gap-2">
              <button
                onClick={() => toggleCollapse(folder.id)}
                disabled={isSearchActive}
                className="rounded p-0.5 text-gray-400 hover:bg-gray-200/60 hover:text-gray-600 disabled:opacity-50"
                aria-label={isCollapsed ? 'Expand folder' : 'Collapse folder'}
              >
                {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              <FolderIcon className={`h-4 w-4 ${nameMatched ? 'text-p-blue-dark' : 'text-gray-400'}`} />
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
                  className={`flex-1 text-left text-sm font-semibold ${nameMatched ? 'text-p-blue-dark' : 'text-graphite'} disabled:cursor-default`}
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
                      onClick={() => { setFolderMenuOpen(null); setCreatingFolderParent(folder.id) }}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-beige"
                    >
                      <FolderPlus className="h-4 w-4 text-gray-400" />
                      New subfolder
                    </button>
                    <button
                      onClick={() => openNewVariableInFolder(folder.id)}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-beige"
                    >
                      <Plus className="h-4 w-4 text-gray-400" />
                      New variable here
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
      </>
    )
  }

  function renderFolderGroup(folder: EnvVarFolder, depth: number, ancestorMatched: boolean): React.ReactNode[] {
    if (isSearchActive && !visibleFolders.has(folder.id)) return []
    const rows: React.ReactNode[] = []
    const isCollapsed = collapsed.has(folder.id)
    const expanded = isSearchActive ? true : !isCollapsed
    const nameMatchedHere = ancestorMatched || (isSearchActive && folderNameMatches.has(folder.id))

    rows.push(<FolderHeaderRow key={`folder-${folder.id}`} folder={folder} depth={depth} ancestorMatched={ancestorMatched} />)

    if (!expanded) return rows

    if (!isSearchActive && creatingFolderParent === folder.id) {
      rows.push(renderInlineCreateFolderRow(folder.id, depth + 1))
    }

    const childVars = varsByFolder.get(folder.id) ?? []
    for (const v of childVars) {
      if (isSearchActive && !nameMatchedHere && !varMatches.has(v.id)) {
        // Hide non-matching items entirely when this folder isn't a name match
        // (cleaner than showing dimmed items in every visible folder during search)
        continue
      }
      rows.push(<VarRow key={v.id} v={v} depth={depth + 1} ancestorMatched={nameMatchedHere} />)
    }

    const subs = (childFoldersByParent.get(folder.id) ?? []).slice().sort(compareFolders)
    for (const sub of subs) {
      rows.push(...renderFolderGroup(sub, depth + 1, nameMatchedHere))
    }

    return rows
  }

  // Root drop zone — visible while dragging
  function RootDropRow() {
    const { setNodeRef, isOver } = useDroppableFolder('drop:root', { kind: 'root' })
    return (
      <tr ref={setNodeRef} className={isOver ? 'bg-p-blue-light/60 ring-2 ring-inset ring-p-blue-dark' : 'bg-gray-50/40'}>
        <td colSpan={6} className="px-4 py-1.5 text-center text-xs text-gray-400">
          Drop here to move out of any folder
        </td>
      </tr>
    )
  }

  function renderRows(isDragging: boolean): React.ReactNode {
    const rootVars = varsByFolder.get(ROOT) ?? []
    const rootFolders = (childFoldersByParent.get(ROOT) ?? []).slice().sort(compareFolders)

    return (
      <>
        {isDragging && <RootDropRow />}
        {!isSearchActive && creatingFolderParent === null && renderInlineCreateFolderRow(null, 0)}
        {rootVars.map((v) => {
          if (isSearchActive && !varMatches.has(v.id)) return null
          return <VarRow key={v.id} v={v} depth={0} ancestorMatched={false} />
        })}
        {rootFolders.map((f) => renderFolderGroup(f, 0, false))}
      </>
    )
  }

  // Track drag state for showing root drop zone
  const [isAnyDragging, setIsAnyDragging] = useState(false)

  return (
    <NavLayout>
      <div className="p-8">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-graphite">Environment Variables</h1>
            <p className="mt-1 text-sm text-gray-500">
              Available in workflows as <code className="rounded bg-gray-100 px-1 text-xs">{'{{env.KEY}}'}</code>
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* Search */}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setSearchQuery(''); searchRef.current?.blur() } }}
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
              onClick={() => setCreatingFolderParent(null)}
              className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 hover:bg-beige"
              title="New folder"
            >
              <FolderPlus className="h-4 w-4" />
              New folder
            </button>
            <button
              onClick={() => { setFormFolderId(null); setShowForm(true) }}
              className="flex items-center gap-2 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#3A8FD0]"
            >
              <Plus className="h-4 w-4" />
              Add variable
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Add form — animated slide open/closed */}
        <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${showForm ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="min-h-0 overflow-hidden">
            <form
              onSubmit={handleCreate}
              className="mb-6 rounded-xl border border-gray-200 bg-white p-4"
              inert={!showForm || undefined}
            >
              <h2 className="mb-4 text-sm font-medium text-gray-400">
                {formFolderId ? <>New variable <span className="text-gray-500">in {folderName(formFolderId)}</span></> : 'New variable'}
              </h2>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Key</label>
                  <input
                    ref={keyInputRef}
                    className="input w-full font-mono"
                    placeholder="MY_API_KEY"
                    value={newVar.key}
                    onChange={(e) => setNewVar({ ...newVar, key: e.target.value.toUpperCase().replace(/\s/g, '_') })}
                    onBlur={() => setNewVar((v) => ({ ...v, key: v.key.replace(/_+$/, '') }))}
                    required
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Value</label>
                  <input
                    type={newVar.is_secret ? 'password' : 'text'}
                    className="input w-full"
                    placeholder="value"
                    value={newVar.value}
                    onChange={(e) => setNewVar({ ...newVar, value: e.target.value })}
                  />
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is_secret"
                  checked={newVar.is_secret}
                  onChange={(e) => setNewVar({ ...newVar, is_secret: e.target.checked })}
                  className="rounded border-gray-300 text-p-blue-dark"
                />
                <label htmlFor="is_secret" className="text-xs text-gray-600">
                  Secret. Value encrypted and synced to Cloudflare Worker.
                </label>
              </div>
              <div className="mt-4 flex gap-2">
                <button
                  type="submit"
                  disabled={creating}
                  className="flex items-center gap-2 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#3A8FD0] disabled:opacity-50"
                >
                  {creating ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowForm(false); setFormFolderId(null) }}
                  className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-graphite"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>

        {loading ? (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <table className="w-full">
              <tbody className="divide-y divide-gray-100">
                {[...Array(3)].map((_, i) => (
                  <tr key={i}>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-32" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-48" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-5 w-12 rounded-full" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-6 w-6" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : vars.length === 0 && folders.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed border-gray-200 py-12 text-center">
            <p className="text-base font-semibold text-graphite">No variables yet</p>
            <p className="mx-auto mt-1.5 max-w-sm text-sm text-gray-400">
              Environment variables let workflows reference API keys and config values without hardcoding them. Reference them in any step as <code className="rounded bg-gray-100 px-1 text-xs">{'{{env.KEY}}'}</code>.
            </p>
            <button
              onClick={() => { setFormFolderId(null); setShowForm(true) }}
              className="mt-4 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#3A8FD0]"
            >
              Add your first variable
            </button>
          </div>
        ) : (
          <FolderDndProvider
            onDragStart={() => setIsAnyDragging(true)}
            onDragEnd={(e) => { setIsAnyDragging(false); handleDragEnd(e) }}
            onDragCancel={() => setIsAnyDragging(false)}
          >
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100 bg-beige">
                  <tr>
                    <th className="w-8 px-2 py-3" />
                    <th className="px-4 py-3 text-left">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-gray-500">Key</span>
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
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Value</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Type</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Last updated</th>
                    <th className="w-16 px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {renderRows(isAnyDragging)}
                </tbody>
              </table>
            </div>
          </FolderDndProvider>
        )}
      </div>
    </NavLayout>
  )
}

