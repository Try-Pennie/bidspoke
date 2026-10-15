/**
 * The engine's default error rules live in one constant (#2143, PM-11).
 *
 * DEFAULT_ERROR_RULES in @bidspoke/buyer-profile is what the partners page
 * lists as Default rows under a partner's own rules, and the classifier reads
 * every decision, status, marker and name from it. A default written back into
 * apps/worker/src/engine/error-classifier.ts as a literal would be applied by
 * the engine and missing from the page, so this fails on any of the literals
 * the rules hold. Comments are blanked first; strings are not, since a marker
 * is a string.
 *
 * Seen red by putting `if (status === 429) return 'transient'` back into
 * classifyHttpError.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ERROR_RULES, type DefaultErrorRule } from '@bidspoke/buyer-profile'
import { sanitizeSource, WORKER_SRC } from '@/lib/__tests__/_scan-utils'

/** Every status, marker and name a default rule holds, as it would be spelled in source. */
function literalsOf(rules: readonly DefaultErrorRule[]): string[] {
  const out: string[] = []
  for (const { match } of rules) {
    if (match.kind === 'status') out.push(...match.statuses.map(String))
    if (match.kind === 'status_from') out.push(String(match.from))
    if (match.kind === 'saturated') out.push(...match.markers)
    if (match.kind === 'code_error') out.push(...match.names, match.networkFailureName, ...match.unlessMessageContains)
  }
  return [...new Set(out)]
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('the classifier holds no default beside DEFAULT_ERROR_RULES (#2143)', () => {
  it("names none of the rules' statuses, markers or names itself", () => {
    const literals = literalsOf(DEFAULT_ERROR_RULES as readonly DefaultErrorRule[])
    expect(literals.length).toBeGreaterThan(10)
    const source = sanitizeSource(readFileSync(path.join(WORKER_SRC, 'engine/error-classifier.ts'), 'utf8'), { blankStrings: false })
    const found = literals.filter((l) => new RegExp(`(^|[^A-Za-z0-9_])${escape(l)}([^A-Za-z0-9_]|$)`, 'i').test(source))
    expect(found).toEqual([])
  })
})
