import { test } from '@playwright/test'
import { expectNoSeriousA11yViolations } from './axe'

/**
 * Automated accessibility checks (#288). Runs axe-core against the key
 * authenticated pages plus the public login page and fails on serious/critical
 * WCAG A/AA violations. Complements the static jsx-a11y lint rules with runtime
 * checks (color contrast, ARIA in rendered state, etc.).
 *
 * Every page listed here must be READ-ONLY. This is the spec the CI gate runs
 * (with E2E_SKIP_TEARDOWN=1, see the Accessibility job in ci.yml), so it creates
 * no fixtures and has nothing to sweep. Do not add a page that writes.
 *
 * Coverage note (#674): this originally watched 5 of the app's page areas, so
 * #671 fixed contrast only where the scanner happened to look while 64 uses of
 * the same failing colour sat unwatched on 5 other pages. Prefer adding a page
 * here over assuming it is fine.
 *
 * Note: the React Flow canvas renderer is excluded where present — it is
 * third-party and not something we control. Re-scope once a baseline exists.
 */

/** `exclude` holds CSS selectors for third-party subtrees we do not control. */
const PAGES: { name: string; path: string; exclude?: string[] }[] = [
  { name: 'dashboard', path: '/dashboard' },
  { name: 'sources page', path: '/sources' },
  { name: 'environment page', path: '/env' },
  // Exclude the React Flow canvas if a preview renders one.
  { name: 'workflows list', path: '/workflows', exclude: ['.react-flow'] },
  // Added in #674. /access and /settings are only redirects to /settings/access,
  // so the two real settings pages are listed instead.
  { name: 'integrations page', path: '/integrations' },
  { name: 'endpoints page', path: '/endpoints' },
  { name: 'partners page', path: '/partners' },
  { name: 'settings access page', path: '/settings/access' },
  { name: 'settings api keys page', path: '/settings/api-keys' },
]

test.describe('Accessibility (axe-core)', () => {
  test('login page has no serious a11y violations', async ({ page }) => {
    // Public page — clear the stored auth so we land on /login.
    await page.context().clearCookies()
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    await expectNoSeriousA11yViolations(page)
  })

  for (const { name, path, exclude } of PAGES) {
    test(`${name} has no serious a11y violations`, async ({ page }) => {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      await expectNoSeriousA11yViolations(page, exclude)
    })
  }
})
