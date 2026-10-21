/**
 * Guard (#2338 design rounds 27 and 28, Dan 2026-10-21): an open dropdown's
 * highlighted row, the row under the mouse or the arrow keys, is pale grey
 * (the `highlight` token, #F1EFEA) behind the usual dark text, in every
 * dropdown, and on that row an option's grey second line is the darker
 * `hint-on-highlight` (#666D7E), because the ordinary hint grey measures 4.31
 * to 1 there. Before round 27 the Select, SuggestInput, the rule builder's
 * field list and the canvas reference list drew the row pale blue, which the
 * colour rule keeps for nothing, and the Combobox drew it navy, which marks a
 * chosen thing, not a passing one.
 *
 * Every dropdown draws that row through a class in globals.css: the Select's
 * `data-[highlighted]` variant on `.select-item`, and `.suggest-item-active`,
 * `.combobox-item-active` and `.autocomplete-item-active` (the rule builder
 * and the canvas share the last). This reads each such rule, and every hover
 * or highlighted variant on a dropdown item, and refuses any background but
 * the token and white text. It also holds the files that draw listbox options
 * to the five known ones, so a sixth dropdown cannot draw its own highlight
 * unseen, and holds the two hand drawn lists to the shared classes. One pass
 * over each file (L297), with planted positive controls (L1).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from '../contrast'
import { REPO_ROOT, WEB_SRC, listFiles, sanitizeSource } from '../__tests__/_scan-utils'

const ACTIVE_SELECTORS = ['.suggest-item-active', '.combobox-item-active', '.autocomplete-item-active']
const ITEM_CLASS = /\.(?:select|suggest|combobox|autocomplete)-item\b/
/** The rule drawing an option's second line on a highlighted row (round 28). */
const SECOND_LINE = '.combobox-item-active .combobox-item-hint'

