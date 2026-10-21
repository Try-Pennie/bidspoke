/**
 * One set of tabs for the whole app (#2137, L613): components/ui/Tabs.tsx, on
 * @radix-ui/react-tabs. This scan stops the NEXT hand rolled tab: a tab,
 * tablist or tabpanel role in any spelling, or an import of the Radix tabs
 * primitive, anywhere in the product source but Tabs.tsx. It also holds
 * `aria-selected`, which only a tab, an option, a row or a grid cell may carry,
 * to the files that carry it for a reason that is not a tab, each named below.
 *
 * What it cannot see: a row of plain buttons that switches panels carries no
 * role a pattern can find. The issue's candidates were checked by hand instead
 * (the PR for #2137 lists each): none of the five files the issue named still
 * holds a panel switcher, and the two pressed button groups in the app
 * (ConfigPanel's buyer_select Mode, the sources page's example source) each pick
 * a value, so neither is a tab.
 *
 * Product source only, one pass per file (L297). Seen failing: a role="tablist"
 * div added to EndpointForm.tsx, an aria-selected added to sources/page.tsx,
 * and the planted sources in the positive controls below.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFiles, sanitizeSource, WEB_SRC } from '../__tests__/_scan-utils'

const rel = (file: string) => path.relative(WEB_SRC, file).split(path.sep).join('/')
const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length

const HOME = 'components/ui/Tabs.tsx'
// Assembled from fragments, so this guard's own source never holds the spellings it hunts.
const TAB = ['t', 'ab'].join('')
const ROLE = new RegExp(`\\brole\\s*(?:=\\s*\\{?\\s*|:\\s*)(['"\`])${TAB}(list|panel)?\\1`, 'g')
const RADIX = new RegExp(`['"]@radix-ui/react-${TAB}s['"]`, 'g')
const SELECTED = /\baria-selected\b/g

/** Files that carry aria-selected for something that is not a tab, and why. */
const SELECTED_ALLOWED: Readonly<Record<string, string>> = {
  'components/rule-builder/FieldAutocomplete.tsx': 'the highlighted option of its suggestion listbox',
  'components/canvas/TemplateTextarea.tsx': 'the highlighted option of its reference listbox',
  'components/ui/DateTimeFields.tsx': 'the chosen day, a gridcell of the calendar grid',
  'components/ui/SuggestInput.tsx': 'the marked option of its suggestion listbox (#2326)',
  'components/ui/Combobox.tsx': 'the marked option of its looked up listbox (#2338)',
}

export function tabMarkupIn(file: string, source: string): string[] {
  if (file === HOME) return []
  const code = sanitizeSource(source, { blankStrings: false })
  const found: string[] = []
  for (const m of code.matchAll(ROLE)) found.push(`${file}:${lineOf(code, m.index ?? 0)} role ${TAB}${m[2] ?? ''}`)
  for (const m of code.matchAll(RADIX)) found.push(`${file}:${lineOf(code, m.index ?? 0)} Radix ${TAB}s import`)
  if (!SELECTED_ALLOWED[file]) for (const m of code.matchAll(SELECTED)) found.push(`${file}:${lineOf(code, m.index ?? 0)} aria-selected`)
  return found
}

describe('one set of tabs (#2137)', () => {
  const files = listFiles(WEB_SRC, { exts: ['.tsx', '.ts'] })

  it('scans the product source, Tabs.tsx included (a positive control: the home imports Radix)', () => {
    const home = files.find((f) => rel(f) === HOME)
    expect(home).toBeDefined()
    expect(files.length).toBeGreaterThan(200)
    expect(readFileSync(home as string, 'utf8')).toMatch(RADIX)
  })

  it('no file but Tabs.tsx draws a tab, a tablist or a tabpanel, or selects outside its reasons', () => {
    const found = files.flatMap((f) => tabMarkupIn(rel(f), readFileSync(f, 'utf8')))
    expect(found).toEqual([])
  })

  it('each allowed aria-selected file still carries one, so the allowlist cannot outlive its reason', () => {
    for (const file of Object.keys(SELECTED_ALLOWED)) {
      expect(readFileSync(path.join(WEB_SRC, file), 'utf8'), file).toMatch(SELECTED)
    }
  })

  it('catches every spelling it hunts, and leaves a listbox option and comments alone', () => {
    const q = '"'
    const planted = [
      `<div role=${q}${TAB}list${q}>`,
      `<button role={'${TAB}'} aria-selected={on}>`,
      `const props = { role: \`${TAB}panel\` }`,
      `import * as T from '@radix-ui/react-${TAB}s'`,
      `<li role="option">`,
      `// role="${TAB}" in a comment`,
    ].join('\n')
    expect(tabMarkupIn('components/Planted.tsx', planted)).toEqual([
      `components/Planted.tsx:1 role ${TAB}list`,
      `components/Planted.tsx:2 role ${TAB}`,
      `components/Planted.tsx:3 role ${TAB}panel`,
      `components/Planted.tsx:4 Radix ${TAB}s import`,
      'components/Planted.tsx:2 aria-selected',
    ])
    expect(tabMarkupIn(HOME, planted)).toEqual([])
  })
})
