import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import type { Database } from '../types/database'
import rpcLists from './read-only-rpcs.json'
import { guardLocalDevWrites, type RpcClassification } from './local-dev-write-guard'

// Local `wrangler dev` shares the real production Supabase project (there is no
// separate local backend), and the Worker connects as service_role, which
// bypasses RLS. So a local run can write anywhere in production. The guard in
// ./local-dev-write-guard blocks writes from local dev unless the operator
// explicitly opts in (#669); the ops database client carries the same guard
// (#1709).
//
// Reads stay allowed, and so do the rpcs on the READ ONLY list in
// read-only-rpcs.json (#1409, L96). The old rule let every rpc through on the
// claim that all of them read; record_archive_day_measurement already wrote,
// and save_buyer_profile is a user facing write path, so the rule is now an
// allowlist: a mutating rpc, or one nobody has classified, is refused with the
// same message as a blocked insert. auth_user_with_allowlist runs on every
// authenticated request and is on the read only list, so local dev stays usable.
const READ_ONLY_RPCS: ReadonlySet<string> = new Set(rpcLists.readOnly)
/** Exported for the guard tests and so a scan can name the writers (L41). */
export const MUTATING_RPCS: ReadonlySet<string> = new Set(rpcLists.mutating)

const BIDDING_RPCS: RpcClassification = {
  readOnly: READ_ONLY_RPCS,
  mutating: MUTATING_RPCS,
  listFile: 'apps/worker/src/lib/read-only-rpcs.json',
}

export function createSupabaseClient(env: Env): SupabaseClient<Database> {
  const client = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  })
  return guardLocalDevWrites(client, env, env.SUPABASE_URL, BIDDING_RPCS)
}
