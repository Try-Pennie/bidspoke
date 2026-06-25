/**
 * #288: keyboard focus indicators must be visible. The codebase suppressed the
 * native outline (focus:outline-none) and replaced it with a focus ring colored
 * `p-blue-light` (#ECF8FF), which on a white/beige background is ~1.05:1 contrast
 * — effectively invisible. This guard bans `p-blue-light` as a *focus*-ring color
 * so a focus indicator can't silently become unseeable again.
 *
 * Note: `ring-p-blue-light` WITHOUT a focus prefix is allowed — it is used as a
 * subtle canvas node *selection* highlight (paired with a visible border), which
 * is a different concern from keyboard focus.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WEB_SRC, listTsxFiles } from './_scan-utils'

// focus:ring-p-blue-light or focus-visible:ring-p-blue-light (the invisible ring).
const INVISIBLE_FOCUS_RING = /focus(?:-visible)?:ring-p-blue-light/

describe('focus rings are visible (#288)', () => {
  it('no element uses the near-invisible p-blue-light as its focus ring', () => {
    const violations: string[] = []
    const files = [...listTsxFiles(WEB_SRC), path.join(REPO_ROOT, 'apps/web/src/app/globals.css')]
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (INVISIBLE_FOCUS_RING.test(line)) {
            violations.push(`  ${path.relative(REPO_ROOT, file)}:${i + 1}  ${line.trim().slice(0, 100)}`)
          }
        })
    }
    expect(
      violations,
      `Near-invisible focus ring (p-blue-light, ~1.05:1 on white) found. Use a visible ` +
        `color such as ring-p-blue-dark (optionally /40 for a soft glow):\n${violations.join('\n')}`,
    ).toEqual([])
  })
})
