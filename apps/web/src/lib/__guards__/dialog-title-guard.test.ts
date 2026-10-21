/**
 * Guard (#2338 design round 35, Dan 2026-10-21): every dialog's title in
 * Bidspoke is 20px, drawn by the shared `.dialog-title` rule alone
 * (.impeccable.md, Controls). The one Dialog shell gives every title that class
 * (components/Dialog.tsx, held there by dialog-shell-guard.test.ts), so the
 * size is right everywhere exactly when:
 *   1. the `.dialog-title` rule in globals.css sets font-size 20px and no
 *      Tailwind text size;
 *   2. no other rule reaching a dialog title (any selector naming
 *      `.dialog-title`, or a heading inside `.dialog`) sets a size, a font
 *      shorthand or a text size utility;
 *   3. only the shell uses the class, so no component draws a title of its own.
 * One pass over each file (L297), with planted positive controls (L1).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WEB_SRC, cssRules, listFiles } from '../__tests__/_scan-utils'

const GLOBALS = path.join(REPO_ROOT, 'apps/web/src/app/globals.css')
const SHELL = path.join(WEB_SRC, 'components', 'Dialog.tsx')

/** Tailwind's text size utilities, which would set a size through @apply. */
const TEXT_SIZE = /(?:^|\s)text-(?:xs|sm|base|lg|[2-9]?xl|\[[\d.]+(?:px|rem|em)\])(?=\s|;|$)/
const SIZE_DECLARATION = /(?:^|;|\s)(?:font-size|font)\s*:/

/** A selector that reaches a dialog's title: the class named, or a heading inside a dialog's panel. */
function reachesTitle(selector: string): boolean {
  return selector.split(',').some((s) => /\.dialog-title\b/.test(s) || /\.dialog\b[^,]*\b(?:h[1-6]|\[role=['"]?heading)/.test(s))
}

/** The rule's own size: its font-size, or null when it sets none (or sets one through a utility, also reported). */
export function titleRule(css: string): { fontSize: string | null; utility: boolean } | null {
  const rule = cssRules(css).find((r) => r.selector === '.dialog-title')
  if (!rule) return null
  const size = /(?:^|;|\s)font-size\s*:\s*([^;]+)/.exec(rule.body)
  return { fontSize: size ? size[1].trim() : null, utility: TEXT_SIZE.test(rule.body) }
}

/** Every rule other than `.dialog-title` itself that sets a size on a dialog's title. */
export function strayTitleSizes(css: string): string[] {
  return cssRules(css)
    .filter((r) => r.selector !== '.dialog-title' && reachesTitle(r.selector))
    .filter((r) => SIZE_DECLARATION.test(r.body) || TEXT_SIZE.test(r.body))
    .map((r) => r.selector)
}

describe("every dialog's title is 20px, by one rule (round 35)", () => {
  const css = readFileSync(GLOBALS, 'utf8')

  it('the shared rule sets 20px, and no text size utility', () => {
    expect(titleRule(css)).toEqual({ fontSize: '20px', utility: false })
  })

  it('no other rule sets the size of a dialog title', () => {
    expect(strayTitleSizes(css)).toEqual([])
  })

  it('only the Dialog shell draws a dialog title', () => {
    const files = listFiles(WEB_SRC, { exts: ['.tsx', '.ts'] }).filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`) && !f.includes(`${path.sep}__guards__${path.sep}`))
    expect(files).toContain(SHELL)
    const users = files.filter((f) => /\bdialog-title\b/.test(readFileSync(f, 'utf8')))
    expect(users.map((f) => path.relative(WEB_SRC, f))).toEqual([path.relative(WEB_SRC, SHELL)])
  })
})

describe('the scanner, on text it must judge both ways', () => {
  it('reads the rule and its size, and a size given only by a utility', () => {
    expect(titleRule('@layer components { .dialog-title { @apply font-semibold text-graphite; font-size: 20px; } }')).toEqual({ fontSize: '20px', utility: false })
    expect(titleRule('.dialog-title { @apply text-base font-semibold text-graphite; }')).toEqual({ fontSize: null, utility: true })
    expect(titleRule('.dialog { gap: 8px }')).toBeNull()
  })

  it('finds a second rule sizing a title by class, by heading, by shorthand or by utility, and passes one that only colours it', () => {
    const planted = [
      '.cx-dialog .dialog-title { font-size: 20px; font-weight: 600 }',
      '.dialog.wide h2 { font: 600 18px/1.4 sans-serif }',
      '.merge .dialog-title { @apply text-lg }',
      '.dialog-title, .x { font-size: 1rem }',
      '.quiet .dialog-title { color: #1D212F; margin: 0 }',
      '.dialog-description { font-size: 14px }',
    ].join('\n')
    expect(strayTitleSizes(planted)).toEqual(['.cx-dialog .dialog-title', '.dialog.wide h2', '.merge .dialog-title', '.dialog-title, .x'])
  })
})
