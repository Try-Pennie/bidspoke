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
  // dialog, the surface the test is about; the form behind it is a separate
  // finding (its muted text on the beige background, #2137's report).
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
    await page.getByRole('tab', { name: 'Bid Group' }).click()
    await page.getByRole('radio', { name: 'Matrix lookup' }).click()
    await page.getByRole('button', { name: 'Delete this matrix' }).click()
    await expect(page.getByRole('alertdialog', { name: /^Delete matrix/ })).toBeVisible()
    await expectDialogs(page)
    await expectNoSeriousA11yViolations(page, [], '/partners', '[role="alertdialog"]')
    expect(unmatched).toEqual([])
  })

  // #2137: the shared controls, scanned open. A closed Select or calendar is a
  // button; what a screen reader meets is the open list or grid, so each is
  // opened by the keyboard, scanned, and driven. An open Select is modal: Radix
  // hides the page behind it from assistive tech while the list holds the focus,
  // so axe would report every button behind it as hidden yet focusable; the
  // scan is of the list, and the page keeps its own closed scan. Nothing here
  // presses Save.
  test('environment page: the Used by dropdown, open, has no serious a11y violations and the keyboard drives it', async ({ page }) => {
    await page.goto('/env')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Add variable' }).click()
    const usedBy = page.getByRole('combobox', { name: 'Used by' })
    const before = (await usedBy.textContent())?.trim() ?? ''
    await usedBy.focus()
    await page.keyboard.press('Enter')
    const list = page.getByRole('listbox')
    await expect(list).toBeVisible()
    await expect(list.getByRole('option', { name: 'All workflows' })).toBeVisible()
    await expectNoSeriousA11yViolations(page, [], '/env', '[role="listbox"]')
    // Escape closes it without a change and gives the focus back to the dropdown.
    await page.keyboard.press('Escape')
    await expect(list).toBeHidden()
    await expect(usedBy).toHaveText(before)
    await expect(usedBy).toBeFocused()
  })

  test('partners page: an accept rule operator dropdown, open, has no serious a11y violations and the keyboard drives it', async ({ page }) => {
    const { unmatched } = await routePartnerFixtures(page, workerUrl())
    await openTripoint(page)
    // Tripoint's first accept rule is `ok` equals true.
    const operator = page.getByRole('combobox', { name: 'Operator' }).first()
    await expect(operator).toHaveText('equals')
    await operator.focus()
    await page.keyboard.press('Enter')
    const list = page.getByRole('listbox')
    await expect(list).toBeVisible()
    await expectNoSeriousA11yViolations(page, [], '/partners', '[role="listbox"]')
    // The list opens on the chosen operator; ArrowDown and Enter choose the next one.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(list).toBeHidden()
    await expect(operator).toHaveText('contains')
    await expect(operator).toBeFocused()
    expect(unmatched).toEqual([])
  })

  test('partners page: the blackout date calendar, open, has no serious a11y violations, and the date box takes typing', async ({ page }) => {
    const { unmatched } = await routePartnerFixtures(page, workerUrl())
    await openTripoint(page)
    await page.getByRole('button', { name: 'Add date' }).click()
    const calendarButton = page.getByRole('button', { name: 'Choose Date, new date from a calendar' })
    await calendarButton.click()
    const grid = page.getByRole('grid')
    await expect(grid).toBeVisible()
    await expectNoSeriousA11yViolations(page, [], '/partners', '[role="dialog"]')
    // The focused day moves with the arrows, and Escape returns the focus to the button.
    const first = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
    await page.keyboard.press('ArrowRight')
    const second = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
    expect(second, 'the arrow key did not move the focused day').not.toBe(first)
    await page.keyboard.press('Escape')
    await expect(grid).toBeHidden()
    await expect(calendarButton).toBeFocused()
    // A typed date commits on Enter and reads back in the box's one spelling.
    const box = page.getByRole('textbox', { name: 'Date, new date' })
    await box.fill('1/1/2027')
    await box.press('Enter')
    await expect(page.getByRole('textbox', { name: 'Date, Jan 1, 2027' })).toHaveValue('Jan 1, 2027')
    expect(unmatched).toEqual([])
  })

  // #2137: every tab of every fixture partner, each scanned with exactly one
  // panel visible, so a tab nobody opened by hand is still scanned (L400).
  test('partners page: every tab of every partner has no serious a11y violations, one panel at a time', async ({ page }) => {
    test.setTimeout(240_000)
    const { unmatched } = await routePartnerFixtures(page, workerUrl())
    await page.goto('/partners')
    const rows = page.getByRole('region', { name: /^(Buyers|Sources)$/ }).getByRole('button')
    await expect(rows.first()).toBeVisible()
    const names = [...new Set((await rows.allTextContents()).map((t) => t.trim()))]
    expect(names, 'the fixture list is the real nine').toHaveLength(9)
    let scanned = 0
    for (const name of names) {
      await page.getByRole('button', { name, exact: true }).first().click()
      const tablist = page.getByRole('tablist', { name: `${name} settings` })
      await expect(tablist).toBeVisible()
      await page.waitForLoadState('networkidle')
      const tabs = await tablist.getByRole('tab').allTextContents()
      expect(tabs[0]).toBe('Partner')
      for (const tab of tabs) {
        await tablist.getByRole('tab', { name: tab, exact: true }).click()
        await expect(tablist.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true')
        await expect(page.locator('[role="tabpanel"]:visible'), `${name}, ${tab}: exactly one panel is visible`).toHaveCount(1)
        // A rule row fades in when its panel is shown (@starting-style); scan once it has.
        await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
        await expectNoSeriousA11yViolations(page, [], '/partners', undefined, GREY_HINTS)
        scanned++
      }
    }
    expect(scanned).toBeGreaterThan(30)
    expect(unmatched).toEqual([])
  })

  test('partners page: a partner with a missing credential opens on the tab holding it, marked there and in the list', async ({ page }) => {
    const { unmatched } = await routePartnerFixtures(page, workerUrl(), { credentialWarningFor: 'amone' })
    await page.goto('/partners?selected=amone')
    // The mark is read after the label (a browser may put a space before its comma).
    const tab = page.getByRole('tab', { name: /^Bid Group ?, has a problem$/ })
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByLabel('Auth secret name')).toHaveAccessibleDescription(/AMONE_PROXY_SECRET is not set|Credential 'AMONE_PROXY_SECRET' is not set/)
    await expect(page.getByRole('button', { name: /^AmOne.*not set/ })).toBeVisible()
    // The URL is untouched: the problem tab is where it opens, not what it asks for.
    expect(new URL(page.url()).searchParams.get('tab')).toBeNull()
    await page.waitForLoadState('networkidle')
    await expectNoSeriousA11yViolations(page, [], '/partners', undefined, GREY_HINTS)
    expect(unmatched).toEqual([])
  })

  test('partners page: a failed usage read shows the Bid Group tab with its error, and the tab in the URL survives a reload', async ({ page }) => {
    const { unmatched } = await routePartnerFixtures(page, workerUrl(), { usageFails: true })
    await page.goto('/partners?selected=liberty1')
    await page.getByRole('tab', { name: 'Bid Group' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Could not check which workflows use this partner. Try again.' })).toBeVisible()
    await expect(page).toHaveURL(/[?&]tab=bid-group/)
    await page.reload()
    await expect(page.getByRole('tab', { name: 'Bid Group' })).toHaveAttribute('aria-selected', 'true')
    await page.waitForLoadState('networkidle')
    await expectNoSeriousA11yViolations(page, [], '/partners', undefined, GREY_HINTS)
    expect(unmatched).toEqual([])
  })

  // #2139: the held clicks cards, open. Liberty1 is given three invented held
  // clicks (production holds none): one still held, a sale with no lead id and a
  // sale whose Submission update Salesforce refused. The Mark sent box and the
  // Remove dialog are each scanned open; adding the lead id is answered by its
  // fixture, so nothing reaches production.
  test('partners page: held clicks, the lead id box and the Remove dialog have no serious a11y violations', async ({ page }) => {
    const { unmatched } = await routePartnerFixtures(page, workerUrl(), { heldClicks: true })
    await page.goto('/partners?selected=liberty1&tab=buyer-profile')
    const cards = page.getByRole('list', { name: 'Held clicks for Liberty1' }).locator(':scope > li')
    await expect(cards).toHaveCount(3)
    await expect(page.getByText('1 click held. No later click on this prospect is sent until it is released.')).toBeVisible()
    await page.waitForLoadState('networkidle')

    // The Mark sent box, open, with its consequence for no lead id.
    await cards.nth(0).getByRole('button', { name: 'Mark sent' }).click()
    const box = page.getByLabel("Liberty1's lead id, if you have it")
    await expect(box).toBeVisible()
    await expect(box).toHaveAccessibleDescription(/Salesforce marks the sale Completed with no lead id/)
    await expectNoSeriousA11yViolations(page, [], '/partners', undefined, GREY_HINTS)
    await cards.nth(0).getByRole('button', { name: 'Cancel' }).click()

    // The Remove dialog of the sale Salesforce refused, naming the retry it takes.
    await expect(cards.nth(2).getByRole('alert')).toContainText('UNABLE_TO_LOCK_ROW')
    await cards.nth(2).getByRole('button', { name: 'Remove from the list' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Remove a0B5f00000QzW4pEAF from the list?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAccessibleDescription(/Its Salesforce retry goes with it/)
    await expectDialogs(page)
    await expectNoSeriousA11yViolations(page, [], '/partners', '[role="alertdialog"]')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    // Adding the lead id to the sale with none, answered by its fixture.
    await cards.nth(1).getByRole('button', { name: "Add Liberty1's lead id" }).click()
    await page.getByLabel("Liberty1's lead id", { exact: true }).fill('L1F-779')
    await cards.nth(1).getByRole('button', { name: 'Add the lead id' }).click()
    await expect(cards.nth(1).getByRole('status')).toHaveText('Lead id L1F-779 added. Salesforce updated: Prospect, Submission, Lead.')
    await expectNoSeriousA11yViolations(page, [], '/partners', undefined, GREY_HINTS)
    expect(unmatched).toEqual([])
  })

  // #2137: jsdom has no layout, so clipping is measured here, in the real tabs,
  // the real scrolling form pane and the real Dialog shell.
  test('partners page: nothing is clipped, a dropdown at the foot of the scrolled form or the merge dialog, and the list stays in view', async ({ page }) => {
    const { unmatched } = await routePartnerFixtures(page, workerUrl(), { staleSave: true })
    await openTripoint(page)
    const viewport = page.viewportSize()!
    // Put the first operator dropdown 8px above the bottom of the form's pane, then open it.
    const operator = page.getByRole('combobox', { name: 'Operator' }).first()
    await operator.evaluate((el) => {
      const pane = el.closest('[data-form-pane]') as HTMLElement
      pane.scrollTop += el.getBoundingClientRect().bottom - pane.getBoundingClientRect().bottom + 8
    })
    const paneBottom = await page.locator('[data-form-pane]').evaluate((p) => p.getBoundingClientRect().bottom)
    const trigger = (await operator.boundingBox())!
    expect(trigger.y + trigger.height, 'the dropdown sits at the foot of the pane').toBeGreaterThan(paneBottom - 60)
    await operator.focus()
    await page.keyboard.press('Enter')
    const list = page.getByRole('listbox')
    await expect(list).toBeVisible()
    const box = (await list.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
    // Every option is the topmost thing at its own centre: nothing covers or cuts it.
    for (const option of await list.getByRole('option').all()) {
      const ob = (await option.boundingBox())!
      const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[role="option"]')?.textContent ?? null, [ob.x + ob.width / 2, ob.y + ob.height / 2])
      expect(hit, 'an option is covered or cut off').toBe(await option.textContent())
    }
    await page.keyboard.press('Escape')

    // The list stays in view however far the form is scrolled (#2137): only the pane scrolls.
    await page.locator('[data-form-pane]').evaluate((p) => { p.scrollTop = p.scrollHeight })
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
    const row = (await page.getByRole('button', { name: 'Tripoint', exact: true }).boundingBox())!
    expect(row.y).toBeGreaterThanOrEqual(0)
    expect(row.y + row.height).toBeLessThanOrEqual(viewport.height)

    // The merge dialog: inside the window, and each of its buttons reachable at its own point.
    await page.locator('[data-form-pane]').evaluate((p) => { p.scrollTop = 0 })
    await page.getByLabel('Leads per day', { exact: true }).fill('300')
    await page.getByRole('button', { name: /Save changes/ }).click()
    const dialog = page.getByRole('dialog', { name: /saved this partner while you were editing/ })
    await expect(dialog).toBeVisible()
    const db = (await dialog.boundingBox())!
    expect(db.y).toBeGreaterThanOrEqual(0)
    expect(db.y + db.height).toBeLessThanOrEqual(viewport.height)
    for (const button of await dialog.getByRole('button').all()) {
      await button.scrollIntoViewIfNeeded()
      const bb = (await button.boundingBox())!
      const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.textContent ?? null, [bb.x + bb.width / 2, bb.y + bb.height / 2])
      expect(hit, 'a dialog button is covered or cut off').toBe(await button.textContent())
    }
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

/**
 * The partners form's grey hint text (text-gray-500) on the beige page fails
 * contrast; PR13 (#2144) sets its new shade once Dan picks it (decision 3,
 * 2026-10-15), and deletes this waiver. Every other contrast failure still fails.
 */
const GREY_HINTS = { className: 'text-gray-500', within: '[data-form-pane]', issue: '#2144' }

/** The Worker the built page calls, as api.ts reads it. */
function workerUrl(): string {
  return process.env.NEXT_PUBLIC_WORKER_URL ?? 'http://localhost:8787'
}

/** The partners page with Tripoint and its buyer profile on screen. */
async function openTripoint(page: Page) {
  await page.goto('/partners?selected=tripoint')
  await expect(page.getByRole('region', { name: 'Buyer profile' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Tripoint' })).toBeVisible()
  // The live channel (#2135) joins through the routed socket, so each scan sees the header as it settles.
  await expect(page.getByRole('status').filter({ hasText: /^Live$/ })).toBeVisible()
  await page.waitForLoadState('networkidle')
}

/** A dialog scan that found no dialog is not a pass (L98). */
async function expectDialogs(page: Page) {
  expect(await page.locator('[role="dialog"], [role="alertdialog"]').count()).toBeGreaterThan(0)
}
