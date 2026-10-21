/**
 * Every web surface keyed by node type covers every node type (#1411, L233).
 *
 * The typed records (colours, cards, heights) are covered by the compiler now.
 * Three surfaces cannot be typed that way, because a type is legitimately
 * absent from them: the palette (retired and auto created types), the state
 * preview (the retired type renders as the generic card) and the config panel
 * (types with nothing to configure). Each keeps an explicit exclusion map with a
 * written reason, and this test fails on a saved node type that is in neither
 * the surface nor the map, so a new type cannot be forgotten by accident.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NODE_TYPES } from '@bidspoke/node-types'
import { PALETTE_HIDDEN, PALETTE_TYPES } from '@/components/canvas/NodePalette'
import { PREVIEW_OMITTED, PREVIEW_TYPES } from '../preview-nodes'
import { WEB_SRC, sanitizeSource } from './_scan-utils'

/** Types the config panel deliberately offers no type specific section for. */
const CONFIG_PANEL_NO_SECTION: Partial<Record<(typeof NODE_TYPES)[number], string>> = {
  partner_bid: 'retired (#645): the generic card has no configuration to offer',
}

function placed(surface: readonly string[], excluded: Readonly<Partial<Record<string, string>>>): string[] {
  const problems: string[] = []
  for (const t of NODE_TYPES) {
    const onSurface = surface.includes(t)
    const reason = excluded[t]
    if (onSurface && reason) problems.push(`${t}: both on the surface and excluded ("${reason}")`)
    if (!onSurface && !reason) problems.push(`${t}: neither on the surface nor excluded with a reason`)
    if (reason !== undefined && reason.length < 20) problems.push(`${t}: the exclusion reason is too short to be a reason`)
  }
  return problems
}

describe('node palette', () => {
  it('offers every saved node type, or names why it does not', () => {
    expect(placed(PALETTE_TYPES, PALETTE_HIDDEN)).toEqual([])
  })
})

describe('node state preview', () => {
  it('previews every saved node type, or names why it does not', () => {
    expect(placed(PREVIEW_TYPES, PREVIEW_OMITTED)).toEqual([])
  })
})

describe('config panel', () => {
  it('has a type specific section for every saved node type, or names why it does not', () => {
    const src = sanitizeSource(readFileSync(path.join(WEB_SRC, 'components/canvas/ConfigPanel.tsx'), 'utf8'), { blankStrings: false })
    const withSection = NODE_TYPES.filter((t) => new RegExp(`\\btype === '${t}'`).test(src))
    expect(placed(withSection, CONFIG_PANEL_NO_SECTION)).toEqual([])
  })
})
