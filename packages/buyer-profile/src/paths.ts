/**
 * The one conversion from the database's profile path spelling to this
 * package's (#2132, L26).
 *
 * public.buyer_profile_flatten keys a window `windows.<day>.<opens>`, a
 * blackout `blackout_dates.<date>` and a tier by field,
 * `tiers.<population>.<from>.debt_to` and `.multiplier`. flattenProfileDocument
 * (diff.ts) keys them `windows[<day>:<opens>]`, `blackout_dates[<date>]` and
 * `tiers[<population>:<from>]`, a tier as one row. The partners page registry is
 * keyed in the TypeScript spelling, so every SQL path (an audit row's keys, a
 * conflict's detail) passes through here. fixtures/flatten-cases.json holds
 * both spellings for every row kind and scalar, and both flattens are checked
 * against it, one in vitest and one in the SQL suite.
 */

const TIER_FIELDS = ['debt_to', 'multiplier'] as const

/** The TypeScript spelling of a path buyer_profile_flatten produced. Throws on a path it cannot place. */
export function normaliseSqlPath(sqlPath: string): string {
  if (sqlPath.startsWith('windows.')) {
    const m = /^windows\.(\d+)\.(\d+)$/.exec(sqlPath)
    if (!m) throw new Error(`normaliseSqlPath: ${sqlPath} is not a window path`)
    return `windows[${m[1]}:${m[2]}]`
  }
  if (sqlPath.startsWith('blackout_dates.')) {
    return `blackout_dates[${sqlPath.slice('blackout_dates.'.length)}]`
  }
  if (sqlPath.startsWith('tiers.')) {
    const rest = sqlPath.slice('tiers.'.length)
    const field = TIER_FIELDS.find((f) => rest.endsWith(`.${f}`))
    if (!field) throw new Error(`normaliseSqlPath: ${sqlPath} names no tier field`)
    const row = rest.slice(0, -(field.length + 1))
    const dot = row.indexOf('.')
    if (dot <= 0 || dot === row.length - 1) throw new Error(`normaliseSqlPath: ${sqlPath} is not a tier path`)
    return `tiers[${row.slice(0, dot)}:${row.slice(dot + 1)}]`
  }
  return sqlPath
}
