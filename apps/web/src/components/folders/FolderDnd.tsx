'use client'

// Shared DnD primitives for folder-organized tables (workflows, env vars).
// Wraps @dnd-kit/core with a pointer-sensor activation distance that lets
// click-on-button interactions still fire without triggering a drag, plus a
// drag-handle component that fades in on row hover (per the agreed UX).

import { DndContext, PointerSensor, pointerWithin, useSensor, useSensors, useDraggable, useDroppable } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { GripVertical } from 'lucide-react'
import type { ReactNode } from 'react'

export type { DragEndEvent }

// Drag activation distance — 8px is enough to absorb tiny pointer jitter
// during a click on the chevron / ⋯ menu while still feeling responsive.
const DRAG_ACTIVATION_DISTANCE = 8

export function FolderDndProvider({
  onDragEnd,
  children,
}: {
  onDragEnd: (event: DragEndEvent) => void
  children: ReactNode
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE } })
  )
  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd}>
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
