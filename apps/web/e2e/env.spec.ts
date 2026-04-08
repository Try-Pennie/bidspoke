import { test, expect } from '@playwright/test'

test.describe('Environment Variables', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/env')
    await page.waitForLoadState('networkidle')
  })

  test('page loads and shows list', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Environment Variables' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add Variable' })).toBeVisible()
  })

  test('add a plain env var → appears in list', async ({ page }) => {
    const key = `E2E_TEST_${Date.now()}`
    const value = 'e2e-value'

    await page.getByRole('button', { name: 'Add Variable' }).click()
    await page.locator('input[placeholder="MY_API_KEY"]').fill(key)
    await page.locator('input[placeholder="value"]').fill(value)
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(page.getByText(key)).toBeVisible({ timeout: 8000 })
    await expect(page.getByText(value)).toBeVisible()
  })

  test('secret var — value is masked in the list', async ({ page }) => {
    const key = `E2E_SECRET_${Date.now()}`
    const value = 'super-secret-value'

    await page.getByRole('button', { name: 'Add Variable' }).click()
    await page.locator('input[placeholder="MY_API_KEY"]').fill(key)
    await page.locator('#is_secret').check()
    await page.locator('input[placeholder="value"]').fill(value)
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(page.getByText(key)).toBeVisible({ timeout: 8000 })
    await expect(page.getByText(value)).not.toBeVisible()
  })

  test('delete env var → row removed', async ({ page }) => {
    const e2eRow = page.locator('tr').filter({ hasText: 'E2E_TEST' }).first()

    if (!await e2eRow.isVisible()) {
      test.skip()
    }

    await e2eRow.getByRole('button', { name: 'Delete variable' }).click()
    await page.getByRole('button', { name: 'Delete' }).click()

    await expect(e2eRow).not.toBeVisible({ timeout: 5000 })
  })
})
