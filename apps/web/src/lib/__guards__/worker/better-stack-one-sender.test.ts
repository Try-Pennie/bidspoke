/**
 * Every line the Worker sends to Better Stack goes through ONE request (#2364).
 *
 * Three senders grew their own copy of the same POST: the nobody can be told
 * page and its drill (#2063, #1303), and the row cap report (#1436). The Slack
 * refusal page (#2364) would have been a fourth. A drill can prove only the
 * request it makes, so a page sending through a copy is a page nobody has
 * proven, and a fix to the token handling in one copy is a fix to one sender.
 * So the POST lives in lib/better-stack-line.ts alone, every sender imports it,
 * and no other Worker file posts to the Better Stack source.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

const LIB = path.join(WORKER_SRC, 'lib')
const SENDER = path.join(LIB, 'better-stack-line.ts')
const SENDERS = ['nobody-told-page.ts', 'row-cap.ts', 'slack-refusal-watch.ts']

const read = (file: string) => sanitizeSource(readFileSync(file, 'utf8'), { blankStrings: false })

describe('one Better Stack request (#2364)', () => {
  it('better-stack-line.ts makes exactly one POST', () => {
    expect(read(SENDER).match(/method: 'POST'/g) ?? []).toHaveLength(1)
  })

  it.each(SENDERS)('%s sends through it, with no POST of its own', (name) => {
    const src = read(path.join(LIB, name))
    expect(src).toMatch(/from '\.\/better-stack-line'/)
    expect(src.match(/method: 'POST'/g) ?? []).toHaveLength(0)
  })

  it('no other Worker file posts with a Better Stack bearer token', () => {
    const others = listTsFiles(WORKER_SRC)
      .filter((f) => f !== SENDER && !f.replace(/\\/g, '/').includes('/__tests__/'))
      .filter((f) => /betterstack|better.?stack/i.test(read(f)) && /method: 'POST'/.test(read(f)) && /Authorization: `Bearer \$\{[^}]*(?:token|target)/i.test(read(f)))
      .map((f) => path.relative(WORKER_SRC, f).replace(/\\/g, '/'))
    expect(others).toEqual([])
  })
})
