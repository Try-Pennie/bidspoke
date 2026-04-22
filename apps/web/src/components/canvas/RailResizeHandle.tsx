'use client'

import { useCallback } from 'react'

const MIN_WIDTH = 280
const MAX_WIDTH = 800

interface Props {
  width: number
  onResize: (width: number) => void
}

export default function RailResizeHandle({ width, onResize }: Props) {
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = width

      function onMove(ev: MouseEvent) {
        const delta = startX - ev.clientX
        const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta))
        onResize(next)
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'ew-resize'
      document.body.style.userSelect = 'none'
    },
    [width, onResize]
  )

  return (
    <div
      onMouseDown={handleMouseDown}
      className="absolute inset-y-0 left-0 z-10 w-1 cursor-ew-resize bg-transparent transition-colors hover:bg-p-blue-dark"
      title="Drag to resize"
    />
  )
}
