'use client'

import { useCallback, useState } from 'react'
import {
  PANEL_KINDS,
  clampPanelWidth,
  panelWidthStorageKey,
  readStoredPanelWidth,
  type PanelKind,
} from '@/lib/panel-widths'

/**
 * Holds one remembered width per canvas side-panel kind (#719), persisted so a
 * panel reopens at the width it was left at. Resizing one kind leaves the others
 * untouched, which is the whole point: they used to share a single value.
 */
export interface PanelWidths {
  widthFor: (kind: PanelKind) => number
  /** Returns the resize handler for one kind, shaped for a panel's `onResize`. */
  setWidthFor: (kind: PanelKind) => (width: number) => void
}

type WidthMap = Record<PanelKind, number>

function initialWidths(): WidthMap {
  const storage = typeof window === 'undefined' ? null : window.localStorage
  const widths = {} as WidthMap
  for (const kind of PANEL_KINDS) {
    widths[kind] = readStoredPanelWidth(kind, storage)
  }
  return widths
}

export function usePanelWidths(): PanelWidths {
  const [widths, setWidths] = useState<WidthMap>(initialWidths)

  const widthFor = useCallback((kind: PanelKind) => widths[kind], [widths])

  const setWidthFor = useCallback(
    (kind: PanelKind) => (width: number) => {
      const clamped = clampPanelWidth(width)
      // A non-finite width would render as `width: NaNpx`. Refuse it and keep
      // whatever the panel already had.
      if (clamped === null) return
      setWidths((prev) => (prev[kind] === clamped ? prev : { ...prev, [kind]: clamped }))
      if (typeof window === 'undefined') return
      try {
        window.localStorage.setItem(panelWidthStorageKey(kind), String(clamped))
      } catch {
        // Storage can throw when disabled; the width still applies for this session.
      }
    },
    [],
  )

  return { widthFor, setWidthFor }
}
