/**
 * Guard (#2317, PM-17): the partners page is drawn as the settled design
 * (docs/design/partners-page.html) draws it, from one section row and one set of
 * controls, so a tab cannot drift back to the old stacked form.
 *
 *   - Every section heading on a tab is PartnerSection's. A hand made `<h3>` or
 *     `<h4>` heading in a tab file is refused (L613: the component and the scan
 *     that keeps it the only one ship together).
 *   - Add links, All and None are dark, never the blue ghost button: blue is for
 *     buttons (.impeccable.md), so `variant="ghost"` is refused on the page.
 *   - A remove mark is the grey minus RemoveButton draws, so a trash can or a
 *     cross imported for one is refused.
 *   - The page's controls are white boxes with the beige line: globals.css
 *     carries the partner-page rule, and the page's root carries the class.
 *
 * Each rule has a positive control (L1).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WEB_SRC, listFiles } from './_scan-utils'

const GUARDED_DIRS = ['app/(app)/partners', 'components/partners']
/** The tab files whose sections are rows: a heading inside them must be PartnerSection's. */
const TAB_FILES = [
  'app/(app)/partners/PartnerForm.tsx',
  'components/partners/buyer-profile/BuyerProfileSection.tsx',
  'components/partners/WorkflowValuesPanel.tsx',
]
/** A matrix is deleted, not removed from a list, and confirms first: its trash can stays. */
const TRASH_ALLOWED = new Set(['components/partners/BidMatrixViewer.tsx', 'components/partners/RemoveButton.tsx'])

const read = (rel: string) => readFileSync(path.join(WEB_SRC, rel), 'utf8')
const rel = (file: string) => path.relative(WEB_SRC, file)
const guarded = () => GUARDED_DIRS.flatMap((d) => listFiles(path.join(WEB_SRC, d), { exts: ['.tsx'] }))

export function handMadeHeadings(source: string): number[] {
  return source.split('\n').flatMap((t, i) => (/<h[34][\s>]/.test(t) ? [i + 1] : []))
}
export function ghostButtons(source: string): number[] {
  return source.split('\n').flatMap((t, i) => (/variant="ghost"/.test(t) ? [i + 1] : []))
}
/** The body of the partners page rule that draws every text box, select and choice strip, or null. */
export function controlRule(css: string): string | null {
  const m = css.match(/\.partner-page :is\(\.input, \.textarea, \.select, \.select-trigger, \.choice-group\) \{([^}]*)\}/)
  return m ? m[1] : null
}
export function removeIcons(source: string): string[] {
  const m = source.match(/import\s*\{([^}]*)\}\s*from\s*'lucide-react'/)
  if (!m) return []
  return m[1].split(',').map((s) => s.trim()).filter((s) => s === 'Trash2' || s === 'Trash' || s === 'X')
}

describe('the scans themselves (positive controls)', () => {
  it('see a hand made heading, a ghost button and a trash can import', () => {
    expect(handMadeHeadings('<div>\n<h4 className="x">Caps</h4>\n<h3>Hours</h3>')).toEqual([2, 3])
    expect(handMadeHeadings('<h5>fine</h5>')).toEqual([])
    expect(ghostButtons('<Button variant="ghost" onClick={f}>All</Button>')).toEqual([1])
    expect(removeIcons("import { Plus, Trash2, X } from 'lucide-react'")).toEqual(['Trash2', 'X'])
    expect(removeIcons("import { Plus, Minus } from 'lucide-react'")).toEqual([])
    expect(controlRule('.partner-page :is(.input, .textarea, .select, .select-trigger, .choice-group) {\n  @apply border-line bg-white;\n}')).toContain('bg-white')
    expect(controlRule('.partner-page .choice { @apply bg-white border-line; }')).toBeNull()
  })
})

describe('the partners page (#2317)', () => {
  it('draws every tab section through PartnerSection', () => {
    for (const f of TAB_FILES) expect({ file: f, lines: handMadeHeadings(read(f)) }).toEqual({ file: f, lines: [] })
  })

  it('has no blue ghost button: add links, All and None are dark', () => {
    const found = guarded().map((f) => ({ file: rel(f), lines: ghostButtons(readFileSync(f, 'utf8')) })).filter((v) => v.lines.length)
    expect(found).toEqual([])
  })

  it('draws a remove mark only through RemoveButton', () => {
    const found = guarded().map((f) => ({ file: rel(f), icons: removeIcons(readFileSync(f, 'utf8')) })).filter((v) => v.icons.length && !TRASH_ALLOWED.has(v.file))
    expect(found).toEqual([])
  })

  it('makes the page controls white boxes with the beige line', () => {
    expect(controlRule(read('app/globals.css'))).toMatch(/@apply[^;]*\bborder-line\b[^;]*\bbg-white\b|@apply[^;]*\bbg-white\b[^;]*\bborder-line\b/)
    expect(read('app/(app)/partners/page.tsx')).toMatch(/className="partner-page /)
  })
})
