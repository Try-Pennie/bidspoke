/**
 * Playwright global teardown: removes the workflows the suite created.
 *
 * Runs once after ALL specs, whatever they did and whichever of them failed, so a
 * crashed or interrupted run cannot leak rows the way the old per-file cleanup did.
 * It talks to the API and deletes by id, rather than clicking Delete on whatever
 * the workflows list happens to be showing.
 *
 * The decision about what may be deleted, and the loud failure when it cannot, both
 * live in cleanup.ts, where they are unit tested. This file is only the wiring: real
 * auth, real fetch.
 */
import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import * as path from 'path'
import { shouldSkipTeardown, sweepTestWorkflows, type WorkflowRow } from './cleanup'

dotenv.config({ path: path.resolve(__dirname, '../.env.test') })

const SUPABASE_URL = 'https://xvrmivmpfykwwtriqwpg.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_XT7MGOY5A0SftphNV29YZw_iexJjW9O'
const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL ?? 'http://localhost:8787'

export default async function globalTeardown() {
  // A run that created nothing has nothing to sweep. Said out loud, because a teardown
  // that quietly does nothing is indistinguishable from one that failed to clean up.
  if (shouldSkipTeardown(process.env)) {
    console.log('  [ok] E2E teardown skipped (E2E_SKIP_TEARDOWN): this run creates no workflows')
    return
  }

  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!email || !password) throw new Error('E2E_EMAIL and E2E_PASSWORD must be set in .env.test')

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`E2E teardown auth failed: ${error?.message ?? 'no session'}`)

  const auth = { Authorization: `Bearer ${data.session.access_token}` }

  const { deleted } = await sweepTestWorkflows(
    {
      list: async () => {
        const res = await fetch(`${WORKER_URL}/api/workflows`, { headers: auth })
        if (!res.ok) throw new Error(`E2E teardown: listing workflows failed (${res.status})`)
        return (await res.json()) as WorkflowRow[]
      },
      remove: async (id) => {
        const res = await fetch(`${WORKER_URL}/api/workflows/${id}`, { method: 'DELETE', headers: auth })
        return res.ok
      },
    },
    email,
  )

  console.log(`  [ok] E2E teardown: deleted ${deleted} test workflow(s)`)
}
