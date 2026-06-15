import { describe, it, expect } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import {
  EMPTY_HISTORY,
  pushSnapshot,
  reduceUndo,
  reduceRedo,
  type HistoryModel,
  type CanvasSnapshot,
} from '../canvas-history'

// Minimal snapshots tagged by a node id so we can assert which one was restored.
function snap(tag: string): CanvasSnapshot {
  return { nodes: [{ id: tag, position: { x: 0, y: 0 }, data: {} } as Node], edges: [] as Edge[] }
}
const tagOf = (s: CanvasSnapshot) => s.nodes[0].id

describe('canvas history reducers (#94)', () => {
  it('pushSnapshot records an undo point and clears redo', () => {
    const start: HistoryModel = { past: [snap('a')], future: [snap('z')] }
    const next = pushSnapshot(start, snap('b'))
    expect(next.past.map(tagOf)).toEqual(['a', 'b'])
    expect(next.future).toEqual([]) // a new edit invalidates the redo stack
  })

  it('caps retained history at 30 entries', () => {
    let m: HistoryModel = EMPTY_HISTORY
    for (let i = 0; i < 40; i++) m = pushSnapshot(m, snap(`s${i}`))
    expect(m.past.length).toBeLessThanOrEqual(31)
    // The newest snapshot is always retained.
    expect(tagOf(m.past[m.past.length - 1])).toBe('s39')
  })

  describe('reduceUndo', () => {
    it('returns null (a no-op, so no dirty) when there is nothing to undo', () => {
      expect(reduceUndo(EMPTY_HISTORY, snap('present'))).toBeNull()
    })

    it('restores the most recent past snapshot and pushes present onto redo', () => {
      const model: HistoryModel = { past: [snap('a'), snap('b')], future: [] }
      const step = reduceUndo(model, snap('present'))!
      expect(step).not.toBeNull()
      expect(tagOf(step.restored)).toBe('b')
      expect(step.model.past.map(tagOf)).toEqual(['a'])
      expect(step.model.future.map(tagOf)).toEqual(['present'])
    })
  })

  describe('reduceRedo', () => {
    it('returns null when there is nothing to redo', () => {
      expect(reduceRedo(EMPTY_HISTORY, snap('present'))).toBeNull()
    })

    it('restores the next future snapshot and pushes present onto past', () => {
      const model: HistoryModel = { past: [snap('a')], future: [snap('c'), snap('d')] }
      const step = reduceRedo(model, snap('present'))!
      expect(tagOf(step.restored)).toBe('c')
      expect(step.model.past.map(tagOf)).toEqual(['a', 'present'])
      expect(step.model.future.map(tagOf)).toEqual(['d'])
    })
  })

  it('undo then redo round-trips back to the original snapshot', () => {
    const model: HistoryModel = { past: [snap('saved')], future: [] }
    const present = snap('edited')
    const afterUndo = reduceUndo(model, present)!
    expect(tagOf(afterUndo.restored)).toBe('saved')
    // Redo from the post-undo model with the restored snapshot as present.
    const afterRedo = reduceRedo(afterUndo.model, afterUndo.restored)!
    expect(tagOf(afterRedo.restored)).toBe('edited')
  })
})
