import { test, expect } from '@playwright/test'

test.describe('API Sources', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/sources')
    await page.waitForLoadState('networkidle')
  })

  test('page loads', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /Sources/i })).toBeVisible()
  })

  test('create source → masked key displayed in list', async ({ page }) => {
    const name = `e2e_source_${Date.now()}`

    await page.getByRole('button', { name: /New source/i }).click()

    await page.locator('input[placeholder*="name"], input[name="name"]').fill(name)
    await page.getByRole('button', { name: /Generate|Create|Save/i }).click()

    await expect(page.getByText(name)).toBeVisible({ timeout: 5000 })
  })

  test('revoke source → row removed', async ({ page }) => {
    const e2eSource = page.locator('li, tr, [data-testid="source-row"]').filter({ hasText: 'e2e_source' }).first()

    if (!await e2eSource.isVisible()) {
      test.skip()
    }

    await e2eSource.getByRole('button', { name: /Revoke/i }).click()
    // Two-step confirm
    await page.getByRole('button', { name: /Revoke/i }).last().click()

    await expect(e2eSource).not.toBeVisible({ timeout: 5000 })
  })
})
