import { test } from '@playwright/test'
import { expectNoSeriousA11yViolations } from './axe'

/**
 * Automated accessibility checks (#288). Runs axe-core against the key
 * authenticated pages plus the public login page and fails on serious/critical
 * WCAG A/AA violations. Complements the static jsx-a11y lint rules with runtime
 * checks (color contrast, ARIA in rendered state, etc.).
 *
 * Note: the React Flow canvas renderer is excluded where present — it is
 * third-party and not something we control. Re-scope once a baseline exists.
 */

test.describe('Accessibility (axe-core)', () => {
  test('login page has no serious a11y violations', async ({ page }) => {
    // Public page — clear the stored auth so we land on /login.
    await page.context().clearCookies()
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    await expectNoSeriousA11yViolations(page)
  })

  test('dashboard has no serious a11y violations', async ({ page }) => {
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    await expectNoSeriousA11yViolations(page)
  })

  test('sources page has no serious a11y violations', async ({ page }) => {
    await page.goto('/sources')
    await page.waitForLoadState('networkidle')
    await expectNoSeriousA11yViolations(page)
  })

  test('environment page has no serious a11y violations', async ({ page }) => {
    await page.goto('/env')
    await page.waitForLoadState('networkidle')
    await expectNoSeriousA11yViolations(page)
  })

  test('workflows list has no serious a11y violations', async ({ page }) => {
    await page.goto('/workflows')
    await page.waitForLoadState('networkidle')
    // Exclude the React Flow canvas if a preview renders one.
    await expectNoSeriousA11yViolations(page, ['.react-flow'])
  })
})
