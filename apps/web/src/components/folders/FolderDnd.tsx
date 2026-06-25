'use client'

// Shared DnD primitives for folder-organized tables (workflows, env vars).
// Wraps @dnd-kit/core with a pointer-sensor activation distance that lets
// click-on-button interactions still fire without triggering a drag, plus a
// drag-handle component that fades in on row hover (per the agreed UX).

import { DndContext, PointerSensor, pointerWithin, useSensor, useSensors, useDraggable, useDroppable } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { Folder as FolderIcon, GripVertical, Search, X } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'

export type { DragEndEvent }

// Drag activation distance — 8px is enough to absorb tiny pointer jitter
// during a click on the chevron / ⋯ menu while still feeling responsive.
const DRAG_ACTIVATION_DISTANCE = 8

export function FolderDndProvider({
  onDragStart,
  onDragEnd,
  onDragCancel,
  children,
}: {
  onDragStart?: () => void
  onDragEnd: (event: DragEndEvent) => void
  onDragCancel?: () => void
  children: ReactNode
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE } })
  )
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {children}
    </DndContext>
  )
}

export function useDraggableRow<T extends Record<string, unknown>>(id: string, data: T) {
  return useDraggable({ id, data })
}

export function useDroppableFolder<T extends Record<string, unknown>>(id: string, data: T) {
  return useDroppable({ id, data })
}

// Inline create-folder row. Owns its input state locally so typing doesn't
// re-render the parent page (and trigger expensive dnd-kit re-measurement
// across every row in the table). Parent only learns about the value on
// submit/cancel via the callbacks.
export function InlineFolderCreate({
  parentId,
  paddingLeft,
  colSpan,
  leadingTd,
  onSubmit,
  onCancel,
}: {
  parentId: string | null
  paddingLeft: number
  colSpan: number
  // True if the table has a leading drag-handle column that needs a placeholder cell.
  leadingTd?: boolean
  onSubmit: (name: string, parentId: string | null) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  function submit() {
    const trimmed = name.trim()
    if (!trimmed) {
      onCancel()
      return
    }
    onSubmit(trimmed, parentId)
  }
  return (
    <tr className="bg-blue-50/40">
      {leadingTd && <td className="w-8 px-2 py-2" />}
      <td colSpan={colSpan} className="px-4 py-2" style={{ paddingLeft: `${paddingLeft}px` }}>
        <form onSubmit={(e) => { e.preventDefault(); submit() }} className="flex items-center gap-2">
          <FolderIcon className="h-4 w-4 text-gray-500" />
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={submit}
            onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}
            placeholder="Folder name"
            className="flex-1 rounded border border-gray-300 px-2 py-0.5 text-sm font-medium text-graphite focus:outline-none focus:ring-1 focus:ring-gray-400"
          />
        </form>
      </td>
    </tr>
  )
}

// Inline rename input. Owns its value locally so typing doesn't re-render
// the parent page. Commits on form submit, Enter, or blur; cancels on Escape.
export function InlineRenameInput({
  initialValue,
  onCommit,
  onCancel,
  className,
  trailing,
}: {
  initialValue: string
  onCommit: (value: string) => void
  onCancel: () => void
  className?: string
  trailing?: ReactNode
}) {
  const [value, setValue] = useState(initialValue)
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onCommit(value) }}
      className="flex items-center gap-1.5"
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onCommit(value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}
        className={className}
      />
      {trailing}
    </form>
  )
}

// Search input. Owns the visible value locally; debounces propagation to the
// parent so typing doesn't re-render the (potentially expensive) table on
// every keystroke. Exposes imperative focus/blur/clear via ref so the parent
// can wire `/` and ⌘K shortcuts.
export interface SearchInputHandle {
  focus: () => void
  blur: () => void
  clear: () => void
}

export const SearchInput = forwardRef<SearchInputHandle, {
  onChange: (query: string) => void
  onEnter?: (query: string) => void
  placeholder?: string
  debounceMs?: number
}>(function SearchInput({ onChange, onEnter, placeholder = 'Search… /', debounceMs = 80 }, ref) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    blur: () => inputRef.current?.blur(),
    clear: () => { setValue(''); onChange('') },
  }))

  // Debounce upstream propagation. Empty value flushes immediately so the
  // table un-filters as soon as the user clears the input.
  useEffect(() => {
    if (value === '' || debounceMs === 0) {
      onChange(value)
      return
    }
    const t = setTimeout(() => onChange(value), debounceMs)
    return () => clearTimeout(t)
  }, [value, debounceMs, onChange])

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { onEnter?.(value); return }
          if (e.key === 'Escape') { setValue(''); inputRef.current?.blur() }
        }}
        placeholder={placeholder}
        className="h-8 w-44 rounded-lg border border-gray-200 bg-white pl-8 pr-7 text-sm text-gray-700 placeholder-gray-400 transition-[width] duration-200 focus:w-64 focus:outline-none focus:ring-1 focus:ring-p-blue-dark"
      />
      {value && (
        <button
          onClick={() => { setValue(''); inputRef.current?.focus() }}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
})

export function DragHandle({
  attributes,
  listeners,
  isDragging,
}: {
  attributes: ReturnType<typeof useDraggable>['attributes']
  listeners: ReturnType<typeof useDraggable>['listeners']
  isDragging?: boolean
}) {
  return (
    <button
      type="button"
      {...attributes}
      {...listeners}
      className={`cursor-grab text-gray-300 transition-opacity hover:text-gray-500 active:cursor-grabbing ${
        isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
      }`}
      title="Drag to move"
      aria-label="Drag to move"
    >
      <GripVertical className="h-3.5 w-3.5" />
    </button>
  )
}
