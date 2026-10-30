/**
 * Guard (#3087): a buyer_select reason code is worded by the one `reasonLabel`
 * in @bidspoke/buyer-profile. The run page, the canvas card and the live share
 * Slack line each looked a code up in OUT_REASON_LABELS or NODE_REASON_LABELS by
 * a string of their own, and one of them read an inherited member such as
 * `constructor` as a label. This fails on any such lookup outside the package:
 * `reason in OUT_REASON_LABELS`, or the list cast to a string keyed record. An
 * index by a value already typed as a reason (`OUT_REASON_LABELS[r]` over
 * OUT_REASONS) is not a lookup of an unknown code and passes. One pass per file
 * (L297), with planted controls (L1).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WEB_SRC, WORKER_SRC, listFiles, sanitizeSource } from '../__tests__/_scan-utils'

const LOOKUP = /\bin\s+(?:OUT|NODE)_REASON_LABELS\b|\b(?:OUT|NODE)_REASON_LABELS\s+as\s+Record\b/

/** Whether a source file looks a reason code up in either label list by an untyped string. */
export function looksUpReasonLabels(source: string): boolean {
  return LOOKUP.test(sanitizeSource(source))
}

const PACKAGE_SRC = path.join(REPO_ROOT, 'packages/buyer-profile/src')
const isTest = (f: string) => /__tests__|\.test\.tsx?$/.test(f)

const lookups = (root: string): string[] =>
  listFiles(root, { exts: ['.ts', '.tsx'] })
    .filter((f) => !isTest(f))
    .filter((f) => looksUpReasonLabels(readFileSync(f, 'utf8')))
    .map((f) => path.relative(REPO_ROOT, f))

describe('one reasonLabel words a buyer_select reason code (#3087)', () => {
  it('no web or worker file looks a reason code up in the label lists itself', () => {
    expect([...lookups(WEB_SRC), ...lookups(WORKER_SRC)]).toEqual([])
  })

  it('finds the one lookup it protects, in the package, so it cannot pass by matching nothing', () => {
    expect(lookups(PACKAGE_SRC)).toEqual(['packages/buyer-profile/src/vocab.ts'])
  })

  it('catches each spelling the three copies used', () => {
    expect(looksUpReasonLabels('if (reason in OUT_REASON_LABELS) return OUT_REASON_LABELS[reason as OutReason]')).toBe(true)
    expect(looksUpReasonLabels('return (OUT_REASON_LABELS as Record<string, string | undefined>)[reason as OutReason] ?? reason')).toBe(true)
    expect(looksUpReasonLabels('const node = (NODE_REASON_LABELS as Record<string, string>)[reason as NodeReason]')).toBe(true)
  })

  it('lets an index by a typed reason through', () => {
    expect(looksUpReasonLabels('RECORDED_REFUSAL_REASONS.map((r) => OUT_REASON_LABELS[r])')).toBe(false)
  })
})
