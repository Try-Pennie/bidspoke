import { test, expect } from '@playwright/test'

test.describe('Environment Variables', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/env')
    await page.waitForLoadState('networkidle')
  })

  test('page loads and shows list', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /Environment/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Add/i })).toBeVisible()
  })

  test('add a plain env var → appears in list', async ({ page }) => {
    const key = `E2E_TEST_${Date.now()}`
    const value = 'e2e-value'

    await page.getByRole('button', { name: /Add/i }).click()

    // Fill key and value
    await page.locator('input[placeholder*="KEY"], input[name="key"], input[placeholder*="key"]').fill(key)
    await page.locator('input[placeholder*="value"], input[name="value"]').fill(value)

    await page.getByRole('button', { name: /^Save|^Add|^Create/i }).click()

    await expect(page.getByText(key)).toBeVisible({ timeout: 5000 })
    // Plain var — value should be visible
    await expect(page.getByText(value)).toBeVisible()
  })

  test('secret var — value is masked in the list', async ({ page }) => {
    const key = `E2E_SECRET_${Date.now()}`
    const value = 'super-secret-value'

    await page.getByRole('button', { name: /Add/i }).click()

    await page.locator('input[placeholder*="KEY"], input[name="key"], input[placeholder*="key"]').fill(key)
    await page.locator('input[placeholder*="value"], input[name="value"]').fill(value)

    // Toggle the "Secret" checkbox
    await page.locator('input[type="checkbox"], label:has-text("Secret")').click()

    await page.getByRole('button', { name: /^Save|^Add|^Create/i }).click()

    await expect(page.getByText(key)).toBeVisible({ timeout: 5000 })
    // Value should NOT be visible in plain text
    await expect(page.getByText(value)).not.toBeVisible()
  })

  test('delete env var → row removed', async ({ page }) => {
    // Find and delete the first E2E test var we created
    const e2eRow = page.locator('tr, [data-testid="env-row"]').filter({ hasText: 'E2E_TEST' }).first()

    if (!await e2eRow.isVisible()) {
      test.skip()
    }

    await e2eRow.locator('button:has(.lucide-trash)').click()
    await page.getByRole('button', { name: /^Delete|^Remove/i }).last().click()

    await expect(e2eRow).not.toBeVisible({ timeout: 5000 })
  })
})
