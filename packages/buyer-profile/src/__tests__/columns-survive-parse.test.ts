/**
 * The parser direction of the partners page column guard (#2143, L425, L96).
 *
 * partner-page-columns.json lists every column of the profile tables with the
 * registry path the page edits it at, and the SQL suite fails when a column is
 * missing from it. But every save route runs the body through
 * parseProfileDocument, which builds a NEW document from the fields it declares
 * and drops any other key, so a column could be listed, given a registry entry
 * and a control, and still be thrown away on every save. Here every listed
 * profile path must be carried by the shared fixture's fullest document and
 * survive a parse of it.
 *
 * Seen red: display_time_zone listed in the column file and in the fixture
 * before the parser declared it.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseProfileDocument } from '../document'

const fixtures = path.resolve(__dirname, '../../fixtures')
const columns = JSON.parse(readFileSync(path.join(fixtures, 'partner-page-columns.json'), 'utf8')) as {
  tables: Record<string, Record<string, { path?: string; paths?: string[]; excluded?: string }>>
}
const flatten = JSON.parse(readFileSync(path.join(fixtures, 'flatten-cases.json'), 'utf8')) as {
  cases: Array<{ name: string; document: Record<string, unknown> }>
}

const PROFILE_TABLES = ['buyer_profiles', 'buyer_operating_windows', 'buyer_blackout_dates', 'buyer_pricing_tiers']

/** JSON with object keys sorted, so the parser's key order is not read as a change. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v))
}

/** The document key a registry path is stored under: `profile.windows[*]` is `windows`, `profile.click_delivery.routes[*]` is `click_delivery`. */
function documentKeyOf(registryPath: string): string {
  return registryPath.slice('profile.'.length).split(/[.[]/)[0]
}

describe('every listed profile column survives a parse (L425)', () => {
  const listed = PROFILE_TABLES.flatMap((t) => Object.entries(columns.tables[t] ?? {}).flatMap(([column, c]) => (c.paths ?? (c.path ? [c.path] : [])).map((p) => ({ column: `${t}.${column}`, key: documentKeyOf(p) }))))
  const fullest = flatten.cases[0]

  it('reads the profile tables and the fixture it judges against', () => {
    expect(listed.length).toBeGreaterThan(20)
    expect(fullest.name).toBe('every row kind and every scalar')
  })

  it('the fixture document carries every listed column, and the parser keeps each one', () => {
    const parsed = parseProfileDocument(fullest.document)
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true)
    const kept = parsed.ok ? (parsed.document as unknown as Record<string, unknown>) : {}
    const missingFromFixture = listed.filter(({ key }) => !(key in fullest.document)).map(({ column, key }) => `${column} (${key})`)
    const dropped = listed.filter(({ key }) => key in fullest.document && canonical(kept[key]) !== canonical(fullest.document[key])).map(({ column, key }) => `${column} (${key})`)
    expect(missingFromFixture, 'columns the shared fixture document does not carry').toEqual([])
    expect(dropped, 'columns parseProfileDocument drops or changes').toEqual([])
  })
})
