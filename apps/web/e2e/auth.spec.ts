import { test, expect } from '@playwright/test'

test.describe('Auth — unauthenticated redirect', () => {
  // These tests run without the global storage state (no auth cookie/localStorage)
  test.use({ storageState: { cookies: [], origins: [] } })

  test('unauthenticated user redirected to /login from /', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/login/)
  })

  test('unauthenticated user redirected to /login from /workflows', async ({ page }) => {
    await page.goto('/workflows')
    await expect(page).toHaveURL(/\/login/)
  })

  test('unauthenticated user redirected to /login from /env', async ({ page }) => {
    await page.goto('/env')
    await expect(page).toHaveURL(/\/login/)
  })
})

test.describe('Auth — authenticated access', () => {
  test('authenticated user lands on /workflows', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/workflows/)
  })
})
