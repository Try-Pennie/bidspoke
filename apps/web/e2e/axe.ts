import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { checkScannedPage } from '../src/lib/scanned-page'

/**
 * Run axe-core against the current page and fail the test on any serious or
 * critical WCAG 2.0/2.1 A/AA violation (#288). We scope to those tags and
 * impact levels so the check stays meaningful without being brittle on minor
 * best-practice nits.
 *
 * `exclude` skips selectors we don't control or that are known third-party
 * (e.g. the React Flow canvas renderer). Pass an array of CSS selectors.
 *
 * `include` limits the scan to one surface, a dialog for example (#2134), so a
 * test about that surface measures it rather than the page behind it.
 *
 * There is no contrast waiver: the partners page's grey hints took the hint
 * token (#2144), and every colour-contrast failure fails the scan.
 */
export async function expectNoSeriousA11yViolations(
  page: Page,
  exclude: string[] = [],
  expectedPath?: string,
  include?: string,
) {
  // Prove the page under the scanner is the page that was asked for, and that
  // it rendered, BEFORE measuring it (#797). The rule itself is a pure function
  // in src/lib/scanned-page.ts with its own unit tests, because a decision that
  // can only be exercised by driving a browser gets verified once by hand and
  // then never again.
  const verdict = checkScannedPage({
    actualPath: new URL(page.url()).pathname,
    expectedPath,
    visibleTextLength: (await page.locator('body').innerText()).trim().length,
  })
  expect(verdict.ok, verdict.ok ? '' : verdict.message).toBe(true)

  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
  for (const sel of exclude) builder = builder.exclude(sel)
  if (include) builder = builder.include(include)

  const results = await builder.analyze()
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  )

  // A scan that measured the contrast of no text at all is not a pass (L98), so
  // the count is asserted and printed: green is shown to mean scanned (#2144).
  const contrastPassed = results.passes.find((r) => r.id === 'color-contrast')?.nodes.length ?? 0
  const contrastFailed = results.violations.find((r) => r.id === 'color-contrast')?.nodes.length ?? 0
  console.log(`  [axe] ${expectedPath ?? new URL(page.url()).pathname}${include ? ` ${include}` : ''}: ${contrastPassed} elements passed color-contrast, ${contrastFailed} failed`)
  expect(contrastPassed + contrastFailed, 'axe measured the contrast of no text').toBeGreaterThan(0)

  // Surface a readable summary when it fails (id + help + affected nodes).
  const summary = blocking
    .map((v) => `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n    ${v.helpUrl}`)
    .join('\n')

  expect(blocking, `Serious/critical accessibility violations:\n${summary}`).toEqual([])
}
