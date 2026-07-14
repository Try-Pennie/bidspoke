import { describe, it, expect } from 'vitest'
import { NODE_TYPE_COLOR, minimapNodeColor } from '../node-colors'
import { NODE_TYPES } from '@/types/workflow'

/**
 * Hex for every Tailwind utility the node cards actually use. The map below has
 * to carry BOTH the Tailwind class (the cards render it) and a raw hex (the
 * minimap draws SVG rects, which cannot take a class), and nothing in the type
 * system ties those two halves together: `{ icon: 'text-amber-500', hex: '#000' }`
 * type-checks fine. This table is what ties them, so a card and its minimap dot
 * cannot drift into different colors.
 *
 * Values are Tailwind v3's default palette plus the project's `p-blue` (see
 * tailwind.config.ts). Only the shades in use are listed: an unlisted class is a
 * test failure, not a silent pass, which is what stops this guard from going
 * vacuous as new node types land.
 */
const TAILWIND_HEX: Record<string, string> = {
  'text-p-blue-dark': '#1B72BA',
  'text-purple-500': '#a855f7',
  'text-purple-400': '#c084fc',
  'text-amber-500': '#f59e0b',
  'text-green-600': '#16a34a',
  'text-red-600': '#dc2626',
  'text-slate-500': '#64748b',
  'text-slate-400': '#94a3b8',
  'text-rose-500': '#f43f5e',
  'text-teal-500': '#14b8a6',
  'text-orange-500': '#f97316',
  'text-indigo-500': '#6366f1',
  'text-blue-500': '#3b82f6',
  'text-cyan-500': '#06b6d4',
  'text-violet-500': '#8b5cf6',
}

describe('NODE_TYPE_COLOR', () => {
  it('gives every node type the definition format allows a color', () => {
    const missing = NODE_TYPES.filter((t) => !(t in NODE_TYPE_COLOR))
    expect(missing).toEqual([])
  })

  it('colors the trigger, which is a real canvas node but not a saved node type', () => {
    expect(NODE_TYPE_COLOR.trigger).toBeDefined()
  })

  it('keeps each type card class and its minimap hex the same color', () => {
    for (const [type, { icon, hex }] of Object.entries(NODE_TYPE_COLOR)) {
      const expected = TAILWIND_HEX[icon]
      expect(expected, `${type}: no known hex for "${icon}", add it to TAILWIND_HEX`).toBeDefined()
      expect(hex.toLowerCase(), `${type} card is ${icon} but its minimap dot is ${hex}`).toBe(
        expected.toLowerCase(),
      )
    }
  })
})

describe('minimapNodeColor', () => {
  it('gives every node type a color instead of falling through to gray', () => {
    // The bug this guards (#660): six types were missing from the minimap's map
    // and fell through to gray-400, a near-match for the gray-300 the same
    // callback uses to mean "unreachable", so a healthy Bid Group read as dead.
    const gray = minimapNodeColor('this_type_does_not_exist')
    const fellThrough = NODE_TYPES.filter((t) => minimapNodeColor(t) === gray)
    expect(fellThrough).toEqual([])
  })

  it('still has a fallback for an unknown type, so a stray node still draws', () => {
    expect(minimapNodeColor('bogus')).toMatch(/^#[0-9a-f]{6}$/i)
  })
})
