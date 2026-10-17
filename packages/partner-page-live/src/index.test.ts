import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NOTICE_KINDS,
  PARTNER_PAGE_NOTICE_EVENT,
  parseLiveMissReport,
  parsePartnerPageNotice,
  partnerPageTopic,
} from './index'

const ORG = '11111111-1111-1111-1111-111111111111'
const PARTNER = '33333333-3333-3333-3333-333333333333'
const SAVE = '0b9f6c1e-3c2a-4d7e-8f10-2a3b4c5d6e7f'

/** A notice as notify_partner_page builds it, plus the id realtime.send adds. */
const sent = (over: Record<string, unknown> = {}) => ({
  id: 'e1d2c3b4-a596-4877-8695-a4b3c2d1e0f9',
  partner_id: PARTNER,
  partner_version: 4,
  profile_version: 2,
  save_id: SAVE,
  client_id: null,
  kind: 'page',
  changed_columns: ['name', 'buyer_profiles'],
  direct: false,
  ...over,
})

describe('the topic and event (#2135)', () => {
  it('is the private topic the realtime policy admits a member of the organization to', () => {
    // supabase/migrations/20261015000000_partner_page_realtime_auth.sql:
    // realtime.topic() = 'partners:' || public.user_org_id()::text
    expect(partnerPageTopic(ORG)).toBe(`partners:${ORG}`)
    expect(PARTNER_PAGE_NOTICE_EVENT).toBe('partner_changed')
  })

  it('names the same topic prefix and event the migration sends on', () => {
    const migration = readMigration()
    expect(migration).toContain(`'${PARTNER_PAGE_NOTICE_EVENT}',\n      'partners:' || p_org::text,`)
  })
})

describe('parsePartnerPageNotice', () => {
  it('reads a notice as the database sends it', () => {
    expect(parsePartnerPageNotice(sent())).toEqual({
      partnerId: PARTNER,
      partnerVersion: 4,
      profileVersion: 2,
      saveId: SAVE,
      clientId: null,
      kind: 'page',
      changedColumns: ['name', 'buyer_profiles'],
      direct: false,
    })
  })

  it('keeps the nulls the database sends for a deleted partner, a partner with no profile, and no column list', () => {
    expect(parsePartnerPageNotice(sent({ kind: 'deleted', partner_version: null, profile_version: null, save_id: null, changed_columns: null })))
      .toMatchObject({ kind: 'deleted', partnerVersion: null, profileVersion: null, saveId: null, changedColumns: null })
  })

  it.each([
    ['not an object', 'partner_changed'],
    ['no partner id', sent({ partner_id: undefined })],
    ['a partner id that is not a UUID', sent({ partner_id: 'p-1' })],
    ['an unknown kind', sent({ kind: 'rename' })],
    ['a fractional version', sent({ partner_version: 1.5 })],
    ['a direct flag that is not a boolean', sent({ direct: 'false' })],
    ['a column list holding a non string', sent({ changed_columns: ['name', 3] })],
    ['a save id that is not a UUID', sent({ save_id: 'save-1' })],
  ])('refuses %s', (_label, payload) => {
    expect(parsePartnerPageNotice(payload)).toBeNull()
  })

  it('accepts every kind the migration sends, and the migration sends no kind it does not know', () => {
    const migration = readMigration()
    const sentKinds = new Set([...migration.matchAll(/notify_partner_page\([^,]+,\s*[^,]+,\s*'([a-z_]+)'/g)].map((m) => m[1]))
    expect(sentKinds.size).toBeGreaterThan(0)
    expect([...sentKinds].sort()).toEqual([...NOTICE_KINDS].sort())
    for (const kind of NOTICE_KINDS) expect(parsePartnerPageNotice(sent({ kind }))?.kind).toBe(kind)
  })
})

describe('a refused join for a missing partition is a live miss (#2288)', () => {
  it('parses with no versions observed, since nothing was probed', () => {
    const parsed = parseLiveMissReport({
      partner_id: PARTNER, cause: 'missing_partition',
      noticed: { partner_version: 7, profile_version: null }, observed: { partner_version: null, profile_version: null },
      since_last_notice_ms: null,
    })
    expect(parsed).toMatchObject({ ok: true, report: { cause: 'missing_partition', observed: { partnerVersion: null, profileVersion: null } } })
  })
})

describe('parseLiveMissReport', () => {
  const report = (over: Record<string, unknown> = {}) => ({
    partner_id: PARTNER,
    cause: 'delivery',
    noticed: { partner_version: 3, profile_version: 2 },
    observed: { partner_version: 4, profile_version: 2 },
    since_last_notice_ms: 61_000,
    ...over,
  })

  it('reads a report a page posts', () => {
    expect(parseLiveMissReport(report())).toEqual({
      ok: true,
      report: {
        partnerId: PARTNER,
        cause: 'delivery',
        noticed: { partnerVersion: 3, profileVersion: 2 },
        observed: { partnerVersion: 4, profileVersion: 2 },
        sinceLastNoticeMs: 61_000,
      },
    })
  })

  it('takes null versions and an unknown gap', () => {
    const parsed = parseLiveMissReport(report({ noticed: { partner_version: 3, profile_version: null }, since_last_notice_ms: null }))
    expect(parsed).toMatchObject({ ok: true, report: { noticed: { profileVersion: null }, sinceLastNoticeMs: null } })
  })

  it.each([
    ['no partner id', report({ partner_id: undefined }), 'partner_id'],
    ['a cause it does not know', report({ cause: 'sleep' }), 'cause'],
    ['no observed versions', report({ observed: undefined }), 'observed'],
    ['a negative gap', report({ since_last_notice_ms: -1 }), 'since_last_notice_ms'],
    ['a gap past a day', report({ since_last_notice_ms: 86_400_001 }), 'since_last_notice_ms'],
    ['a version below zero', report({ observed: { partner_version: -1, profile_version: 0 } }), 'observed'],
  ])('refuses %s, naming the field', (_label, body, field) => {
    expect(parseLiveMissReport(body)).toEqual({ ok: false, field })
  })
})

function readMigration(): string {
  const dir = path.resolve(import.meta.dirname, '../../../supabase/migrations')
  const file = readdirSync(dir).find((f) => f.endsWith('_partner_page_notice_2135.sql'))
  if (!file) throw new Error('the #2135 migration is not in supabase/migrations')
  return readFileSync(path.join(dir, file), 'utf8')
}
