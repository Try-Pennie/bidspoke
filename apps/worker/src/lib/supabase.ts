import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'

export function createSupabaseClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  })
}
