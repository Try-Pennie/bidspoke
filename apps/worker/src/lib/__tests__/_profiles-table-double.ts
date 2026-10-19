/**
 * A buyer_profiles table double that APPLIES the equality filters a reader
 * chains, the way PostgREST does, so a test proves which rows a reader gets
 * back rather than which methods it happened to call (L63). Only `.from`,
 * `.select`, `.eq` and paging (`.order`, `.range`, #1437) are modelled; anything
 * else throws, so a reader that starts using another filter is noticed rather
 * than silently unfiltered.
 *
 * A filter on an embedded column (`organizations.is_synthetic`, #2135) removes
 * parent rows only when the select embeds that relation `!inner`, as PostgREST
 * does: without it the filter only empties the embed and every row comes back.
 * Rows carry the embed as a nested object (`organizations: { is_synthetic }`).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type ProfileTableRow = Record<string, unknown>

function valueAt(row: ProfileTableRow, path: string): unknown {
  return path.split('.').reduce<unknown>((v, key) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined), row)
}

export function profilesTableDouble(rows: ProfileTableRow[]): SupabaseClient {
  return {
    from(table: string) {
      if (table !== 'buyer_profiles') throw new Error(`unexpected table ${table}`)
      const filters: Array<[string, unknown]> = []
      let selected = ''
      let window: [number, number] | null = null
      const applies = (column: string) => {
        const dot = column.indexOf('.')
        return dot < 0 || selected.replace(/\s/g, '').includes(`${column.slice(0, dot)}!inner(`)
      }
      const builder = {
        select: (columns: string) => { selected = columns; return builder },
        eq: (column: string, value: unknown) => { filters.push([column, value]); return builder },
        // The rows stay in the order given; the page is the window asked for.
        order: () => builder,
        range: (from: number, to: number) => { window = [from, to]; return builder },
        then: (resolve: (v: { data: ProfileTableRow[]; error: null }) => void) => {
          const matched = rows.filter((r) => filters.every(([c, v]) => !applies(c) || valueAt(r, c) === v))
          // Unpaged, PostgREST answers at most its 1,000 row cap, silently (#1437).
          resolve({ data: window ? matched.slice(window[0], window[1] + 1) : matched.slice(0, 1000), error: null })
        },
      }
      return builder
    },
  } as unknown as SupabaseClient
}
