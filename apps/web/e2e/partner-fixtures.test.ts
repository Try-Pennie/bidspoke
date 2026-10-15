/**
 * The partners page fixtures the accessibility job is answered from (#2134).
 *
 * They are committed, so they must be redacted (L155), and they must reach the
 * surfaces the spec says it scans: the real list, a buyer and a source, the
 * merge dialog (the recorded 409 must conflict with the edit the spec makes) and
 * the matrix delete dialog. The Worker contract tests beside each route
 * (partners-fixtures-contract.test.ts) hold each fixture to the route's shape.
 */
import { describe, expect, it } from 'vitest'
import { parseProfileDocument, type BuyerProfileDocument } from '@bidspoke/buyer-profile'
import { createRedactor, stringsIn } from '../../../scripts/e2e-fixtures/redact.mjs'
import { answerFor, loadPartnerFixtures } from './partner-fixtures'
import { mergeThreeWay } from '../src/lib/partner-page-merge'
import { buildPartnerBody, PARTNER_FIELD_REGISTRY, snapshotOf } from '../src/app/(app)/partners/partner-draft'
import type { Partner } from '../src/lib/api'

const fx = loadPartnerFixtures()
const W = 'https://worker.example'

describe('the captured partners', () => {
  it('are the real nine, with a buyer and a source, and a profile answer for every buyer', () => {
    expect(fx.partners).toHaveLength(9)
    expect(fx.partners.some((p) => p.partner_type === 'buyer')).toBe(true)
    expect(fx.partners.some((p) => p.partner_type === 'source')).toBe(true)
    for (const p of fx.partners.filter((x) => x.partner_type === 'buyer')) expect(fx.buyerProfiles[p.id], p.slug).toBeDefined()
    for (const answer of Object.values(fx.buyerProfiles)) if (answer.profile) expect(parseProfileDocument(answer.profile)).toMatchObject({ ok: true })
  })

  it('carry no editor identity and no live webhook address', () => {
    const all = stringsIn([fx.partners, fx.buyerProfiles, fx.bidConfigs, fx.stale, fx.matrix])
    expect(all.filter((s) => s.includes('@') && !s.endsWith('@example.com'))).toEqual([])
    const urls = Object.values(fx.buyerProfiles).flatMap((a) => (a.profile as BuyerProfileDocument | null)?.click_delivery?.routes.map((r) => r.url) ?? [])
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((u) => u.startsWith('https://hooks.example.com/redacted/'))).toBe(true)
  })

  it('round trip through the form: buildPartnerBody(snapshotOf(row)) gives the body the page builds from the row', () => {
    for (const row of fx.partners as unknown as Partner[]) {
      const body = buildPartnerBody(snapshotOf(row), { slug: row.slug, isExisting: true })
      expect(buildPartnerBody(snapshotOf(body), { slug: row.slug, isExisting: true }), row.slug).toEqual(body)
    }
  })
})

describe('the redaction', () => {
  it('aliases each editor once, in order of first appearance, the same way every run', () => {
    const run = () => {
      const r = createRedactor()
      return [r.partner({ updated_by: 'u1', updated_by_email: 'a@x.com', updated_by_name: 'Ann' }), r.partner({ updated_by: 'u2', updated_by_email: 'b@x.com', updated_by_name: 'Bo' }), r.partner({ updated_by: 'u1', updated_by_email: 'a@x.com', updated_by_name: 'Ann' })]
    }
    const [a, b, again] = run()
    expect(a).toEqual({ updated_by: '00000000-0000-4000-8000-000000000001', updated_by_email: 'editor-a@example.com', updated_by_name: 'Editor A' })
    expect(b.updated_by_name).toBe('Editor B')
    expect(again).toEqual(a)
    expect(run()).toEqual([a, b, again])
  })

  it('replaces a click route address and keeps the route name and states', () => {
    const doc = { click_delivery: { success_pattern: 'x', routes: [{ name: 'DV1', url: 'https://hooks.real/secret', states: ['WA'] }] } }
    expect(createRedactor().profile(doc).click_delivery.routes).toEqual([{ name: 'DV1', url: 'https://hooks.example.com/redacted/DV1', states: ['WA'] }])
  })
})

describe('answerFor', () => {
  const tripoint = fx.partners.find((p) => p.slug === 'tripoint')!

  it('answers each read the page makes, and nothing it does not know', () => {
    expect(answerFor('GET', `${W}/api/partners`, fx)).toMatchObject({ status: 200 })
    expect(answerFor('GET', `${W}/api/partners/${tripoint.id}/buyer-profile`, fx)).toMatchObject({ status: 200 })
    expect(answerFor('GET', `${W}/api/partner-uuids`, fx)).toMatchObject({ status: 200 })
    expect(answerFor('GET', `${W}/api/partner-bid-configs?partner_id=${tripoint.id}`, fx)).toMatchObject({ status: 200 })
    expect(answerFor('GET', `${W}/api/workflows`, fx)).toBeNull()
    expect(answerFor('DELETE', `${W}/api/partners/${tripoint.id}`, fx)).toBeNull()
  })

  it('answers a page save only when asked to, and only with the recorded 409', () => {
    expect(answerFor('PUT', `${W}/api/partners/${tripoint.id}/page`, fx)).toBeNull()
    expect(answerFor('PUT', `${W}/api/partners/${tripoint.id}/page`, fx, { staleSave: true })).toEqual({ status: 409, body: fx.stale })
  })

  it('gives the matrix only when asked to', () => {
    const url = `${W}/api/partner-bid-configs?partner_id=${fx.matrix.list[0].partner_id}`
    expect(answerFor('GET', url, fx)?.body).toEqual([])
    expect(answerFor('GET', url, fx, { matrix: true })?.body).toEqual(fx.matrix.list)
    expect(answerFor('GET', `${W}/api/partner-bid-configs/${fx.matrix.list[0].id}`, fx, { matrix: true })?.body).toEqual(fx.matrix.detail)
  })

  it('the recorded 409 conflicts with the edit the spec makes (Leads per day to 300), so the merge dialog opens', () => {
    const profile = fx.buyerProfiles[tripoint.id].profile as BuyerProfileDocument
    const partner = buildPartnerBody(snapshotOf(tripoint as unknown as Partner), { slug: 'tripoint', isExisting: true })
    const theirs = fx.stale as unknown as { partner: Partner; profile: BuyerProfileDocument }
    const r = mergeThreeWay(
      { partner, profile },
      { partner, profile: { ...profile, daily_lead_cap: 300 } },
      { partner: buildPartnerBody(snapshotOf(theirs.partner), { slug: 'tripoint', isExisting: true }), profile: theirs.profile },
      PARTNER_FIELD_REGISTRY,
    )
    expect(r.conflicts.flatMap((s) => s.conflicts.map((c) => c.key))).toEqual(['profile.daily_lead_cap'])
  })
})
