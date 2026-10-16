/**
 * Guard (#2144, PM-16): the app colour rule on the partners page
 * (.impeccable.md, settled in the #2114 design rounds).
 *
 *   - Navy marks a selection. The switch's on state and the chosen segment are
 *     drawn by `.toggle-on` and `.choice-on` in globals.css, so those are read.
 *   - Blue is for buttons only. The Button component (components/ui/form.tsx)
 *     owns every blue class, so a blue utility under the partners page
 *     directories is refused. A focus ring is not a selection or a button: it
 *     marks where the keyboard is and stays as the design system draws it, so a
 *     blue class carrying a `focus:` or `focus-visible:` prefix is permitted.
 *   - Red only for something genuinely wrong. Red lives in ProblemMark, in
 *     FieldError and in the danger and destructive Button variants, all in
 *     components/ui, so any red utility under the partners page directories is
 *     refused. `p-blue-light` is refused outright.
 *   - Grey hint and secondary text is the `hint` token (#697081, Dan
 *     2026-10-16): `text-gray-500` measures 4.48 to 1 on the beige page, so it
 *     is refused on the page and in the shared Field.
 *
 * The rest of the app follows in #2126. Each rule has a positive control (L1).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from '../contrast'
import { REPO_ROOT, WEB_SRC, listFiles } from './_scan-utils'

/** The partners page: its route and its components, every subdirectory included. */
const GUARDED_DIRS = ['app/(app)/partners', 'components/partners']
const FIELD_FILE = 'components/ui/form.tsx'

export type ColourViolation = { line: number; rule: 'blue' | 'red' | 'blue-light' | 'grey-hint'; token: string }

/** A line that is only a comment, in any of the spellings a .tsx uses. */
function isCommentLine(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')
}

