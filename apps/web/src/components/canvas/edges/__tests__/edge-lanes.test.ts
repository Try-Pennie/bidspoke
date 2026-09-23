import { describe, it, expect } from 'vitest'
import { laneGeometry, siblingLane, LANE_GAP } from '../edge-lanes'

// #1489: two handles of one node wired to the same target drew as one merged
// bracket, because every edge into a target bent at the same height and dropped
// at the same x. Each sibling edge now gets its own lane.

interface Segment { x1: number; y1: number; x2: number; y2: number }

/** The three segments a late bend edge draws: down, across, down. */
function segments(sourceX: number, sourceY: number, g: { targetX: number; centerY: number }, targetY: number): Segment[] {
  return [
    { x1: sourceX, y1: sourceY, x2: sourceX, y2: g.centerY },
    { x1: sourceX, y1: g.centerY, x2: g.targetX, y2: g.centerY },
    { x1: g.targetX, y1: g.centerY, x2: g.targetX, y2: targetY },
  ]
}

function overlapsOrCrosses(a: Segment, b: Segment): boolean {
  const aH = a.y1 === a.y2
  const bH = b.y1 === b.y2
  const [ax1, ax2] = [Math.min(a.x1, a.x2), Math.max(a.x1, a.x2)]
  const [ay1, ay2] = [Math.min(a.y1, a.y2), Math.max(a.y1, a.y2)]
  const [bx1, bx2] = [Math.min(b.x1, b.x2), Math.max(b.x1, b.x2)]
  const [by1, by2] = [Math.min(b.y1, b.y2), Math.max(b.y1, b.y2)]
  if (aH && bH) return a.y1 === b.y1 && Math.min(ax2, bx2) > Math.max(ax1, bx1)
  if (!aH && !bH) return a.x1 === b.x1 && Math.min(ay2, by2) > Math.max(ay1, by1)
  const [h, v] = aH ? [a, b] : [b, a]
  const [hx1, hx2] = [Math.min(h.x1, h.x2), Math.max(h.x1, h.x2)]
  const [vy1, vy2] = [Math.min(v.y1, v.y2), Math.max(v.y1, v.y2)]
  return v.x1 > hx1 && v.x1 < hx2 && h.y1 > vy1 && h.y1 < vy2
}

function assertSeparate(sources: number[], targetX: number, sourceY = 100, targetY = 300) {
  const count = sources.length
  const geos = sources.map((sx, index) => laneGeometry({ index, count, sourceX: sx, sourceY, targetX, targetY }))
  const segs = sources.map((sx, i) => segments(sx, sourceY, geos[i], targetY))
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      expect(geos[i].targetX).not.toBe(geos[j].targetX)
      for (const a of segs[i]) for (const b of segs[j]) {
        expect(overlapsOrCrosses(a, b), `edges ${i} and ${j} touch: ${JSON.stringify(a)} ${JSON.stringify(b)}`).toBe(false)
      }
    }
  }
  return geos
}

describe('laneGeometry (#1489)', () => {
  it('leaves a lone edge exactly as it was: drop at the handle, bend 32 above it', () => {
    expect(laneGeometry({ index: 0, count: 1, sourceX: 50, sourceY: 100, targetX: 200, targetY: 300 })).toEqual({ targetX: 200, centerY: 268 })
  })

  it('keeps two edges from handles LEFT of the target as two separate lines (the buyer_select case)', () => {
    assertSeparate([150, 190], 260)
  })

  it('keeps two edges from handles RIGHT of the target separate', () => {
    assertSeparate([300, 350], 200)
  })

  it('keeps two edges straddling the target separate', () => {
    assertSeparate([150, 250], 200)
  })

  it('keeps three siblings separate', () => {
    assertSeparate([100, 140, 180], 400)
  })

  it('centres the drops on the target handle, one lane gap apart', () => {
    const geos = assertSeparate([150, 190], 260)
    expect(geos.map((g) => g.targetX)).toEqual([260 - LANE_GAP / 2, 260 + LANE_GAP / 2])
  })

  it('never bends above the source on a short edge', () => {
    const g = laneGeometry({ index: 1, count: 3, sourceX: 100, sourceY: 100, targetX: 200, targetY: 120 })
    expect(g.centerY).toBeGreaterThanOrEqual(100)
    expect(g.centerY).toBeLessThanOrEqual(120)
  })
})

describe('siblingLane (#1489)', () => {
  it('orders siblings left to right by their source handle x', () => {
    const siblings = [{ id: 'b', handleX: 190 }, { id: 'a', handleX: 150 }]
    expect(siblingLane('a', siblings)).toEqual({ index: 0, count: 2 })
    expect(siblingLane('b', siblings)).toEqual({ index: 1, count: 2 })
  })

  it('breaks a tie by edge id so two renders agree', () => {
    const siblings = [{ id: 'z', handleX: 10 }, { id: 'y', handleX: 10 }]
    expect(siblingLane('y', siblings)).toEqual({ index: 0, count: 2 })
  })

  it('treats an edge missing from the list as a lone edge', () => {
    expect(siblingLane('q', [])).toEqual({ index: 0, count: 1 })
  })
})
