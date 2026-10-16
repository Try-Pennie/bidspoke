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
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRedactor, stringsIn } from '../../../scripts/e2e-fixtures/redact.mjs'
import { writeFixtures } from '../../../scripts/e2e-fixtures/capture-partners.mjs'
import { answerFor, isWorkerApiRequest, loadPartnerFixtures } from './partner-fixtures'
import { mergeThreeWay } from '../src/lib/partner-page-merge'
import { buildPartnerBody, PARTNER_FIELD_REGISTRY, snapshotOf } from '../src/app/(app)/partners/partner-draft'
import type { Partner, PartnerHistory } from '../src/lib/api'

const fx = loadPartnerFixtures()
/** A captured buyer profile document with every field the redaction keeps. */
const fixtureProfile = () => ({ ...(Object.values(fx.buyerProfiles).find((a) => a.profile)!.profile as Record<string, unknown>) })
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

  it('never repeats an alias past 26 editors', () => {
    const r = createRedactor()
    const names = Array.from({ length: 30 }, (_, i) => r.partner({ updated_by_name: `Person ${i}` }).updated_by_name)
    expect(new Set(names).size).toBe(30)
    expect(names[26]).toBe('Editor A2')
  })

  it('gives one person one alias whichever of their fields a row carries', () => {
    const r = createRedactor()
    const full = r.partner({ updated_by: 'u1', updated_by_email: 'a@x.com', updated_by_name: 'Ann' })
    r.partner({ updated_by: 'u2', updated_by_email: 'b@x.com', updated_by_name: 'Bo' })
    expect(r.partner({ updated_by: null, updated_by_email: 'a@x.com', updated_by_name: null }).updated_by_email).toBe(full.updated_by_email)
  })

  it('keeps a sample response\'s shape and replaces every text in it', () => {
    const out = createRedactor().partner({ last_probe_response: { ok: true, data: { id: 'lead-123', bid: 17.5, names: ['Jo'] } } })
    expect(out.last_probe_response).toEqual({ ok: true, data: { id: 'redacted', bid: 17.5, names: ['redacted'] } })
  })

  it('refuses a delivery with no route list, rather than committing whatever it holds', () => {
    expect(() => createRedactor().profile({ click_delivery: { success_pattern: 'x' } })).toThrow(/click_delivery\.routes/)
  })

  it('keeps only the profile fields it knows, and refuses any other', () => {
    const profile = fixtureProfile()
    expect(createRedactor().profile({ ...profile, display_time_zone: 'America/Chicago' }).display_time_zone).toBe('America/Chicago')
    expect(() => createRedactor().profile({ ...profile, contact_email: 'someone@example.com' })).toThrow(/contact_email/)
  })

  it('replaces a blackout date\'s note, typed by a person, and keeps the date', () => {
    const profile = { ...fixtureProfile(), blackout_dates: [{ date: '2026-12-25', note: 'Off for Ann\'s wedding' }, { date: '2026-12-26', note: null }] }
    expect(createRedactor().profile(profile).blackout_dates).toEqual([{ date: '2026-12-25', note: 'redacted' }, { date: '2026-12-26', note: null }])
  })

  it('rewrites only an editor field that has a value of its own', () => {
    const out = createRedactor().partner({ updated_by: null, updated_by_email: 'a@x.com', updated_by_name: null })
    expect(out).toEqual({ updated_by: null, updated_by_email: 'editor-a@example.com', updated_by_name: null })
  })

  it('replaces a click route address and keeps the route name and states', () => {
    const doc = { click_delivery: { success_pattern: 'x', routes: [{ name: 'DV1', url: 'https://hooks.real/secret', states: ['WA'] }] } }
    expect(createRedactor().profile(doc).click_delivery.routes).toEqual([{ name: 'DV1', url: 'https://hooks.example.com/redacted/DV1', states: ['WA'] }])
  })
})

describe('writeFixtures', () => {
  it('writes the same bytes whatever order the Worker answered in', () => {
    const write = (reverse: boolean) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'partner-fixtures-'))
      const order = <T,>(xs: T[]) => (reverse ? [...xs].reverse() : xs)
      writeFixtures({
        partners: order(fx.partners),
        profiles: fx.buyerProfiles as unknown as Record<string, Record<string, unknown> & { profile: unknown }>,
        uuids: order(fx.uuids as Array<Record<string, unknown> & { partner_slug: string; id: string }>),
        bidConfigs: fx.bidConfigs as Record<string, Array<Record<string, unknown>>>,
      }, dir)
      return Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(path.join(dir, f), 'utf8')]))
    }
    expect(write(true)).toEqual(write(false))
  })
})

