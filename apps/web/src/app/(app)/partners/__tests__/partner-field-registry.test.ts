/**
 * The partners page field registry covers every field, in both directions
 * (#2132, L96).
 *
 * The registry (PARTNER_FIELD_REGISTRY in partner-draft.ts) names, for every
 * path the page edits, its tab, section, label and, for a row list, its merge
 * group. A path with no entry would be invisible to the merge (PR3) and to the
 * problems that open where they are (PR6). So every one of these must match
 * exactly one registry pattern:
 * - every key of PartnerBody (enumerated at compile time by PARTNER_BODY_KEYS);
 * - every buyer profile path in the shared fixture, in the TypeScript spelling
 *   and in the SQL spelling through normaliseSqlPath;
 * - every non excluded column path in partner-page-columns.json, which the SQL
 *   suite (partner_page_columns.test.sql) checks against the real schema, so a
 *   column added to any of the five tables is caught even though no hand typed
 *   type mentions it.
 *
 * Seen red by deleting the 'dedup_endpoint' entry, and by adding the scalar
 * 'loan_amount_max' to the fixture's SQL paths only.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { normaliseSqlPath, registryPathOf } from '@bidspoke/buyer-profile'
import { PARTNER_BODY_KEYS, PARTNER_FIELD_REGISTRY, PROFILE_PREFIX, registryEntriesFor } from '../partner-draft'
import { REPO_ROOT } from '@/lib/__tests__/_scan-utils'

const fixtures = path.join(REPO_ROOT, 'packages/buyer-profile/fixtures')
const flatten = JSON.parse(readFileSync(path.join(fixtures, 'flatten-cases.json'), 'utf8')) as { cases: Array<{ paths: { ts: string[]; sql: string[] } }> }
const columns = JSON.parse(readFileSync(path.join(fixtures, 'partner-page-columns.json'), 'utf8')) as { tables: Record<string, Record<string, { path?: string; paths?: string[]; excluded?: string }>> }

function exactlyOne(paths: string[]): string[] {
  return paths
    .map((p) => ({ p, n: registryEntriesFor(p).length }))
    .filter(({ n }) => n !== 1)
    .map(({ p, n }) => `${p} matches ${n} registry entries`)
}

describe('the partners page field registry (#2132)', () => {
  it('every PartnerBody key matches exactly one entry', () => {
    expect(PARTNER_BODY_KEYS.length).toBeGreaterThan(30)
    expect(exactlyOne([...PARTNER_BODY_KEYS])).toEqual([])
  })

  it('every profile path in the shared fixture matches exactly one entry, in both spellings', () => {
    const ts = flatten.cases.flatMap((c) => c.paths.ts)
    const sql = flatten.cases.flatMap((c) => c.paths.sql.map(normaliseSqlPath))
    expect(ts.length).toBeGreaterThan(10)
    expect(exactlyOne([...new Set([...ts, ...sql])].map((p) => `${PROFILE_PREFIX}${p}`))).toEqual([])
  })

  it('every listed column path matches exactly one entry', () => {
    const listed = Object.values(columns.tables).flatMap((cols) => Object.values(cols).flatMap((c) => c.paths ?? (c.path ? [c.path] : [])))
    expect(listed.length).toBeGreaterThan(40)
    expect(exactlyOne([...new Set(listed)])).toEqual([])
  })

  it('every entry names a tab, a section and a label, and a row list names its merge group', () => {
    for (const e of PARTNER_FIELD_REGISTRY) {
      expect(e.tab, e.pattern).toBeTruthy()
      expect(e.section, e.pattern).toBeTruthy()
      expect(e.label, e.pattern).toBeTruthy()
      if (e.pattern.endsWith('[*]')) expect(e.mergeGroup, e.pattern).toBeTruthy()
    }
  })

  // PM-9 (#2136): the page no longer edits bid_mode. The column stays until its
  // contract step, so the column list keeps it, excluded as retired.
  it('bid_mode is not a path the page edits, and its column is excluded as retired', () => {
    expect(PARTNER_BODY_KEYS).not.toContain('bid_mode')
    expect(registryEntriesFor('bid_mode')).toEqual([])
    expect(columns.tables.partner_configs.bid_mode).toMatchObject({ excluded: 'retired' })
  })

  it('no two entries share a pattern', () => {
    const patterns = PARTNER_FIELD_REGISTRY.map((e) => e.pattern)
    expect(new Set(patterns).size).toBe(patterns.length)
  })

  // #2133: the page save names each refused field by its registry path. The
  // paths are read from the validator's own source (every err() call and the
  // bound, cap and unsupported cap helpers), so a path added there is held here
  // without anyone listing it. Seen red by mapping 'tiers' to 'profile.tiers'.
  it('every path the profile validator can refuse maps through registryPathOf to exactly one entry', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'packages/buyer-profile/src/validate.ts'), 'utf8')
    const found = new Set<string>()
    for (const re of [/\berr\([^,]+,\s*'([A-Za-z.]+)'/g, /\berr\([^,]+,\s*`([^`]+)`/g, /check(?:Bound|Cap)\([^,]+,\s*'([A-Za-z]+)'/g, /\[profile\.\w+,\s*'([A-Za-z]+)'/g]) {
      for (const m of source.matchAll(re)) found.add(m[1].replace(/\$\{i\}/g, '0'))
    }
    expect(found.size).toBeGreaterThan(20)
    expect(exactlyOne([...found].map((p) => registryPathOf(p, ['DV1'])))).toEqual([])
    expect(exactlyOne([...found].map((p) => registryPathOf(p)))).toEqual([])
  })

  it('matches a row list pattern by its key and nothing looser', () => {
    expect(registryEntriesFor('profile.windows[1:540]').map((e) => e.pattern)).toEqual(['profile.windows[*]'])
    expect(registryEntriesFor('profile.windows')).toEqual([])
    expect(registryEntriesFor('profile.click_delivery.routes[DV1]').map((e) => e.pattern)).toEqual(['profile.click_delivery.routes[*]'])
    expect(registryEntriesFor('priority').map((e) => e.pattern)).toEqual(['priority'])
    expect(registryEntriesFor('profile.priority').map((e) => e.pattern)).toEqual(['profile.priority'])
  })
})
