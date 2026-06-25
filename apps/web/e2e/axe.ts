import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

/**
 * Run axe-core against the current page and fail the test on any serious or
 * critical WCAG 2.0/2.1 A/AA violation (#288). We scope to those tags and
 * impact levels so the check stays meaningful without being brittle on minor
 * best-practice nits.
 *
 * `exclude` skips selectors we don't control or that are known third-party
 * (e.g. the React Flow canvas renderer). Pass an array of CSS selectors.
 */
export async function expectNoSeriousA11yViolations(page: Page, exclude: string[] = []) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
  for (const sel of exclude) builder = builder.exclude(sel)

  const results = await builder.analyze()
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  )

  // Surface a readable summary when it fails (id + help + affected nodes).
  const summary = blocking
    .map((v) => `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n    ${v.helpUrl}`)
    .join('\n')

  expect(blocking, `Serious/critical accessibility violations:\n${summary}`).toEqual([])
}
