import { defineConfig } from '@playwright/test'

/**
 * A config of its own for the unauthenticated auth-gate probe (#728).
 *
 * The main config carries a globalSetup that signs in and THROWS without
 * E2E_PASSWORD, plus a storageState holding that session. The probe must run
 * with neither: its whole purpose is to ask what an anonymous caller gets, and
 * it must not be able to start depending on a credential later. Keeping it in a
 * separate config makes that structural rather than a convention.
 *
 * No globalSetup, no globalTeardown, no storageState. It creates nothing, so
 * there is nothing to clean up.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /auth-gate\.probe\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    // Explicitly empty: an anonymous caller is the subject of the test.
    storageState: { cookies: [], origins: [] },
  },
})
