import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { checkScannedPage } from '../src/lib/scanned-page'
import { waivableSelector, waivedInDocument, type ContrastWaiver } from './contrast-waiver'

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
 * `contrastWaiver` lets through ONE known colour-contrast failure, text in the
 * named class inside the named surface, in the main document only
 * (contrast-waiver.ts), until the named issue sets its new shade. Every
 * other contrast failure, and every other rule, still fails the scan. It exists
 * for the partners page form (#2137), whose grey hint text on the beige
 * background PR13 (#2144) recolours once Dan picks the shade; the waiver is
 * deleted there.
 */
export async function expectNoSeriousA11yViolations(
  page: Page,
  exclude: string[] = [],
  expectedPath?: string,
  include?: string,
  contrastWaiver?: ContrastWaiver,
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
  let blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  )
  if (contrastWaiver) {
    // Only a main document node, inside the waiver's surface and class (contrast-waiver.ts).
    const waived = async (target: unknown) => {
      const selector = waivableSelector(target)
      if (selector === null) return false
      return page.evaluate(`(${waivedInDocument.toString()})(document, ${JSON.stringify(selector)}, ${JSON.stringify(contrastWaiver)})`) as Promise<boolean>
    }
    const kept = []
    for (const v of blocking) {
      if (v.id !== 'color-contrast') { kept.push(v); continue }
      const nodes = []
      for (const n of v.nodes) if (!(await waived(n.target))) nodes.push(n)
      if (nodes.length > 0) kept.push({ ...v, nodes })
    }
    blocking = kept
  }

  // Surface a readable summary when it fails (id + help + affected nodes).
  const summary = blocking
    .map((v) => `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n    ${v.helpUrl}`)
    .join('\n')

  expect(blocking, `Serious/critical accessibility violations:\n${summary}`).toEqual([])
}
