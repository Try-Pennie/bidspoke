/**
 * Playwright global setup — signs in the E2E test user and saves the session
 * to storage state so all tests start pre-authenticated.
 *
 * Next.js middleware uses @supabase/ssr which reads auth from COOKIES (not
 * localStorage). We compute the same cookie format that createBrowserClient
 * uses (JSON-stringified session, chunked at 3180 chars) and inject them
 * directly into the Playwright browser context before saving storage state.
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

// @supabase/ssr derives the localStorage/cookie key from the project ref
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0]
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`
const MAX_CHUNK_SIZE = 3180

/** Replicates @supabase/ssr's createChunks logic */
function buildCookieChunks(key: string, value: string): Array<{ name: string; value: string }> {
  let encoded = encodeURIComponent(value)
  if (encoded.length <= MAX_CHUNK_SIZE) {
    return [{ name: key, value }]
  }
  const chunks: string[] = []
  while (encoded.length > 0) {
    let head = encoded.slice(0, MAX_CHUNK_SIZE)
    const lastEscape = head.lastIndexOf('%')
    if (lastEscape > MAX_CHUNK_SIZE - 3) head = head.slice(0, lastEscape)
    let valueHead = ''
    while (head.length > 0) {
      try { valueHead = decodeURIComponent(head); break }
      catch { head = head.slice(0, head.length - 3) }
    }
    chunks.push(valueHead)
    encoded = encoded.slice(encodeURIComponent(valueHead).length)
  }
  return chunks.map((v, i) => ({ name: `${key}.${i}`, value: v }))
}

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

  fs.mkdirSync(path.dirname(STORAGE_FILE), { recursive: true })

  const browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()

  // Navigate to app so the domain is established before setting cookies
  await page.goto(BASE_URL)

  // Set auth cookies (what @supabase/ssr middleware reads)
  const parsedBase = new URL(BASE_URL)
  const cookieDomain = parsedBase.hostname
  const isSecure = parsedBase.protocol === 'https:'
  const sessionStr = JSON.stringify(data.session)
  const chunks = buildCookieChunks(STORAGE_KEY, sessionStr)
  await context.addCookies(
    chunks.map(({ name, value }) => ({
      name,
      value,
      domain: cookieDomain,
      path: '/',
      httpOnly: false,
      secure: isSecure,
      sameSite: 'Lax',
    }))
  )

  // Also set localStorage (for client-side Supabase calls)
  await page.evaluate(
    ({ key, session }: { key: string; session: unknown }) => {
      localStorage.setItem(key, JSON.stringify(session))
    },
    { key: STORAGE_KEY, session: data.session }
  )

  await context.storageState({ path: STORAGE_FILE })
  await browser.close()

  console.log(`  ✓ E2E session saved for ${email} (${chunks.length} cookie chunk${chunks.length > 1 ? 's' : ''})`)
}
