import { defineConfig, devices } from '@playwright/test'
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(__dirname, '.env.test') })

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: BASE_URL,
    storageState: 'e2e/.auth/storage.json',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'setup',
      testMatch: /global-setup\.ts/,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
      // Specs only. Playwright's default testMatch also grabs *.test.ts, which
      // would pull in the vitest unit tests that live alongside them in e2e/.
      testMatch: /.*\.spec\.ts$/,
    },
  ],

  globalSetup: './e2e/global-setup.ts',
  // Deletes the workflows the suite created, once, after everything. Replaces a
  // per-file afterAll that clicked Delete in the UI and swallowed its failures.
  globalTeardown: './e2e/global-teardown.ts',
})
