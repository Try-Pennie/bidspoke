/**
 * Guard (#2338 design round 32, Dan 2026-10-21, "Level with the capitals"): the
 * spinner on a working line is as tall as the capital letters and level with
 * them, in every working line in the app. One rule in globals.css sizes it,
 * `.outcome svg`, so nothing else may: no other rule that reaches an svg inside
 * an `.outcome` line, and no size on an icon inside a working line in any
 * component (a Tailwind h-, w- or size- class, or a size, width or height
 * prop), which would beat or fight the rule. One pass over each file (L297),
 * with planted positive controls (L1).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WEB_SRC, cssRules, listFiles } from '../__tests__/_scan-utils'

const GLOBALS = path.join(REPO_ROOT, 'apps/web/src/app/globals.css')

/** The one rule, as Dan chose it in round 32. */
const THE_RULE = { selector: '.outcome svg', declarations: { width: '0.95em', height: '0.95em', flex: 'none', position: 'relative', top: '-0.1em' } }

/** The CSS rules other than THE_RULE that reach an svg inside an .outcome line. */
export function strayOutcomeSvgRules(css: string): string[] {
  return cssRules(css)
    .filter((r) => r.selector.split(',').some((s) => /\.outcome[\w-]*\b[^,]*\bsvg\b/.test(s)))
    .filter((r) => r.selector !== THE_RULE.selector)
    .map((r) => r.selector)
}

export function theRuleDeclarations(css: string): Record<string, string> | null {
  const rule = cssRules(css).find((r) => r.selector === THE_RULE.selector)
  if (!rule) return null
  return Object.fromEntries(rule.body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const [k, ...v] = d.split(':')
    return [k.trim(), v.join(':').trim()]
  }))
}

const SIZED = /\b(?:h|w|size)-(?:\[[^\]]+\]|[\d.]+|px|full|auto)\b|\b(?:size|width|height)=\{|\b(?:size|width|height)="/

/** The working lines in a component that size an icon inside them: each `<... outcome-working ...>` element through its close. */
export function sizedSpinners(source: string): string[] {
  const found: string[] = []
  const open = /<(\w+)\b[^>]*\boutcome-working\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = open.exec(source))) {
    const close = source.indexOf(`</${m[1]}>`, m.index)
    const inner = source.slice(m.index + m[0].length, close < 0 ? undefined : close)
    for (const tag of inner.match(/<[A-Z]\w*\b[^>]*\/?>|<svg\b[^>]*>/g) ?? []) {
      if (SIZED.test(tag)) found.push(tag)
    }
  }
  return found
}

describe('the spinner on a working line is sized by one rule only (round 32)', () => {
  const css = readFileSync(GLOBALS, 'utf8')

  it('globals.css holds the rule Dan chose, exactly', () => {
    expect(theRuleDeclarations(css)).toEqual(THE_RULE.declarations)
  })

  it('no other rule reaches a working line\'s svg', () => {
    expect(strayOutcomeSvgRules(css)).toEqual([])
  })

  it('no component sizes an icon inside a working line', () => {
    const files = listFiles(WEB_SRC, { exts: ['.tsx'] }).filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`))
    const offenders = files.flatMap((f) => sizedSpinners(readFileSync(f, 'utf8')).map((t) => `${path.relative(REPO_ROOT, f)}: ${t}`))
    expect(files.some((f) => f.endsWith(path.join('components', 'ui', 'form.tsx')))).toBe(true)
    expect(offenders).toEqual([])
  })
})

describe('the scanner, on text it must judge both ways', () => {
  it('finds a sized icon in a working line, by class or by prop', () => {
    expect(sizedSpinners('<p role="status" className="outcome outcome-working">\n<Loader2 className="h-3.5 w-3.5 animate-spin" />Saving</p>')).toHaveLength(1)
    expect(sizedSpinners('<p className="outcome outcome-working"><Loader2 size={14} />x</p>')).toHaveLength(1)
    expect(sizedSpinners('<span className="outcome outcome-working"><svg width="12">x</svg></span>')).toHaveLength(1)
  })

  it('passes an unsized icon, and a sized icon outside any working line', () => {
    expect(sizedSpinners('<p className="outcome outcome-working"><Loader2 className="animate-spin" aria-hidden="true" />x</p>')).toEqual([])
    expect(sizedSpinners('<p className="outcome outcome-done">Done</p><Loader2 className="h-4 w-4" />')).toEqual([])
  })

  it('finds a second rule sizing the svg, inside a layer or not, and reads the rule itself', () => {
    const planted = '@layer components { .outcome svg { width: 0.95em; height: 0.95em; flex: none; position: relative; top: -0.1em } .outcome-working svg { width: 14px } }\n.cx-page .outcome svg { top: 0 }'
    expect(strayOutcomeSvgRules(planted)).toEqual(['.outcome-working svg', '.cx-page .outcome svg'])
    expect(theRuleDeclarations(planted)).toEqual(THE_RULE.declarations)
    expect(theRuleDeclarations('.outcome { gap: 4px }')).toBeNull()
  })
})
