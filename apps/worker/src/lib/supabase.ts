import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import type { Database } from '../types/database'

export function createSupabaseClient(env: Env): SupabaseClient<Database> {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  })
}
