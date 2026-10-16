/**
 * Every time on the partners page goes through dates.ts (#2135, L39, L655).
 *
 * No file under app/(app)/partners or components/partners formats a date or a
 * time itself. The issue named Intl.DateTimeFormat; those files held none when
 * this was written but seven toLocaleString, toLocaleDateString and
 * toLocaleTimeString calls, the same act in another spelling, so a guard keyed
 * on the one name would have passed over all seven (L247). It is keyed on both.
 * Intl.NumberFormat is not a date and is left alone.
 *
 * One pass per file (L297). Seen failing: a scratch Intl.DateTimeFormat call
 * in partner-tabs.ts; every spelling is held by the positive control below.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFiles, sanitizeSource, WEB_SRC } from '../__tests__/_scan-utils'

const ROOTS = [path.join(WEB_SRC, 'app/(app)/partners'), path.join(WEB_SRC, 'components/partners')]
// Assembled from fragments, so this guard's own source never holds the spellings it hunts.
const FORMATTER = new RegExp(['\\bIntl\\.Date', 'TimeFormat\\b|\\.toLocale(?:Date|Time)?', 'String\\s*\\('].join(''), 'g')

/** Each date formatting call in one source file, as "line: text". */
export function dateFormattingIn(src: string): string[] {
  const code = sanitizeSource(src)
  return [...code.matchAll(FORMATTER)].map((m) => `${code.slice(0, m.index).split('\n').length}: ${m[0]}`)
}

describe('the partners page formats every time through dates.ts (#2135)', () => {
  it('no file under app/(app)/partners or components/partners formats a date itself', () => {
    const found = ROOTS.flatMap((root) => listFiles(root)).flatMap((f) => dateFormattingIn(readFileSync(f, 'utf8')).map((hit) => `${path.relative(WEB_SRC, f)}:${hit}`))
    expect(found).toEqual([])
  })

  it('finds each spelling, and passes a number format and a comment', () => {
    const intl = ['Intl', 'DateTimeFormat'].join('.')
    const toLocale = ['to', 'Locale'].join('')
    expect(dateFormattingIn(`const f = new ${intl}('en-US')`)).toHaveLength(1)
    expect(dateFormattingIn(`d.${toLocale}String()\nd.${toLocale}DateString('en-US')\nd.${toLocale}TimeString()`)).toHaveLength(3)
    expect(dateFormattingIn(`new Intl.NumberFormat('en-US')`)).toEqual([])
    expect(dateFormattingIn(`// d.${toLocale}String() was here`)).toEqual([])
  })
})
