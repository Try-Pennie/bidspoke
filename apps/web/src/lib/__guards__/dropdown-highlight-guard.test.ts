/**
 * Guard (#2338 design round 27, Dan 2026-10-21): an open dropdown's
 * highlighted row, the row under the mouse or the arrow keys, is pale grey
 * (the `highlight` token, #F1EFEA) behind the usual dark text, in every
 * dropdown. Before the round the Select and SuggestInput drew it pale blue
 * (`bg-p-blue-light`), which the colour rule keeps for nothing, and the
 * Combobox drew it navy, which marks a chosen thing, not a passing one.
 *
 * The three dropdowns draw that row through globals.css, so this reads every
 * rule there that draws one: the Select's `data-[highlighted]` variant on
 * `.select-item`, and any rule whose selector names `.suggest-item-active` or
 * `.combobox-item-active`. Each must paint its background with the token and
 * nothing else, and must not turn the text white. One pass over the
 * stylesheet (L297), with a planted positive control (L1).
 *
 * What it cannot see: a dropdown drawn somewhere other than these three
 * classes (FieldAutocomplete and TemplateTextarea draw their own lists in
 * their .tsx, and are not covered by round 27's three).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from '../contrast'
import { REPO_ROOT, WEB_SRC } from '../__tests__/_scan-utils'

const ACTIVE_SELECTORS = ['.suggest-item-active', '.combobox-item-active']

export function highlightViolations(css: string): string[] {
  const found: string[] = []
  let selectHighlights = 0
  let activeRules = 0
  // Comments go first, or the comment above a rule reads as part of its selector.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim()
    const tokens = m[2].split(/[\s;]+/).filter(Boolean)
    if (/^\.select-item$/.test(selector)) {
      const highlighted = tokens.filter((t) => t.startsWith('data-[highlighted]:'))
      selectHighlights += highlighted.length
      for (const t of highlighted) {
        const util = t.slice('data-[highlighted]:'.length)
        if (util.startsWith('bg-') && util !== 'bg-highlight') found.push(`${selector}: ${t}`)
        if (util === 'text-white') found.push(`${selector}: ${t}`)
      }
      if (!highlighted.includes('data-[highlighted]:bg-highlight')) found.push(`${selector}: no data-[highlighted]:bg-highlight`)
    }
    if (ACTIVE_SELECTORS.some((s) => selector.includes(s))) {
      activeRules += 1
      for (const t of tokens) {
        if (/^bg-/.test(t) && t !== 'bg-highlight') found.push(`${selector}: ${t}`)
        if (t === 'text-white') found.push(`${selector}: ${t}`)
      }
      if (ACTIVE_SELECTORS.includes(selector) && !tokens.includes('bg-highlight')) found.push(`${selector}: no bg-highlight`)
    }
  }
  if (selectHighlights === 0) found.push('.select-item draws no highlighted row')
  if (activeRules < ACTIVE_SELECTORS.length) found.push('a dropdown highlight rule is missing from globals.css')
  return found
}

describe('an open dropdown highlights its row in pale grey (#2338 round 27)', () => {
  const css = readFileSync(path.join(WEB_SRC, 'app/globals.css'), 'utf8')
  const config = readFileSync(path.join(REPO_ROOT, 'apps/web/tailwind.config.ts'), 'utf8')
  const token = config.match(/\bhighlight:\s*'(#[0-9a-fA-F]{6})'/)?.[1]
  const graphite = config.match(/\bgraphite:\s*'(#[0-9a-fA-F]{6})'/)?.[1]

  it('the token is the shade Dan chose on 2026-10-21', () => {
    expect(token).toBe('#F1EFEA')
  })

  it('the Select, SuggestInput and the Combobox each draw the highlighted row with the token, behind dark text', () => {
    expect(highlightViolations(css)).toEqual([])
  })

  it('the dark text on it clears 4.5 to 1', () => {
    expect(contrastRatio(graphite!, token!)).toBeGreaterThanOrEqual(4.5)
  })

  it('POSITIVE CONTROL: the old pale blue, a navy row, white text and a missing rule are each caught', () => {
    const planted = [
      '.select-item { @apply py-1.5 data-[highlighted]:bg-p-blue-light data-[highlighted]:text-graphite; }',
      '.suggest-item-active { @apply bg-p-blue-light; }',
      '.combobox-item-active { @apply bg-navy text-white; }',
    ].join('\n')
    expect(highlightViolations(planted)).toEqual([
      '.select-item: data-[highlighted]:bg-p-blue-light',
      '.select-item: no data-[highlighted]:bg-highlight',
      '.suggest-item-active: bg-p-blue-light',
      '.suggest-item-active: no bg-highlight',
      '.combobox-item-active: bg-navy',
      '.combobox-item-active: text-white',
      '.combobox-item-active: no bg-highlight',
    ])
    // A comment above a rule that paints no background is still read as that rule.
    expect(highlightViolations([
      '.select-item { @apply data-[highlighted]:bg-highlight; }',
      '/* The highlighted row. */\n.suggest-item-active { @apply text-graphite; }',
      '.combobox-item-active { @apply bg-highlight; }',
    ].join('\n'))).toEqual(['.suggest-item-active: no bg-highlight'])
    expect(highlightViolations('.suggest-item-active { @apply bg-highlight; }')).toEqual([
      '.select-item draws no highlighted row',
      'a dropdown highlight rule is missing from globals.css',
    ])
  })
})
