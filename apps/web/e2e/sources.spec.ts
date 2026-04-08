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

    await expect(page.getByText(name).first()).toBeVisible({ timeout: 8000 })
  })

  test('revoke source → row removed', async ({ page }) => {
    // Create a dedicated source so we hold a unique name reference
    const name = `e2e_del_${Date.now()}`

    await page.getByRole('button', { name: 'New source' }).click()
    await page.locator('input[placeholder="wallet_owl"]').fill(name)
    await page.getByRole('button', { name: 'Generate key' }).click()
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 8000 })

    const sourceText = page.getByText(name).first()
    const sourceCard = sourceText.locator('..').locator('..')
    await sourceCard.getByRole('button', { name: 'Revoke' }).click()
    await sourceCard.getByRole('button', { name: 'Revoke' }).click()

    await expect(page.getByRole('paragraph').filter({ hasText: name })).not.toBeVisible({ timeout: 5000 })
  })
})
