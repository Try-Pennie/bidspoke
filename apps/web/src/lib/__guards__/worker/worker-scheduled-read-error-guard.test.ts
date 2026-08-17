import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * A scheduled check that reads Supabase must capture the read's `error`.
 *
 * Issue #439. These readers destructured only `{ data }`, so a failed read came
 * back as `null`, was coalesced to `[]`, and the check reported "nothing to
 * alert on". A transient database error and a genuinely healthy system produced
 * the identical outcome, with nothing written to the log either way.
 *
 * The worst shape is the Slack-connection lookup at the top of nearly every
 * check: on a failed read the org list is empty, the function returns early, and
 * EVERY alert that check owns silently does not run for that tick. The system
 * looks quietest exactly when it is least able to see (LESSONS L98, and the
 * recurring invisible-outage class of #303).
 *
 * The rule is deliberately narrow: capture the error and say something. It does
 * not dictate what to do next, because for most of these there is nothing useful
 * to do beyond making the blind spot visible.
 *
 * A site that genuinely does not want it opts out in writing with
 * `// read-guard-ok: <reason>` on the same statement, matching the convention
 * worker-db-error-guard.test.ts already uses.
 */
const LIB = path.join(WORKER_SRC, 'lib')

export interface Finding {
  file: string
  line: number
  text: string
}

/**
 * Destructured Supabase reads that take `data` without `error`.
 *
 * Matches `const { data } = await supabase…` and its renamed form
 * `const { data: rows } = await supabase…`, which is how every one of these is
 * written.
 */
export function findUncheckedReads(rawSrc: string, file: string): Finding[] {
  const src = sanitizeSource(rawSrc, { blankStrings: false })
  const out: Finding[] = []
  const re = /const\s*\{([^}]*)\}\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const bindings = m[1]
    if (!/\bdata\b/.test(bindings)) continue
    if (/\berror\b/.test(bindings)) continue

    // Only Supabase-shaped reads: straight off the client, or off a captured
    // response of one. Anything else destructuring a `data` field is not this.
    const receiver = m[2]
    if (!/^(supabase|.*[Rr]es|.*[Rr]esult|.*[Rr]esponse)$/.test(receiver)) continue

    const lineStart = src.lastIndexOf('\n', m.index) + 1
    const lineEnd = src.indexOf('\n', m.index)
    const line = src.slice(0, m.index).split('\n').length
    const raw = rawSrc.split('\n')[line - 1] ?? ''
    // An explicit, written opt-out on the same line.
    if (/read-guard-ok:/.test(raw)) continue
    out.push({ file, line, text: src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim() })
  }
  return out
}

const findings = listTsFiles(LIB).flatMap((f) => findUncheckedReads(readFileSync(f, 'utf8'), f))

describe('scheduled reads capture their Supabase error (#439)', () => {
  it('has no read that drops the error', () => {
    const described = findings.map((f) => `${f.file.replace(/.*apps\//, 'apps/')}:${f.line} ${f.text}`)
    expect(described, 'a failed read must not read as "nothing to alert on"').toEqual([])
  })

  it('scanned real files, so it cannot pass vacuously', () => {
    expect(listTsFiles(LIB).length).toBeGreaterThan(20)
  })

  it('flags a read that takes only data', () => {
    const found = findUncheckedReads('const { data } = await supabase.from("x").select("*")', 'x.ts')
    expect(found).toHaveLength(1)
  })

  it('flags the renamed form too', () => {
    expect(findUncheckedReads('const { data: conns } = await supabase.from("x").select()', 'x.ts')).toHaveLength(1)
  })

  it('accepts a read that captures the error', () => {
    expect(findUncheckedReads('const { data, error } = await supabase.from("x").select()', 'x.ts')).toEqual([])
  })

  it('accepts the renamed error form', () => {
    expect(findUncheckedReads('const { data: conns, error: connsError } = await supabase.from("x").select()', 'x.ts')).toEqual([])
  })

  it('honours a written opt-out', () => {
    expect(findUncheckedReads('const { data } = await supabase.from("x").select() // read-guard-ok: best effort', 'x.ts')).toEqual([])
  })

  it('ignores destructuring that is not a Supabase read', () => {
    expect(findUncheckedReads('const { data } = props', 'x.ts')).toEqual([])
    expect(findUncheckedReads('const { data } = chart', 'x.ts')).toEqual([])
  })

  it('catches a read off a captured response object', () => {
    expect(findUncheckedReads('const { data: rows } = uuidRes', 'x.ts')).toHaveLength(1)
  })
})