const BLUE = /(?:^|[-:[])(?:p-blue|blue-\d{2,3})\b|#1b72ba\b/i
const RED = /(?:^|[-:[])(?:red|rose)-\d{2,3}\b/
const FOCUS_PREFIX = /(?:^|:)(?:focus|focus-visible):/

/**
 * Every colour class on the page that breaks the rule, one pass per line
 * (L297). A token is a run between spaces, quotes, braces or parentheses, so a
 * class keeps its variant prefixes and an arbitrary value keeps its brackets.
 */
export function colourViolations(source: string, opts: { greyHints: boolean } = { greyHints: true }): ColourViolation[] {
  const out: ColourViolation[] = []
  source.split('\n').forEach((text, i) => {
    if (isCommentLine(text)) return
    for (const token of text.split(/[\s"'`{}(),;]+/)) {
      if (token === '') continue
      if (/p-blue-light/.test(token)) { out.push({ line: i + 1, rule: 'blue-light', token }); continue }
      if (BLUE.test(token) && !FOCUS_PREFIX.test(token)) { out.push({ line: i + 1, rule: 'blue', token }); continue }
      if (RED.test(token)) { out.push({ line: i + 1, rule: 'red', token }); continue }
      if (opts.greyHints && /(?:^|:)text-gray-500$/.test(token)) out.push({ line: i + 1, rule: 'grey-hint', token })
    }
  })
  return out
}

function rel(file: string): string {
  return path.relative(WEB_SRC, file)
}

describe('the colour scan itself (positive controls)', () => {
  it('refuses a blue selection, a red note, the light blue and the old grey hint', () => {
    const sample = [
      `<span className="rounded bg-p-blue-dark px-2 text-white">On</span>`,
      `<p className="text-xs text-red-700">Nothing is wrong here</p>`,
      `<span className="bg-p-blue-light/10">Synced</span>`,
      `<p className="mt-1 text-xs text-gray-500">A hint</p>`,
      `<div className={selected ? 'border-blue-500' : ''} />`,
      `<i className="bg-[#1B72BA]" />`,
    ].join('\n')
    expect(colourViolations(sample).map((v) => [v.line, v.rule])).toEqual([
      [1, 'blue'], [2, 'red'], [3, 'blue-light'], [4, 'grey-hint'], [5, 'blue'], [6, 'blue'],
    ])
  })

  it('lets a focus ring through, and leaves comments, navy and the hint token alone', () => {
    const sample = [
      `<div className="focus:ring-2 focus:ring-p-blue-dark focus-visible:border-p-blue-dark" />`,
      `// a comment may name text-red-700 and bg-p-blue-dark`,
      `<span className="bg-navy text-white">On</span>`,
      `<p className="text-xs text-hint">A hint</p>`,
      `<Button variant="danger">Remove</Button>`,
    ].join('\n')
    expect(colourViolations(sample)).toEqual([])
  })
})

describe('the partners page keeps the colour rule (#2144)', () => {
  const files = GUARDED_DIRS.flatMap((d) => listFiles(path.join(WEB_SRC, d), { exts: ['.tsx', '.ts'] }))

  it('scans the page (a scan that read nothing would pass)', () => {
    expect(files.length).toBeGreaterThan(25)
    expect(files.map(rel)).toContain(path.join('app/(app)/partners', 'PartnerForm.tsx'))
  })

  it('has no blue outside a button or a focus ring, no red outside the shared problem components, and no grey-500 hint', () => {
    const found = files.flatMap((f) =>
      colourViolations(readFileSync(f, 'utf8')).map((v) => `${rel(f)}:${v.line} ${v.rule} ${v.token}`))
    expect(found, 'Use Button for blue, FieldError or ProblemMark for red, and text-hint for grey hints').toEqual([])
  })

  it('the shared Field draws its hint in the hint token and its error through FieldError', () => {
    const source = readFileSync(path.join(WEB_SRC, FIELD_FILE), 'utf8')
    const field = source.slice(source.indexOf('export function Field('), source.indexOf('export function describedBy('))
    expect(field).toContain('text-hint')
    expect(field).toContain('<FieldError')
    expect(colourViolations(field)).toEqual([])
  })
})

describe('globals.css draws a selection in navy', () => {
  const css = readFileSync(path.join(WEB_SRC, 'app/globals.css'), 'utf8')
  const rule = (selector: string): string => {
    const start = css.indexOf(`${selector} {`)
    if (start === -1) throw new Error(`${selector} is not in globals.css`)
    return css.slice(start, css.indexOf('}', start))
  }

  it.each(['.toggle-on', '.choice-on', '.choice-row-on .choice-dot', '.select-item-indicator'])('%s is navy, never blue', (selector) => {
    const body = rule(selector)
    expect(body).toMatch(/\bnavy\b/)
    expect(body).not.toMatch(/p-blue/)
  })

  it('a checked checkbox is navy (accent colour, since a native box ignores text colour)', () => {
    expect(rule('.checkbox')).toMatch(/accent-navy/)
  })
})

describe('the hint token clears AA on every surface it sits on (#2144)', () => {
  // Tailwind v4 renders its palette from oklch, so these are the hexes the
  // browser paints, not v3's (gray-500 is #6a7282 here, gray-600 #4a5565).
  const BEIGE = '#F9F6F0'
  const GRAY_100 = '#f3f4f6'
  const WHITE = '#FFFFFF'
  const GRAY_500_V4 = '#6a7282'
  const config = readFileSync(path.join(REPO_ROOT, 'apps/web/tailwind.config.ts'), 'utf8')
  const hint = config.match(/\bhint:\s*'(#[0-9a-fA-F]{6})'/)?.[1]

  it('is the shade Dan chose on 2026-10-16', () => {
    expect(hint).toBe('#697081')
  })

  it.each([['beige page', BEIGE], ['gray-100 code', GRAY_100], ['white card', WHITE]])('clears 4.5 to 1 on the %s', (_name, ground) => {
    expect(contrastRatio(hint!, ground)).toBeGreaterThanOrEqual(4.5)
  })

  it('POSITIVE CONTROL: the old text-gray-500 fails on the beige page', () => {
    expect(contrastRatio(GRAY_500_V4, BEIGE)).toBeLessThan(4.5)
  })
})
