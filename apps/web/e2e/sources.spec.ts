import { test, expect } from '@playwright/test'

test.describe('API Sources', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/sources')
    await page.waitForLoadState('networkidle')
  })

  test('page loads', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'API Sources' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New source' })).toBeVisible()
  })

  test('create source → appears in list', async ({ page }) => {
    const name = `e2e_source_${Date.now()}`

    await page.getByRole('button', { name: 'New source' }).click()
    await page.locator('input[placeholder="wallet_owl"]').fill(name)
    await page.getByRole('button', { name: 'Generate key' }).click()

    await expect(page.getByText(name)).toBeVisible({ timeout: 8000 })
  })

  test('revoke source → row removed', async ({ page }) => {
    const e2eRow = page.locator('li, [data-testid="source-row"], .source-row').filter({ hasText: 'e2e_source' }).first()
    const sourceText = page.getByText(/e2e_source/).first()

    if (!await sourceText.isVisible().catch(() => false)) {
      test.skip()
    }

    await sourceText.locator('..').locator('..').getByRole('button', { name: 'Revoke' }).click()
    await page.getByRole('button', { name: 'Revoke' }).click()

    await expect(sourceText).not.toBeVisible({ timeout: 5000 })
  })
})
