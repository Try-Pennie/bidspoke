import { describe, it, expect } from 'vitest'
import { turnY, crossingHops, edgePath, TURN_OFFSET, HOP_RADIUS, type Route } from '../edge-routes'

// #1570, Dan's design rounds of 2026-09-25. Round 1: every wire turns on one line
// a fixed distance above its target, so wires into the same card JOIN before
// dropping in. That reverses #1489, whose staggered heights read as a staircase
// under a card with seven outputs. Round 2: where a wire's horizontal run crosses
// another wire's drop, it hops over it, so a crossing never reads as a join.

describe('turnY', () => {
  it('turns TURN_OFFSET above the target when the gap allows', () => {
    expect(turnY({ sourceY: 100, targetY: 300 })).toBe(300 - TURN_OFFSET)
  })

  it('turns halfway down a gap too tight for the offset', () => {
    expect(turnY({ sourceY: 1399, targetY: 1440 })).toBe(1440 - 41 / 2)
  })

  it('gives every wire into one card the same height, so they join (the reversal of #1489)', () => {
    const into = (sourceX: number) => turnY({ sourceY: 1399, targetY: 1464 })
    expect(new Set([772.9, 1076.6].map(into)).size).toBe(1)
  })
})

// The Liberty1 click send card as measured on the live canvas, 2026-09-25: seven
// handles at y 1399 into three cards whose top is y 1464.
const Y0 = 1399
const Y1 = 1464
const liberty = (id: string, sx: number, tx: number): Route => ({ id, sx, sy: Y0, tx, ty: Y1, by: turnY({ sourceY: Y0, targetY: Y1 }) })
const LIBERTY: Route[] = [
  liberty('sent', 772.9, 924),
  liberty('refused', 1076.6, 924),
  liberty('unknown', 1380.3, 1988),
  liberty('already_sent', 1684, 1684),
  liberty('in_progress', 1987.7, 1988),
  liberty('needs_review', 2291.4, 1988),
  liberty('not_sent', 2595.1, 1988),
]

describe('crossingHops', () => {
  it('hops the one wire that crosses another drop: unknown over the already sent drop', () => {
    const hops = crossingHops(LIBERTY)
    expect(hops.get('unknown')).toEqual([1684])
    expect([...hops.keys()]).toEqual(['unknown'])
  })

  it('never hops where wires join on the way into the same card', () => {
    const hops = crossingHops([liberty('a', 700, 900), liberty('b', 1100, 900), liberty('c', 800, 900)])
    expect(hops.size).toBe(0)
  })

  it('never hops at a run end, where the corner already sits', () => {
    // The drop is exactly at the start of the run: a corner, not a crossing.
    const hops = crossingHops([liberty('run', 1000, 1400), liberty('drop', 1000, 1000)])
    expect(hops.size).toBe(0)
  })

  it('hops a converge wire the same way, since every wire follows one rule', () => {
    const hops = crossingHops([
      { id: 'converge', sx: 100, sy: 0, tx: 500, ty: 200, by: turnY({ sourceY: 0, targetY: 200 }) },
      { id: 'drop', sx: 300, sy: 0, tx: 300, ty: 200, by: turnY({ sourceY: 0, targetY: 200 }) },
    ])
    expect(hops.get('converge')).toEqual([300])
  })

  it('does not hop a drop that ends above the run', () => {
    const hops = crossingHops([
      { id: 'run', sx: 100, sy: 0, tx: 500, ty: 400, by: 368 },
      { id: 'short', sx: 300, sy: 0, tx: 300, ty: 200, by: 168 },
    ])
    expect(hops.size).toBe(0)
  })

  it('stays quick on a canvas the size of Main Flow', () => {
    const many: Route[] = Array.from({ length: 150 }, (_, i) => liberty(`e${i}`, i * 37, (i * 53) % 4000))
    const t0 = performance.now()
    crossingHops(many)
    expect(performance.now() - t0).toBeLessThan(50)
  })
})

describe('edgePath', () => {
  it('draws a straight drop when source and target share a column', () => {
    expect(edgePath(liberty('s', 1684, 1684), [])).toBe(`M1684 ${Y0} L1684 ${Y1}`)
  })

  it('draws down, across and down with no arch when nothing is crossed', () => {
    const d = edgePath(liberty('s', 772.9, 924), [])
    expect(d.startsWith(`M772.9 ${Y0}`)).toBe(true)
    expect(d.endsWith(`L924 ${Y1}`)).toBe(true)
    expect(d).not.toContain('A')
  })

  it('arches over each hop, in the direction of travel', () => {
    const d = edgePath(liberty('unknown', 1380.3, 1988), [1684])
    const by = turnY({ sourceY: Y0, targetY: Y1 })
    expect(d).toContain(`L${1684 - HOP_RADIUS} ${by} A${HOP_RADIUS} ${HOP_RADIUS} 0 0 1 ${1684 + HOP_RADIUS} ${by}`)
  })

  it('arches upward when travelling right to left too', () => {
    const by = turnY({ sourceY: 0, targetY: 200 })
    const d = edgePath({ id: 'x', sx: 500, sy: 0, tx: 100, ty: 200, by }, [300])
    expect(d).toContain(`L${300 + HOP_RADIUS} ${by} A${HOP_RADIUS} ${HOP_RADIUS} 0 0 0 ${300 - HOP_RADIUS} ${by}`)
  })
})
