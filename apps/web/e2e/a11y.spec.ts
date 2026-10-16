import { expect, test, type Page } from '@playwright/test'
import { expectNoSeriousA11yViolations } from './axe'
import { routePartnerFixtures } from './partner-fixtures'

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
 * The partners page is the exception that proves it (#2134): every Worker call
 * it makes is answered from e2e/fixtures/partners/ (partner-fixtures.ts), so its
 * dialogs, which need a save or a delete, are scanned without anything reaching
 * production, and a call with no fixture fails the test rather than going out.
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
  { name: 'settings access page', path: '/settings/access' },
  { name: 'settings api keys page', path: '/settings/api-keys' },
]

test.describe('Accessibility (axe-core)', () => {
  test('login page has no serious a11y violations', async ({ page }) => {
    // Public page — clear the stored auth so we land on /login.
    await page.context().clearCookies()
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    await expectNoSeriousA11yViolations(page, [], '/login')
  })

  // #2134: the partners page, its merge dialog and its matrix delete dialog,
  // answered from fixtures. Each asserts the surface it is about is on screen
  // before it scans, so a scan of the wrong page or of nothing cannot pass, and
  // that no Worker call went unanswered. A dialog's scan is limited to the
  // dialog: the open partner's form behind it still carries native controls
  // without names, which PR6 (#2137) replaces, and scanning it here would fail
  // every run on a finding this pull request does not own.
  test('partners page, with a missing credential, has no serious a11y violations', async ({ page }) => {
    const { unmatched } = await routePartnerFixtures(page, workerUrl(), { credentialWarningFor: 'amone' })
    await page.goto('/partners')
    // The list at the real nine, with the missing credential marked on its row.
    await expect(page.getByRole('button', { name: /Tripoint/ })).toBeVisible()
    await expect(page.getByText(/Credential 'AMONE_PROXY_SECRET' is not set/)).toBeAttached()
    await page.waitForLoadState('networkidle')
    await expectNoSeriousA11yViolations(page, [], '/partners')
    expect(unmatched).toEqual([])
  })

  test('the partners page merge dialog has no serious a11y violations', async ({ page }) => {
    const { unmatched } = await routePartnerFixtures(page, workerUrl(), { staleSave: true })
    await openTripoint(page)
    await page.getByLabel('Leads per day', { exact: true }).fill('300')
    await page.getByRole('button', { name: /Save changes/ }).click()
    // The recorded 409 must conflict with this exact edit; partner-fixtures.test.ts
    // holds that, and a dialog that does not open says which fixture to look at.
    await expect(
      page.getByRole('dialog', { name: /saved this partner while you were editing/ }),
      'the merge dialog did not open: synthetic/page-save-409.tripoint.json must change Leads per day (daily_lead_cap) away from 300',
    ).toBeVisible()
    await expectDialogs(page)
    await expectNoSeriousA11yViolations(page, [], '/partners', '[role="dialog"]')
    expect(unmatched).toEqual([])
  })

  test('the partners page matrix delete dialog has no serious a11y violations', async ({ page }) => {
    const { unmatched } = await routePartnerFixtures(page, workerUrl(), { matrix: true })
    await openTripoint(page)
    await page.getByRole('button', { name: 'Matrix lookup' }).click()
    await page.getByRole('button', { name: 'Delete this matrix' }).click()
    await expect(page.getByRole('alertdialog', { name: /^Delete matrix/ })).toBeVisible()
    await expectDialogs(page)
    await expectNoSeriousA11yViolations(page, [], '/partners', '[role="alertdialog"]')
    expect(unmatched).toEqual([])
  })

  // #2140: the delete box at the foot of the partner, both ways it can stand.
  // Each scan is limited to the box: the form above it still carries native
  // controls PR6 replaces, which this pull request does not own.
  test('the partners page delete box, blocked by sales, has no serious a11y violations', async ({ page }) => {
    const { unmatched } = await routePartnerFixtures(page, workerUrl())
    await openTripoint(page)
    const box = page.getByRole('region', { name: 'Delete Tripoint' })
    await expect(box.getByText(/Tripoint cannot be deleted: 6,339 sales refer to it\./)).toBeVisible()
    await expect(box.getByLabel('Type DELETE to confirm')).toHaveCount(0)
    await expectNoSeriousA11yViolations(page, [], '/partners', '[aria-labelledby="partner-delete-title"]')
    expect(unmatched).toEqual([])
  })

  test('the partners page delete box, ready to delete, has no serious a11y violations', async ({ page }) => {
    const { unmatched } = await routePartnerFixtures(page, workerUrl())
    await page.goto('/partners?selected=liberty1')
    const box = page.getByRole('region', { name: 'Delete Liberty1' })
    await expect(box.getByLabel('Type DELETE to confirm')).toBeVisible()
    await box.getByLabel('Type DELETE to confirm').fill('DELETE')
    await expect(box.getByRole('button', { name: 'Delete Liberty1' })).toBeEnabled()
    await page.waitForLoadState('networkidle')
    await expectNoSeriousA11yViolations(page, [], '/partners', '[aria-labelledby="partner-delete-title"]')
    expect(unmatched).toEqual([])
  })

  for (const { name, path, exclude } of PAGES) {
    test(`${name} has no serious a11y violations`, async ({ page }) => {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      // The path is passed so a redirect to /login fails here rather than being
      // scanned as if it were this page (#797).
      await expectNoSeriousA11yViolations(page, exclude, path)
    })
  }
})

/** The Worker the built page calls, as api.ts reads it. */
function workerUrl(): string {
  return process.env.NEXT_PUBLIC_WORKER_URL ?? 'http://localhost:8787'
}

/** The partners page with Tripoint and its buyer profile on screen. */
async function openTripoint(page: Page) {
  await page.goto('/partners?selected=tripoint')
  await expect(page.getByRole('region', { name: 'Buyer profile' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Tripoint' })).toBeVisible()
  await page.waitForLoadState('networkidle')
}

/** A dialog scan that found no dialog is not a pass (L98). */
async function expectDialogs(page: Page) {
  expect(await page.locator('[role="dialog"], [role="alertdialog"]').count()).toBeGreaterThan(0)
}
