/**
 * Guard (#2328): the partners page lets its save judge every number, never the
 * browser. A `step` or `max` on a number box makes the browser stop a save with
 * its own popup (or, in jsdom, do nothing), so the save's reason beside the
 * field is never said. So a partners page NumberInput may carry neither, and the
 * partner form keeps `noValidate`, which stops the browser judging the boxes
 * at all. `min` stays allowed: it only stops the arrows going below it.
 *
 * Each rule has a positive control (L1).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WEB_SRC, listFiles } from './_scan-utils'

const GUARDED_DIRS = ['app/(app)/partners', 'components/partners']
const FORM_FILE = 'app/(app)/partners/PartnerForm.tsx'

const read = (rel: string) => readFileSync(path.join(WEB_SRC, rel), 'utf8')
const rel = (file: string) => path.relative(WEB_SRC, file)
const guarded = () => GUARDED_DIRS.flatMap((d) => listFiles(path.join(WEB_SRC, d), { exts: ['.tsx'] })).filter((f) => !f.includes('__tests__'))

/** The line each NumberInput that sets step or max opens on, reading the whole element, which may span lines. */
export function limitedNumberBoxes(source: string): number[] {
  return [...source.matchAll(/<NumberInput\b[\s\S]*?\/>/g)]
    .filter((m) => /\s(step|max)=[{"]/.test(m[0]))
    .map((m) => source.slice(0, m.index).split('\n').length)
}

describe('partners page numbers are judged by the save, never the browser (#2328)', () => {
  it('finds a number box with a step or a max (positive control)', () => {
    expect(limitedNumberBoxes('<NumberInput id="a" value={1} step={1} onChange={f} />')).toEqual([1])
    expect(limitedNumberBoxes('x\n<NumberInput id="a" value={1} max={100} onChange={f} />')).toEqual([2])
    expect(limitedNumberBoxes('<NumberInput id="a" value={1} min={0} onChange={f} />')).toEqual([])
    expect(limitedNumberBoxes('<NumberInput\n  id="a"\n  step="1"\n/>\n<NumberInput id="b" />')).toEqual([1])
  })

  it('scans the partners page files', () => {
    expect(guarded().length).toBeGreaterThan(20)
    expect(guarded().some((f) => /<NumberInput\b/.test(readFileSync(f, 'utf8')))).toBe(true)
  })

  it('no partners page number box carries a step or a max', () => {
    const found = guarded().flatMap((f) => limitedNumberBoxes(readFileSync(f, 'utf8')).map((line) => `${rel(f)}:${line}`))
    expect(found).toEqual([])
  })

  it('the partner form leaves its boxes to the save (noValidate)', () => {
    expect(read(FORM_FILE)).toMatch(/<form\b[^>]*\bnoValidate\b/)
  })
})
