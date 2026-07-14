import { test, expect } from '@playwright/test'

const UNIQUE = () => `E2E-${Date.now()}`

test.describe('Workflows list', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/workflows')
    await page.waitForLoadState('networkidle')
  })

  test('list page loads', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible()
    // Header button (always present) — use first() to avoid strict mode with empty-state button
    await expect(page.getByRole('button', { name: /new workflow/i }).first()).toBeVisible()
  })

  test('create workflow → redirects to canvas', async ({ page }) => {
    await page.getByRole('button', { name: /new workflow/i }).first().click()
    await expect(page).toHaveURL(/\/workflows\/.+\?mode=edit/, { timeout: 10000 })
  })

  test('rename workflow', async ({ page }) => {
    const name = UNIQUE()

    // Click ⋯ on first workflow (created by prior test in this run)
    await page.getByRole('button', { name: 'More options' }).first().click()
    await page.getByRole('button', { name: 'Rename' }).click()

    // Input is autoFocused — select all and type new name without clicking
    await page.keyboard.press('Control+a')
    await page.keyboard.type(name)
    await page.keyboard.press('Enter')

    await expect(page.getByText(name)).toBeVisible({ timeout: 5000 })
  })

  test('duplicate workflow → copy appears in list', async ({ page }) => {
    await page.getByRole('button', { name: 'More options' }).first().click()
    await page.getByRole('button', { name: 'Duplicate' }).click()
    await expect(page.getByText('(copy)')).toBeVisible({ timeout: 5000 })
  })

  test('disable/enable workflow toggles badge', async ({ page }) => {
    await page.getByRole('button', { name: 'More options' }).first().click()

    const disableBtn = page.getByRole('button', { name: 'Disable' })
    const enableBtn = page.getByRole('button', { name: 'Enable' })

    if (await disableBtn.isVisible()) {
      await disableBtn.click()
      await expect(page.getByText('Inactive').first()).toBeVisible({ timeout: 5000 })
    } else {
      await enableBtn.click()
      await expect(page.getByText('Active').first()).toBeVisible({ timeout: 5000 })
    }
  })

  test('delete workflow → row removed', async ({ page }) => {
    // Target the first "(copy)" row if present, otherwise first row
    const copyText = page.getByText('(copy)').first()
    const hasCopy = await copyText.isVisible().catch(() => false)

    if (hasCopy) {
      const row = page.locator('tr').filter({ hasText: '(copy)' }).first()
      await row.getByRole('button', { name: 'More options' }).click()
    } else {
      await page.getByRole('button', { name: 'More options' }).first().click()
    }

    await page.getByRole('button', { name: 'Delete' }).click()
    // Two-step confirm — click the red Delete button
    await page.getByRole('button', { name: 'Delete' }).click()

    await expect(copyText).not.toBeVisible({ timeout: 5000 })
  })

  test('unsaved edit warns before leaving via the back link (#478)', async ({ page }) => {
    const name = UNIQUE()

    await page.getByRole('button', { name: /new workflow/i }).first().click()
    await expect(page).toHaveURL(/\/workflows\/.+\?mode=edit/, { timeout: 10000 })

    const nameInput = page.locator('input[style*="workflow-name"]')
    await nameInput.fill(name)

    // Save so the row is named for afterAll cleanup and to establish a clean baseline.
    // A clean save switches to view mode (URL flips to ?mode=view) — wait on that
    // instead of the "Saved" flash, which can come and go within a single frame.
    await page.getByRole('button', { name: 'Save' }).first().click()
    await page.getByRole('button', { name: 'Save' }).last().click()
    await expect(page).toHaveURL(/mode=view/, { timeout: 10000 })

    await page.getByRole('button', { name: 'Edit' }).click()
    await nameInput.fill(`${name}-edited`)
    await expect(page.getByRole('button', { name: /^Save$/ })).toBeEnabled()

    // Dismiss: the click is blocked and the canvas keeps the unsaved edit.
    page.once('dialog', (d) => d.dismiss())
    await page.getByRole('link', { name: '← Workflows' }).click()
    await expect(page).toHaveURL(/\/workflows\/.+/)
    await expect(nameInput).toHaveValue(`${name}-edited`)

    // Confirm: navigation proceeds and the unsaved rename is discarded.
    page.once('dialog', (d) => d.accept())
    await page.getByRole('link', { name: '← Workflows' }).click()
    await expect(page).toHaveURL(/\/workflows$/, { timeout: 10000 })
  })
})
