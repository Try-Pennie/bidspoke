/**
 * Playwright global setup — signs in the E2E test user and saves the session
 * to storage state so all tests start pre-authenticated.
 *
 * Uses Supabase email+password auth directly (not Google SSO) so no browser
 * interaction is needed. The session is injected into localStorage in the
 * correct format for @supabase/ssr's createBrowserClient.
 */
import { chromium } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'

dotenv.config({ path: path.resolve(__dirname, '../.env.test') })

const SUPABASE_URL = 'https://xvrmivmpfykwwtriqwpg.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_XT7MGOY5A0SftphNV29YZw_iexJjW9O'
const STORAGE_FILE = path.resolve(__dirname, '.auth/storage.json')
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000'

// @supabase/ssr derives the localStorage key from the project ref (first subdomain)
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0]
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`

export default async function globalSetup() {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!email || !password) throw new Error('E2E_EMAIL and E2E_PASSWORD must be set in .env.test')

  // Sign in via Supabase JS client (Node environment)
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  })
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`E2E auth failed: ${error?.message ?? 'no session'}`)

  // Inject session into a browser context and save storage state
  fs.mkdirSync(path.dirname(STORAGE_FILE), { recursive: true })

  const browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()

  await page.goto(BASE_URL)
  await page.evaluate(
    ({ key, session }: { key: string; session: unknown }) => {
      localStorage.setItem(key, JSON.stringify(session))
    },
    { key: STORAGE_KEY, session: data.session }
  )

  await context.storageState({ path: STORAGE_FILE })
  await browser.close()

  console.log(`  ✓ E2E session saved for ${email}`)
}
