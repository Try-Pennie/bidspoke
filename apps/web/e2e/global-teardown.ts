/**
 * Playwright global teardown: removes the workflows the suite created.
 *
 * Runs once after ALL specs, whatever they did and whichever of them failed, so a
 * crashed or interrupted run cannot leak rows the way the old per-file cleanup
 * did. It talks to the API and deletes by id, rather than clicking Delete on
 * whatever the workflows list happens to be showing.
 *
 * Every candidate must clear isDeletableTestWorkflow (see cleanup.ts): the e2e user
 * shares an organization with Main Flow and friends, so RLS will not save us if
 * this widens by accident.
 *
 * It fails LOUDLY. A cleanup that swallows its errors is how these rows ended up in
 * production in the first place: the run went green and nobody knew.
 */
import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import * as path from 'path'
import { isDeletableTestWorkflow, type WorkflowRow } from './cleanup'

dotenv.config({ path: path.resolve(__dirname, '../.env.test') })

const SUPABASE_URL = 'https://xvrmivmpfykwwtriqwpg.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_XT7MGOY5A0SftphNV29YZw_iexJjW9O'
const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL ?? 'http://localhost:8787'

export default async function globalTeardown() {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!email || !password) throw new Error('E2E_EMAIL and E2E_PASSWORD must be set in .env.test')

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`E2E teardown auth failed: ${error?.message ?? 'no session'}`)

  const auth = { Authorization: `Bearer ${data.session.access_token}` }

  const listRes = await fetch(`${WORKER_URL}/api/workflows`, { headers: auth })
  if (!listRes.ok) throw new Error(`E2E teardown: listing workflows failed (${listRes.status})`)
  const all = (await listRes.json()) as WorkflowRow[]

  const doomed = all.filter((w) => isDeletableTestWorkflow(w, email))
  if (doomed.length === 0) {
    console.log('  [ok] E2E teardown: nothing to clean up')
    return
  }

  const failed: string[] = []
  for (const w of doomed) {
    const res = await fetch(`${WORKER_URL}/api/workflows/${w.id}`, { method: 'DELETE', headers: auth })
    if (!res.ok) failed.push(`${w.name ?? w.id} (${res.status})`)
  }

  const deleted = doomed.length - failed.length
  console.log(`  [ok] E2E teardown: deleted ${deleted}/${doomed.length} test workflow(s)`)

  if (failed.length > 0) {
    // Loud on purpose: a silent failure here leaks rows into the production org.
    throw new Error(`E2E teardown could not delete ${failed.length} test workflow(s): ${failed.join(', ')}`)
  }
}