/** Every file that draws a listbox option, and so a highlighted row. */
const DROPDOWN_FILES = [
  'components/ui/Combobox.tsx',
  'components/ui/Select.tsx',
  'components/ui/SuggestInput.tsx',
  'components/rule-builder/FieldAutocomplete.tsx',
  'components/canvas/TemplateTextarea.tsx',
]
/** The two lists drawn by hand in their .tsx, which take their row colours from the shared classes. */
const HAND_DRAWN = ['components/rule-builder/FieldAutocomplete.tsx', 'components/canvas/TemplateTextarea.tsx']
const OPTION_MARKUP = /role\s*=\s*\{?\s*["'`]option["'`]|RadixSelect\.Item\b/

export function highlightViolations(css: string): string[] {
  const found: string[] = []
  let selectHighlights = 0
  let activeRules = 0
  let secondLine = false
  // Comments go first, or the comment above a rule reads as part of its selector.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim()
    const tokens = m[2].split(/[\s;]+/).filter(Boolean)
    if (ITEM_CLASS.test(selector)) {
      // A row under the mouse or the keys, in whichever variant draws it.
      for (const t of tokens) {
        const v = /^(?:hover|data-\[highlighted\]):(.+)$/.exec(t)
        if (!v) continue
        if (v[1].startsWith('bg-') && v[1] !== 'bg-highlight') found.push(`${selector}: ${t}`)
        if (v[1] === 'text-white') found.push(`${selector}: ${t}`)
      }
    }
    if (/^\.select-item$/.test(selector)) {
      const highlighted = tokens.filter((t) => t.startsWith('data-[highlighted]:'))
      selectHighlights += highlighted.length
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
    if (selector === SECOND_LINE) {
      secondLine = true
      if (!tokens.includes('text-hint-on-highlight')) found.push(`${selector}: not text-hint-on-highlight`)
    }
  }
  if (selectHighlights === 0) found.push('.select-item draws no highlighted row')
  if (activeRules < ACTIVE_SELECTORS.length) found.push('a dropdown highlight rule is missing from globals.css')
  if (!secondLine) found.push(`${SECOND_LINE} is missing: the second line keeps the hint grey on the highlight`)
  return found
}

/** A hand drawn list's own colour classes on its options, which must come from the shared classes. */
export function handDrawnViolations(file: string, source: string): string[] {
  const code = sanitizeSource(source, { blankStrings: false })
  const found: string[] = []
  // Each option element, from its role to its closing tag: the rest of the file draws other things.
  const options = [...code.matchAll(new RegExp(OPTION_MARKUP.source, 'g'))].map((m) => {
    const end = code.indexOf('</li>', m.index)
    return code.slice(m.index, end === -1 ? undefined : end)
  })
  if (!options.length) found.push(`${file}: draws no option`)
  for (const option of options) {
    if (!/\bautocomplete-item-active\b/.test(option)) found.push(`${file}: does not draw its highlighted row with autocomplete-item-active`)
    for (const m of option.matchAll(/\b(?:hover:)?(?:bg|text)-(?:p-blue[\w-]*|beige|gray-\d{3}|white)\b/g)) found.push(`${file}: ${m[0]}`)
  }
  return found
}

describe('an open dropdown highlights its row in pale grey (#2338 rounds 27 and 28)', () => {
  const css = readFileSync(path.join(WEB_SRC, 'app/globals.css'), 'utf8')
  const config = readFileSync(path.join(REPO_ROOT, 'apps/web/tailwind.config.ts'), 'utf8')
  const token = config.match(/\bhighlight:\s*'(#[0-9a-fA-F]{6})'/)?.[1]
  const secondLineToken = config.match(/'hint-on-highlight':\s*'(#[0-9a-fA-F]{6})'/)?.[1]
  const hint = config.match(/\bhint:\s*'(#[0-9a-fA-F]{6})'/)?.[1]
  const graphite = config.match(/\bgraphite:\s*'(#[0-9a-fA-F]{6})'/)?.[1]

  it('the tokens are the shades Dan chose on 2026-10-21, and the ordinary hint grey is unchanged', () => {
    expect(token).toBe('#F1EFEA')
    expect(secondLineToken).toBe('#666D7E')
    expect(hint).toBe('#697081')
  })

  it('every dropdown draws the highlighted row with the token, behind dark text, its second line in the darker grey', () => {
    expect(highlightViolations(css)).toEqual([])
  })

  it('the dark text and the second line on the highlight each clear 4.5 to 1, which the ordinary hint grey does not', () => {
    expect(contrastRatio(graphite!, token!)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(secondLineToken!, token!)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(hint!, token!)).toBeLessThan(4.5)
  })

  it('only the five known dropdowns draw a listbox option, and the two hand drawn lists use the shared classes', () => {
    const drawing = listFiles(WEB_SRC, { exts: ['.tsx'] })
      .map((f) => path.relative(WEB_SRC, f).split(path.sep).join('/'))
      .filter((f) => !f.includes('__tests__') && !f.endsWith('.test.tsx'))
      .filter((f) => OPTION_MARKUP.test(sanitizeSource(readFileSync(path.join(WEB_SRC, f), 'utf8'), { blankStrings: false })))
      .sort()
    expect(drawing).toEqual([...DROPDOWN_FILES].sort())
    expect(HAND_DRAWN.flatMap((f) => handDrawnViolations(f, readFileSync(path.join(WEB_SRC, f), 'utf8')))).toEqual([])
  })

  it('POSITIVE CONTROL: the old pale blue, a navy row, white text, a beige hover and a missing rule are each caught', () => {
    const planted = [
      '.select-item { @apply py-1.5 data-[highlighted]:bg-p-blue-light data-[highlighted]:text-graphite; }',
      '.suggest-item-active { @apply bg-p-blue-light; }',
      '.combobox-item-active { @apply bg-navy text-white; }',
      '.autocomplete-item-idle { @apply hover:bg-beige; }',
      '.autocomplete-item-active { @apply bg-highlight; }',
      '.combobox-item-active .combobox-item-hint { @apply text-hint; }',
    ].join('\n')
    expect(highlightViolations(planted)).toEqual([
      '.select-item: data-[highlighted]:bg-p-blue-light',
      '.select-item: no data-[highlighted]:bg-highlight',
      '.suggest-item-active: bg-p-blue-light',
      '.suggest-item-active: no bg-highlight',
      '.combobox-item-active: bg-navy',
      '.combobox-item-active: text-white',
      '.combobox-item-active: no bg-highlight',
      '.autocomplete-item-idle: hover:bg-beige',
      '.combobox-item-active .combobox-item-hint: not text-hint-on-highlight',
    ])
    // A comment above a rule that paints no background is still read as that rule.
    expect(highlightViolations([
      '.select-item { @apply data-[highlighted]:bg-highlight; }',
      '/* The highlighted row. */\n.suggest-item-active { @apply text-graphite; }',
      '.combobox-item-active { @apply bg-highlight; }',
      '.autocomplete-item-active { @apply bg-highlight; }',
      '.combobox-item-active .combobox-item-hint { @apply text-hint-on-highlight; }',
    ].join('\n'))).toEqual(['.suggest-item-active: no bg-highlight'])
    expect(highlightViolations('.suggest-item-active { @apply bg-highlight; }')).toEqual([
      '.select-item draws no highlighted row',
      'a dropdown highlight rule is missing from globals.css',
      `${SECOND_LINE} is missing: the second line keeps the hint grey on the highlight`,
    ])
  })

  it('POSITIVE CONTROL: a hand drawn list keeping its own pale blue is caught, and a sixth dropdown is seen', () => {
    const old = `<li role="option" className={\`px-2 \${on ? 'bg-p-blue-light text-p-blue-dark' : 'text-gray-700 hover:bg-beige'}\`}>`
    expect(handDrawnViolations('X.tsx', old)).toEqual([
      'X.tsx: does not draw its highlighted row with autocomplete-item-active',
      'X.tsx: bg-p-blue-light',
      'X.tsx: text-p-blue-dark',
      'X.tsx: text-gray-700',
      'X.tsx: hover:bg-beige',
    ])
    expect(OPTION_MARKUP.test('<div role="option">')).toBe(true)
    expect(OPTION_MARKUP.test("<li role={'option'}>")).toBe(true)
    expect(OPTION_MARKUP.test('<RadixSelect.Item value="a">')).toBe(true)
  })
})