describe('isWorkerApiRequest', () => {
  it('takes only the Worker\'s /api/ routes, so a page served from the same origin keeps its own requests', () => {
    expect(isWorkerApiRequest(new URL('https://worker.example/api/partners'), 'https://worker.example')).toBe(true)
    expect(isWorkerApiRequest(new URL('https://worker.example/partners?selected=tripoint'), 'https://worker.example')).toBe(false)
    expect(isWorkerApiRequest(new URL('https://worker.example/_next/static/chunk.js'), 'https://worker.example')).toBe(false)
    expect(isWorkerApiRequest(new URL('https://other.example/api/partners'), 'https://worker.example')).toBe(false)
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

  // #2137: the Bid Group tab reads which workflow steps name each partner.
  it('answers the usage read for every listed partner, and fails it only when asked to', () => {
    for (const p of fx.partners) expect(answerFor('GET', `${W}/api/partners/${p.id}/usage`, fx), p.slug).toMatchObject({ status: 200 })
    expect(answerFor('GET', `${W}/api/partners/not-a-partner/usage`, fx)).toBeNull()
    expect(answerFor('GET', `${W}/api/partners/${tripoint.id}/usage`, fx, { usageFails: true })?.status).toBe(503)
  })

  it('the measured usage names Tripoint and AmOne in Main Flow\'s Bid Group, live and draft, and nobody else', () => {
    const named = Object.entries(fx.usage as Record<string, { bid_group: Array<{ workflow_name: string; is_active: boolean }> }>)
      .filter(([, u]) => u.bid_group.length > 0)
      .map(([id, u]) => [fx.partners.find((p) => p.id === id)!.slug, u.bid_group.map((s) => `${s.workflow_name}${s.is_active ? '' : ' (off)'}`)])
    expect(named.sort()).toEqual([['amone', ['Main Flow', 'Main Flow (v2) (off)']], ['tripoint', ['Main Flow', 'Main Flow (v2) (off)']]])
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

// #2141: History, read from production's audit rows (read only, 2026-10-16) and
// redacted as a capture is, plus a synthetic matrix history (production holds no
// matrix sync rows) and the failed and incomplete answers.
describe('the History fixtures', () => {
  const tripoint = fx.partners.find((p) => p.slug === 'tripoint')!
  const liberty1 = fx.partners.find((p) => p.slug === 'liberty1')!

  it('hold every listed partner at the real count: 59 changes, 19 each for Tripoint and Liberty1', () => {
    expect(Object.keys(fx.history).sort()).toEqual(fx.partners.map((p) => p.id).sort())
    expect(fx.history[tripoint.id].entries).toHaveLength(19)
    expect(fx.history[liberty1.id].entries).toHaveLength(19)
    expect(Object.values(fx.history).reduce((n, h) => n + h.entries.length, 0)).toBe(59)
  })

  it('name no real person, carry no live webhook, prospect or buyer lead id', () => {
    const all = stringsIn([fx.history, fx.historyMatrix])
    expect(all.filter((s) => s.includes('@') && !s.endsWith('@example.com'))).toEqual([])
    const people = [...Object.values(fx.history), fx.historyMatrix].flatMap((h) => h.entries).flatMap((e) => (e.editor.kind === 'person' ? [e.editor.name] : []))
    expect(people.length).toBeGreaterThan(0)
    expect(people.every((n) => /^Editor [A-Z]\d*$/.test(n))).toBe(true)
    const urls = all.filter((s) => s.startsWith('http') && !s.startsWith('https://trypennie.com/'))
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((u) => u.startsWith('https://hooks.example.com/redacted/'))).toBe(true)
    const held = fx.history[liberty1.id].entries.filter((e) => e.entityType === 'held_click')
    expect(held).toHaveLength(2)
    for (const e of held) expect(e.changes).toMatchObject({ subject: { prospect_id: 'redacted' }, buyer_lead_id: { new: 'redacted' } })
  })

  it('give an editor the same alias the partner list gives them', () => {
    const lastEditor = String(tripoint.updated_by)
    const people = new Map(fx.history[tripoint.id].entries.flatMap((e) => (e.editor.kind === 'person' && e.editor.userId ? [[e.editor.userId, e.editor.name] as const] : [])))
    expect(people.get(lastEditor)).toBe(tripoint.updated_by_name)
  })

  it('redact a captured answer the same way, from a raw shape the route returns', () => {
    const r = createRedactor()
    r.partner({ updated_by: 'u1', updated_by_name: 'Ann' })
    const out = r.history({ partnerId: 'p', complete: true, completeSince: null, entries: [
      { editor: { kind: 'person', userId: 'u1', name: 'Ann', via: 'sync_now' }, editorLabel: 'Ann, Sync now from Salesforce', changes: { _actor: { name: 'Bo', email: 'bo@x.com' }, 'click_delivery.routes[DV1]': { old: null, new: { url: 'https://live.example/hook', states: ['WA'] } } } },
      { editor: { kind: 'direct' }, editorLabel: 'Changed directly in the database', changes: { added: [{ range: '1', source_url: 'https://sf.example/r1' }] } },
    ] })
    expect(out.entries[0]).toMatchObject({ editor: { userId: '00000000-0000-4000-8000-000000000001', name: 'Editor A' }, editorLabel: 'Editor A, Sync now from Salesforce' })
    expect(out.entries[0].changes).toEqual({ _actor: { name: 'Editor B', email: 'editor-b@example.com' }, 'click_delivery.routes[DV1]': { old: null, new: { url: 'https://hooks.example.com/redacted/DV1', states: ['WA'] } } })
    expect(out.entries[1]).toMatchObject({ editorLabel: 'Changed directly in the database', changes: { added: [{ range: '1' }] } })
  })

  it('refuses a person editor with no name rather than scattering the alias through the label', () => {
    expect(() => createRedactor().history({ partnerId: 'p', complete: true, completeSince: null, entries: [
      { editor: { kind: 'person', userId: 'u1', name: '', via: null }, editorLabel: 'Ann', changes: {} },
    ] })).toThrow(/no name/)
  })

  it('redacts every held click shape the route ties to a partner: a cleared claim\'s held_click.old and the Salesforce writes, as well as the subject', () => {
    const subject = { partner_id: 'p', prospect_id: 'a06REALPROSPECT', reason: 'outcome_unknown', held_at: '2026-09-30T15:57:55Z' }
    const out = createRedactor().history({ partnerId: 'p', complete: true, completeSince: null, entries: [
      { editor: { kind: 'direct' }, editorLabel: 'Changed directly in the database', changes: { held_click: { old: subject, new: null }, claim_state: { old: 'sold', new: 'sold' } } },
      { editor: { kind: 'direct' }, editorLabel: 'Changed directly in the database', changes: {
        subject, claim_state: { old: 'in_flight', new: 'sold' }, buyer_lead_id: { old: null, new: 'REALLEAD' },
        salesforce_writes: { old: null, new: { complete: true, writes: [{ record: 'prospect', id: 'a06REALPROSPECT', message: 'updated a06REALPROSPECT' }] } },
      } },
    ] })
    const strings = stringsIn(out)
    expect(strings.filter((s) => s.includes('REAL'))).toEqual([])
    expect(out.entries[0].changes).toMatchObject({ held_click: { old: { partner_id: 'p', prospect_id: 'redacted', reason: 'outcome_unknown' }, new: null } })
    expect(out.entries[1].changes).toMatchObject({ salesforce_writes: { old: null, new: { complete: true, writes: [{ record: 'redacted', id: 'redacted' }] } } })
  })

  it('answers the history read for every partner, fails it with the route\'s error when asked, and gives the matrix and incomplete answers only when asked', () => {
    for (const p of fx.partners) expect(answerFor('GET', `${W}/api/partners/${p.id}/history`, fx), p.slug).toEqual({ status: 200, body: fx.history[p.id] })
    expect(answerFor('GET', `${W}/api/partners/not-a-partner/history`, fx)).toBeNull()
    expect(answerFor('GET', `${W}/api/partners/${tripoint.id}/history`, fx, { historyFails: true })).toEqual({ status: 500, body: { error: 'history_unavailable', read: 'users', message: 'History could not be loaded: the users read failed.' } })
    expect(answerFor('GET', `${W}/api/partners/${tripoint.id}/history`, fx, { historyMatrix: true })?.body).toEqual(fx.historyMatrix)
    expect(answerFor('GET', `${W}/api/partners/${liberty1.id}/history`, fx, { historyMatrix: true })?.body).toEqual(fx.history[liberty1.id])
    const cut = answerFor('GET', `${W}/api/partners/${tripoint.id}/history`, fx, { historyIncomplete: true })?.body as PartnerHistory
    const oldest = fx.history[tripoint.id].entries.at(-1)!
    expect(cut.complete).toBe(false)
    expect(Date.parse(cut.completeSince!)).toBe(Date.parse(oldest.at))
    expect(cut.entries).toEqual(fx.history[tripoint.id].entries.slice(0, -1))
  })
})
