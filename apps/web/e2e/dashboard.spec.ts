import { test, expect } from '@playwright/test'

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
  })

  test('page loads and shows KPI cards', async ({ page }) => {
    await expect(page.getByText('Executions')).toBeVisible()
    await expect(page.getByText('Success rate')).toBeVisible()
    await expect(page.getByText('Avg duration')).toBeVisible()
    await expect(page.getByText('Failed')).toBeVisible()
  })

  test('page has no JS errors on load', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    expect(errors).toHaveLength(0)
  })

  test('time window toggle is visible', async ({ page }) => {
    await expect(page.getByRole('button', { name: '7d' })).toBeVisible()
    await expect(page.getByRole('button', { name: '14d' })).toBeVisible()
    await expect(page.getByRole('button', { name: '30d' })).toBeVisible()
  })
})
