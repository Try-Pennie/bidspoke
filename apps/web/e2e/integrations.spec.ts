import { test, expect } from '@playwright/test'

test.describe('Integrations — HTTP service presets', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/integrations')
    await page.waitForLoadState('networkidle')
  })

  test('page loads and shows Slack section', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible()
    await expect(page.getByText('Slack', { exact: true })).toBeVisible()
  })

  test('add HTTP service preset → appears in table', async ({ page }) => {
    const name = `E2E Service ${Date.now()}`

    await page.getByRole('button', { name: 'Add service' }).click()
    await page.locator('input[placeholder="My CRM"]').fill(name)
    await page.getByRole('button', { name: 'Save service' }).click()

    await expect(page.getByText(name)).toBeVisible({ timeout: 8000 })

    // cleanup
    const e2eRow = page.locator('tr').filter({ hasText: name }).first()
    await e2eRow.getByRole('button', { name: /delete|remove/i }).click()
    await page.getByRole('button', { name: /delete|remove/i }).last().click()
    await expect(page.getByText(name)).not.toBeVisible({ timeout: 5000 })
  })

  test('delete HTTP service preset → row removed', async ({ page }) => {
    const name = `E2E Service Del ${Date.now()}`

    await page.getByRole('button', { name: 'Add service' }).click()
    await page.locator('input[placeholder="My CRM"]').fill(name)
    await page.getByRole('button', { name: 'Save service' }).click()
    await expect(page.getByText(name)).toBeVisible({ timeout: 8000 })

    const e2eRow = page.locator('tr').filter({ hasText: name }).first()
    await e2eRow.getByRole('button', { name: /delete|remove/i }).click()
    await page.getByRole('button', { name: /delete|remove/i }).last().click()

    await expect(page.getByText(name)).not.toBeVisible({ timeout: 5000 })
  })
})
