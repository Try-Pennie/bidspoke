import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WEB_SRC } from './_scan-utils'

/**
 * The shared Select's list shows its scrollbar (#2137, L76). Radix hides it
 * with an unlayered style of its own, and an unlayered rule beats every rule
 * inside a cascade layer whatever the specificity, so an override written in
 * Tailwind's `@layer components` silently loses: the first screenshots of the
 * Used by list (12 options in 10 rows of room) showed no scrollbar at all.
 * This keeps the override outside every layer.
 */
const GLOBALS = path.join(WEB_SRC, 'app/globals.css')
const OVERRIDE = '.select-viewport[data-radix-select-viewport]'

/**
 * For each line, whether it sits inside an `@layer` block, by brace depth. A
 * block's prelude is everything since the last brace or semicolon, so an
 * `@layer` header with its brace on the next line still counts.
 */
export function layeredLines(css: string): boolean[] {
  const out: boolean[] = []
  const stack: boolean[] = []
  let prelude = ''
  for (const line of css.split('\n')) {
    out.push(stack.includes(true))
    for (const ch of line + '\n') {
      if (ch === '{') { stack.push(/@layer\b/.test(prelude)); prelude = '' }
      else if (ch === '}') { stack.pop(); prelude = '' }
      else if (ch === ';') prelude = ''
      else prelude += ch
    }
  }
  return out
}

describe("the Select list's scrollbar override", () => {
  it('sits outside every @layer, so it beats the Radix style that hides the scrollbar', () => {
    const css = readFileSync(GLOBALS, 'utf8')
    const lines = css.split('\n')
    const layered = layeredLines(css)
    const hits = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.includes(OVERRIDE))
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits.filter(({ i }) => layered[i]).map(({ i }) => i + 1)).toEqual([])
    expect(css).toMatch(/\.select-viewport\[data-radix-select-viewport\]::-webkit-scrollbar\s*\{[^}]*display:\s*block/)
  })

  it('positive control: a rule inside @layer components is seen as layered', () => {
    const css = ['@layer components {', '  .a {', '    color: red;', '  }', '}', '.b { color: blue; }'].join('\n')
    expect(layeredLines(css)).toEqual([false, true, true, true, true, false])
    // The header's brace on the next line.
    expect(layeredLines(['@layer components', '{', '  .a { color: red; }', '}', '.b { color: blue; }'].join('\n'))).toEqual([false, false, true, true, false])
  })
})
