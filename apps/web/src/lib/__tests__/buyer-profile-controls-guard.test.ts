/**
 * Guard (#1412, L607, L613): the buyer profile components render their controls
 * through the design system primitives in components/ui/form.tsx, never a raw
 * <input>, <select>, <textarea> or <button>. The primitives own the classes and
 * the labelling, so a hand rolled copy is a control that looks like the OS
 * pasted into the product and may have no accessible name. The primitives file
 * itself is the one place raw elements are allowed.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const dir = fileURLToPath(new URL('.', import.meta.url))
const WEB_SRC = path.resolve(dir, '../..')

/** The components this guard covers: every buyer profile component, listed by its directory. */
const GUARDED_DIRS = ['components/partners/buyer-profile']
const PRIMITIVES = 'components/ui/form.tsx'

const RAW_CONTROL = /<(input|select|textarea|button)\b/g

export function rawControlsIn(source: string): Array<{ line: number; tag: string }> {
  const out: Array<{ line: number; tag: string }> = []
  source.split('\n').forEach((text, i) => {
    const trimmed = text.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    for (const m of text.matchAll(RAW_CONTROL)) out.push({ line: i + 1, tag: m[1] })
  })
  return out
}

function tsxFiles(rel: string): string[] {
  const root = path.join(WEB_SRC, rel)
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx'))
    .map((e) => path.join(root, e.name))
}

describe('buyer profile components use the shared form primitives (L607)', () => {
  it('no guarded component renders a raw input, select, textarea or button', () => {
    const offenders: string[] = []
    for (const rel of GUARDED_DIRS) {
      for (const file of tsxFiles(rel)) {
        for (const hit of rawControlsIn(readFileSync(file, 'utf8'))) {
          offenders.push(`${path.relative(WEB_SRC, file)}:${hit.line} <${hit.tag}>`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the guarded directory exists and holds components, so an empty offender list is a measurement (L1)', () => {
    for (const rel of GUARDED_DIRS) expect(tsxFiles(rel).length, rel).toBeGreaterThan(3)
  })

  it('the primitives file is where the raw elements live, and it renders all four kinds', () => {
    const tags = new Set(rawControlsIn(readFileSync(path.join(WEB_SRC, PRIMITIVES), 'utf8')).map((h) => h.tag))
    expect([...tags].sort()).toEqual(['button', 'input', 'select', 'textarea'])
  })

  it('the detector fires on a hand rolled control and ignores a comment about one', () => {
    const smuggled = ['const x = (', '  <select className="input">', '  // a <button> in a comment is fine', '  <input type="text" />', ')'].join('\n')
    expect(rawControlsIn(smuggled)).toEqual([{ line: 2, tag: 'select' }, { line: 4, tag: 'input' }])
  })
})
