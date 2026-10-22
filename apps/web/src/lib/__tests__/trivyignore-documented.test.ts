import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * Every advisory id in `.trivyignore` must be explained in
 * docs/security/dependency-audit-baseline.md, which the doc's own refresh steps
 * require ("never add an id to .trivyignore without a one-line reason there and
 * here") and nothing enforced. An ignore nobody wrote a reason for is one nobody
 * will know when to remove: the eight `next` ids stayed for three months after
 * the upgrade that fixed them, until 2026-10-22.
 *
 * The list is empty today, so the parser is also checked on its own cases below,
 * or this guard would pass having read nothing.
 */
const IGNORE_FILE = path.join(REPO_ROOT, '.trivyignore')
const BASELINE_DOC = path.join(REPO_ROOT, 'docs/security/dependency-audit-baseline.md')

/** The ids an ignore file lists: every non-blank line that is not a comment. */
export function ignoredIds(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0)
}

/**
 * The text of the doc's `## Ignored (.trivyignore)` section, up to the next
 * `## ` heading, or null when there is no such section. Only this section counts:
 * the doc also names REMOVED ids elsewhere, and re-adding one of those must not
 * pass on that mention.
 */
export function ignoredSection(doc: string): string | null {
  const start = doc.search(/^## Ignored \(\.trivyignore\)/m)
  if (start < 0) return null
  const rest = doc.slice(start + 1)
  const next = rest.search(/^## /m)
  return next < 0 ? doc.slice(start) : doc.slice(start, start + 1 + next)
}

/** Whether `text` names `id` as a whole id, so `CVE-2026-6464` is not found inside `CVE-2026-64641`. */
export function namesId(text: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`).test(text)
}

describe('.trivyignore entries are documented', () => {
  it('matches whole ids only', () => {
    expect(namesId('CVE-2026-64641 is safe', 'CVE-2026-64641')).toBe(true)
    expect(namesId('see `CVE-2026-64641`.', 'CVE-2026-64641')).toBe(true)
    expect(namesId('CVE-2026-64641 is safe', 'CVE-2026-6464')).toBe(false)
  })

  it('reads ids and skips comments and blank lines', () => {
    expect(ignoredIds('# header\n\nCVE-2026-1\n  GHSA-abcd-efgh-ijkl  # inline note\n#CVE-2026-2\n')).toEqual([
      'CVE-2026-1',
      'GHSA-abcd-efgh-ijkl',
    ])
  })

  it('reads only the Ignored section, not ids named elsewhere in the doc', () => {
    const doc = '## Patched\nCVE-1\n## Ignored (.trivyignore): x\nCVE-2 is safe\n## Removed\nCVE-3\n'
    expect(ignoredSection(doc)).toBe('## Ignored (.trivyignore): x\nCVE-2 is safe\n')
    expect(ignoredSection('## Patched\n')).toBeNull()
  })

  it('every ignored id has its reason in the Ignored section of the baseline doc', () => {
    const section = ignoredSection(readFileSync(BASELINE_DOC, 'utf8'))
    expect(section, 'docs/security/dependency-audit-baseline.md has no "## Ignored (.trivyignore)" section').not.toBeNull()
    const undocumented = ignoredIds(readFileSync(IGNORE_FILE, 'utf8')).filter((id) => !namesId(section as string, id))
    expect(undocumented, 'explain each in the Ignored section of docs/security/dependency-audit-baseline.md').toEqual([])
  })
})
