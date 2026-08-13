'use client'

import { useCallback } from 'react'
import { PANEL_MAX_WIDTH as MAX_WIDTH, PANEL_MIN_WIDTH as MIN_WIDTH } from '@/lib/panel-widths'

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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const STEP = 16
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        onResize(Math.min(MAX_WIDTH, width + STEP))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        onResize(Math.max(MIN_WIDTH, width - STEP))
      }
    },
    [width, onResize]
  )

  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- WAI-ARIA window-splitter pattern: a focusable role="separator" with aria-valuenow + arrow-key handler is intentionally keyboard-operable; jsx-a11y treats separator as non-interactive and doesn't model the splitter pattern */
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      className="absolute inset-y-0 left-0 z-10 w-1 cursor-ew-resize bg-transparent transition-colors hover:bg-p-blue-dark focus-visible:bg-p-blue-dark focus-visible:outline-none"
      title="Drag to resize"
    />
  )
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}
