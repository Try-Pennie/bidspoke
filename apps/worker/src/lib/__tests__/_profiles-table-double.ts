/**
 * A buyer_profiles table double that APPLIES the equality filters a reader
 * chains, the way PostgREST does, so a test proves which rows a reader gets
 * back rather than which methods it happened to call (L63). Only `.from`,
 * `.select` and `.eq` are modelled; anything else throws, so a reader that
 * starts using another filter is noticed rather than silently unfiltered.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type ProfileTableRow = Record<string, unknown>

export function profilesTableDouble(rows: ProfileTableRow[]): SupabaseClient {
  return {
    from(table: string) {
      if (table !== 'buyer_profiles') throw new Error(`unexpected table ${table}`)
      const filters: Array<[string, unknown]> = []
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => { filters.push([column, value]); return builder },
        then: (resolve: (v: { data: ProfileTableRow[]; error: null }) => void) =>
          resolve({ data: rows.filter((r) => filters.every(([c, v]) => r[c] === v)), error: null }),
      }
      return builder
    },
  } as unknown as SupabaseClient
}
