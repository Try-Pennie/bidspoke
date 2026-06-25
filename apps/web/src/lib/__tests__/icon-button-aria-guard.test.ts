/**
 * #273 category 3: icon-only buttons must carry an accessible name. The
 * jsx-a11y linter cannot catch these — it can't see that a lucide icon component
 * (e.g. <Trash2 />) renders no text — so this static guard fills the gap.
 *
 * A <button> is flagged ONLY when ALL of these hold (conservative, to avoid
 * false positives on dynamic content):
 *   - the opening tag has no aria-label / aria-labelledby, AND
 *   - after stripping child JSX tags, the children contain no visible text, AND
 *   - the children contain no `{expression}` (which could render dynamic text).
 * So `<button><X /></button>` is flagged, while `<button>{name}</button>`,
 * `<button><Icon/> Save</button>`, and `<button aria-label="Close"><X/></button>`
 * are not. Add an aria-label describing the action to fix a flagged button.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WEB_SRC, listTsxFiles } from './_scan-utils'

// Find the index just past the `>` that closes the JSX opening tag starting at
// `start` (the index of '<button'). Tracks string literals and brace depth so a
// `>` inside an attribute expression (e.g. onClick={() => x}) isn't mistaken for
// the tag end. Returns -1 if not found.
function openTagEnd(src: string, start: number): number {
  let depth = 0
  let quote = ''
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return i + 1
  }
  return -1
}

/** Returns flagged button descriptions (empty = all good) for one file's source. */
export function findUnlabeledIconButtons(src: string): { line: number; excerpt: string }[] {
  const flagged: { line: number; excerpt: string }[] = []
  const re = /<button(\s|>)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const tagStart = m.index
    const tagEnd = openTagEnd(src, tagStart)
    if (tagEnd < 0) continue
    const openTag = src.slice(tagStart, tagEnd)
    if (/\baria-label\b|\baria-labelledby\b/.test(openTag)) continue
    const closeIdx = src.indexOf('</button>', tagEnd)
    if (closeIdx < 0) continue
    const children = src.slice(tagEnd, closeIdx)
    // A `{...}` child could render dynamic text — too risky to flag.
    if (children.includes('{')) continue
    // Strip child JSX tags (icons/elements); whatever text remains is the name.
    const text = children.replace(/<[^>]*>/g, '').replace(/\s+/g, '')
    if (text.length > 0) continue
    const line = src.slice(0, tagStart).split('\n').length
    flagged.push({ line, excerpt: openTag.replace(/\s+/g, ' ').slice(0, 80) })
  }
  return flagged
}

describe('icon-only buttons have accessible names (#273)', () => {
  it('every icon-only <button> in the web UI has an aria-label', () => {
    const violations: string[] = []
    for (const file of listTsxFiles(WEB_SRC)) {
      for (const v of findUnlabeledIconButtons(readFileSync(file, 'utf8'))) {
        violations.push(`  ${path.relative(REPO_ROOT, file)}:${v.line}  ${v.excerpt}`)
      }
    }
    expect(
      violations,
      `Icon-only buttons with no accessible name found. Add an aria-label describing ` +
        `the action (e.g. aria-label="Delete row"):\n${violations.join('\n')}`,
    ).toEqual([])
  })
})

// Unit coverage for the detector itself.
describe('findUnlabeledIconButtons detector', () => {
  it('flags a bare icon button', () => {
    expect(findUnlabeledIconButtons('<button><X /></button>')).toHaveLength(1)
  })
  it('passes a button with aria-label', () => {
    expect(findUnlabeledIconButtons('<button aria-label="Close"><X /></button>')).toEqual([])
  })
  it('passes a button with visible text', () => {
    expect(findUnlabeledIconButtons('<button><Save /> Save changes</button>')).toEqual([])
  })
  it('passes a button with a dynamic {expression} child', () => {
    expect(findUnlabeledIconButtons('<button>{sp.name}</button>')).toEqual([])
  })
  it('is not fooled by > inside an attribute arrow function', () => {
    expect(findUnlabeledIconButtons('<button onClick={() => go()}><X /></button>')).toHaveLength(1)
  })
})
