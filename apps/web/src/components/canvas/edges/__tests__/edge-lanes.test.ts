import { describe, it, expect } from 'vitest'
import { laneBendY, siblingRank, TURN_OFFSET } from '../edge-lanes'

// #1489: two handles of one node wired to the same target drew as one merged
// bracket, because every edge into a target bent at the same height. Each
// sibling now bends at its own height, and every edge still ENDS on the target
// handle, so the only segment two siblings may share is the final drop into it.

interface Segment { x1: number; y1: number; x2: number; y2: number }

const SOURCE_Y = 100
const TARGET_Y = 300

/** The three segments a late bend edge draws: down, across, down into the handle. */
function segments(sourceX: number, targetX: number, bendY: number): Segment[] {
  return [
    { x1: sourceX, y1: SOURCE_Y, x2: sourceX, y2: bendY },
    { x1: sourceX, y1: bendY, x2: targetX, y2: bendY },
    { x1: targetX, y1: bendY, x2: targetX, y2: TARGET_Y },
  ]
}

const span = (a: number, b: number) => [Math.min(a, b), Math.max(a, b)] as const

function overlapsOrCrosses(a: Segment, b: Segment): boolean {
  const aH = a.y1 === a.y2
  const bH = b.y1 === b.y2
  const [ax1, ax2] = span(a.x1, a.x2)
  const [ay1, ay2] = span(a.y1, a.y2)
  const [bx1, bx2] = span(b.x1, b.x2)
  const [by1, by2] = span(b.y1, b.y2)
  if (aH && bH) return a.y1 === b.y1 && Math.min(ax2, bx2) > Math.max(ax1, bx1)
  if (!aH && !bH) return a.x1 === b.x1 && Math.min(ay2, by2) > Math.max(ay1, by1)
  const [h, v] = aH ? [a, b] : [b, a]
  const [hx1, hx2] = span(h.x1, h.x2)
  const [vy1, vy2] = span(v.y1, v.y2)
  return v.x1 > hx1 && v.x1 < hx2 && h.y1 > vy1 && h.y1 < vy2
}

/** Lays out siblings from these absolute handle x positions into one target handle and checks them. */
function assertSeparate(sources: number[], targetX: number) {
  const siblings = sources.map((x, i) => ({ id: `e${i}`, handleX: x }))
  const bends = sources.map((sx, i) => {
    const { rank } = siblingRank(`e${i}`, siblings, sx, targetX)
    return laneBendY({ rank, sourceY: SOURCE_Y, targetY: TARGET_Y })
  })
  const segs = sources.map((sx, i) => segments(sx, targetX, bends[i]))
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      expect(bends[i], `edges ${i} and ${j} bend at the same height`).not.toBe(bends[j])
      for (const a of segs[i]) for (const b of segs[j]) {
        // Both drops end on the one handle, so they may share that vertical.
        if (a.x1 === targetX && a.x2 === targetX && b.x1 === targetX && b.x2 === targetX) continue
        expect(overlapsOrCrosses(a, b), `edges ${i} and ${j} touch: ${JSON.stringify(a)} ${JSON.stringify(b)}`).toBe(false)
      }
    }
  }
}

describe('laneBendY (#1489)', () => {
  it('leaves a lone edge exactly as it was: bend 32 above the handle', () => {
    expect(laneBendY({ rank: 0, sourceY: SOURCE_Y, targetY: TARGET_Y })).toBe(TARGET_Y - TURN_OFFSET)
  })

  it('keeps two edges from handles LEFT of the target apart (the buyer_select case)', () => {
    assertSeparate([150, 190], 260)
  })

  it('keeps two edges from handles RIGHT of the target apart', () => {
    assertSeparate([300, 350], 200)
  })

  it('keeps two edges straddling the target apart, so they never read as one bar', () => {
    assertSeparate([150, 250], 200)
  })

  it('keeps three siblings apart', () => {
    assertSeparate([100, 140, 180], 400)
  })

  it('never bends above the source on a short edge', () => {
    const y = laneBendY({ rank: 2, sourceY: 100, targetY: 120 })
    expect(y).toBeGreaterThanOrEqual(100)
    expect(y).toBeLessThanOrEqual(120)
  })
})

describe('siblingRank (#1489)', () => {
  it('ranks the edge that travels farther across first, so it bends lowest', () => {
    const siblings = [{ id: 'near', handleX: 190 }, { id: 'far', handleX: 150 }]
    expect(siblingRank('far', siblings, 150, 260)).toEqual({ rank: 0, count: 2 })
    expect(siblingRank('near', siblings, 190, 260)).toEqual({ rank: 1, count: 2 })
  })

  it('measures siblings from this edge own absolute source x', () => {
    // Handle x is relative to the source node; the source x is absolute.
    const siblings = [{ id: 'a', handleX: 10 }, { id: 'b', handleX: 50 }]
    expect(siblingRank('b', siblings, 1050, 1200)).toEqual({ rank: 1, count: 2 })
    expect(siblingRank('a', siblings, 1010, 1200)).toEqual({ rank: 0, count: 2 })
  })

  it('breaks a tie by edge id so two renders agree', () => {
    const siblings = [{ id: 'z', handleX: 150 }, { id: 'y', handleX: 250 }]
    expect(siblingRank('y', siblings, 250, 200)).toEqual({ rank: 0, count: 2 })
    expect(siblingRank('z', siblings, 150, 200)).toEqual({ rank: 1, count: 2 })
  })

  it('treats an edge missing from the list as a lone edge', () => {
    expect(siblingRank('q', [], 0, 0)).toEqual({ rank: 0, count: 1 })
  })
})
