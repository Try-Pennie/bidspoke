import { test, expect } from '@playwright/test'

const UNIQUE = () => `E2E-${Date.now()}`

test.describe('Workflows list', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/workflows')
    await page.waitForLoadState('networkidle')
  })

  test('list page loads', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible()
    await expect(page.getByRole('button', { name: /New workflow/i })).toBeVisible()
  })

  test('create workflow → redirects to canvas', async ({ page }) => {
    await page.getByRole('button', { name: /New workflow/i }).click()
    await expect(page).toHaveURL(/\/workflows\/.+\?mode=edit/, { timeout: 10000 })
  })

  test('rename workflow', async ({ page }) => {
    const name = UNIQUE()

    // Create a workflow to rename
    await page.goto('/workflows')
    await page.waitForLoadState('networkidle')

    // Open ⋯ menu on the first workflow (if any exist, otherwise create one first)
    const firstMenu = page.locator('[aria-label="More options"], button:has(svg)').first()
    const menuCount = await page.locator('table tbody tr, [data-testid="workflow-row"]').count()

    if (menuCount === 0) {
      // Create one and come back
      await page.getByRole('button', { name: /New workflow/i }).click()
      await expect(page).toHaveURL(/\/workflows\/.+\?mode=edit/, { timeout: 10000 })
      await page.goto('/workflows')
      await page.waitForLoadState('networkidle')
    }

    // Find and click the ⋯ menu on the first row
    await page.locator('button[title="More options"], button:has(.lucide-more-horizontal)').first().click()
    await page.getByRole('button', { name: /Rename/i }).click()

    // The inline input should appear — clear and type new name
    const input = page.locator('input[type="text"]').first()
    await input.fill(name)
    await input.press('Enter')

    await expect(page.getByText(name)).toBeVisible({ timeout: 5000 })
  })

  test('duplicate workflow → copy appears in list', async ({ page }) => {
    await page.locator('button:has(.lucide-more-horizontal)').first().click()
    await page.getByRole('button', { name: /Duplicate/i }).click()
    await expect(page.getByText('(copy)')).toBeVisible({ timeout: 5000 })
  })

  test('disable/enable workflow toggles badge', async ({ page }) => {
    // Click ⋯ on first active workflow
    await page.locator('button:has(.lucide-more-horizontal)').first().click()

    // Toggle: if "Disable" is visible click it, else click "Enable"
    const disableBtn = page.getByRole('button', { name: /Disable/i })
    const enableBtn = page.getByRole('button', { name: /Enable/i })

    if (await disableBtn.isVisible()) {
      await disableBtn.click()
      await expect(page.getByText('Inactive').first()).toBeVisible({ timeout: 5000 })
    } else {
      await enableBtn.click()
      await expect(page.getByText('Active').first()).toBeVisible({ timeout: 5000 })
    }
  })

  test('delete workflow → row removed', async ({ page }) => {
    // Create a fresh workflow to delete
    const name = `E2E-DELETE-${Date.now()}`

    // Navigate to canvas, set name, come back (or just use the ⋯ delete on existing row)
    // For simplicity, delete the first "(copy)" workflow if one exists, else first row
    const copyRow = page.getByText('(copy)').first()
    if (await copyRow.isVisible()) {
      // Find the ⋯ button in the same row
      await copyRow.locator('..').locator('..').locator('button:has(.lucide-more-horizontal)').click()
    } else {
      await page.locator('button:has(.lucide-more-horizontal)').first().click()
    }

    await page.getByRole('button', { name: /Delete/i }).click()
    // Two-step confirm — click the red confirm button
    await page.getByRole('button', { name: /Delete/i }).last().click()

    // Row count should decrease (or copy text should disappear)
    await expect(copyRow).not.toBeVisible({ timeout: 5000 })
  })
})
