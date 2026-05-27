'use client'

// Shared DnD primitives for folder-organized tables (workflows, env vars).
// Wraps @dnd-kit/core with a pointer-sensor activation distance that lets
// click-on-button interactions still fire without triggering a drag, plus a
// drag-handle component that fades in on row hover (per the agreed UX).

import { DndContext, PointerSensor, pointerWithin, useSensor, useSensors, useDraggable, useDroppable } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { Folder as FolderIcon, GripVertical } from 'lucide-react'
import { useState, type ReactNode } from 'react'

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
          <FolderIcon className="h-4 w-4 text-gray-400" />
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
