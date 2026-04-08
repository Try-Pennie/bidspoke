import { test, expect } from '@playwright/test'

test.describe('Integrations — HTTP service presets', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/integrations')
    await page.waitForLoadState('networkidle')
  })

  test('page loads and shows Slack section', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /Integrations/i })).toBeVisible()
    await expect(page.getByText(/Slack/i)).toBeVisible()
  })

  test('add HTTP service preset → appears in table', async ({ page }) => {
    const name = `E2E Service ${Date.now()}`

    await page.getByRole('button', { name: /Add service/i }).click()

    await page.locator('input[placeholder*="name"], input[name="name"]').fill(name)
    await page.getByRole('button', { name: /^Save|^Add|^Create/i }).click()

    await expect(page.getByText(name)).toBeVisible({ timeout: 5000 })
  })

  test('delete HTTP service preset → row removed', async ({ page }) => {
    const e2eRow = page.locator('tr, [data-testid="service-row"]').filter({ hasText: 'E2E Service' }).first()

    if (!await e2eRow.isVisible()) {
      test.skip()
    }

    await e2eRow.locator('button:has(.lucide-trash)').click()
    await page.getByRole('button', { name: /^Delete|^Remove/i }).last().click()

    await expect(e2eRow).not.toBeVisible({ timeout: 5000 })
  })
})
