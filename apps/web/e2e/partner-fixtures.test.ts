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
import { answerFor, isWorkerApiRequest, LIVE_MISS_ID, loadPartnerFixtures, realtimeReplies, versionsFor } from './partner-fixtures'
import { RealtimeClient } from '@supabase/supabase-js'
import { mergeThreeWay } from '../src/lib/partner-page-merge'
import { buildPartnerBody, PARTNER_FIELD_REGISTRY, snapshotOf } from '../src/app/(app)/partners/partner-draft'
import type { Partner } from '../src/lib/api'

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

  // #2140: the two delete boxes the spec scans, and no other partner's, so a
  // page opening another partner fails its scan as unmatched rather than passing.
  it('answers the delete check of Tripoint, blocked by its sales, and Liberty1, deletable, only', () => {
    const liberty1 = fx.partners.find((p) => p.slug === 'liberty1')!
    const blocked = answerFor('GET', `${W}/api/partners/${tripoint.id}/delete-check`, fx)?.body as { blockers: Array<{ kind: string; table?: string }> }
    expect(blocked.blockers).toEqual([expect.objectContaining({ kind: 'rows', table: 'buyer_sales' })])
    const ready = answerFor('GET', `${W}/api/partners/${liberty1.id}/delete-check`, fx)?.body as { blockers: unknown[]; removes: unknown[] }
    expect(ready.blockers).toEqual([])
    expect(ready.removes.length).toBeGreaterThan(0)
    expect(answerFor('GET', `${W}/api/partners/${fx.partners.find((p) => p.slug === 'sofi')!.id}/delete-check`, fx)).toBeNull()
    expect(answerFor('GET', `${W}/api/partners/_about/delete-check`, fx)).toBeNull()
    expect(answerFor('GET', `${W}/api/partners/constructor/delete-check`, fx)).toBeNull()
  })

  // #2137: the Bid Group tab reads which workflow steps name each partner.
  it('answers the usage read for every listed partner, and fails it only when asked to', () => {
    for (const p of fx.partners) expect(answerFor('GET', `${W}/api/partners/${p.id}/usage`, fx), p.slug).toMatchObject({ status: 200 })
    expect(answerFor('GET', `${W}/api/partners/not-a-partner/usage`, fx)).toBeNull()
    // An inherited name of a plain object is no partner either (each read keyed by partner id).
    for (const path of ['partners/constructor/usage', 'partners/constructor/buyer-profile', 'partner-bid-configs?partner_id=constructor', 'partners/toString/delete-check']) {
      expect(answerFor('GET', `${W}/api/${path}`, fx), path).toBeNull()
    }
    expect(answerFor('GET', `${W}/api/partners/${tripoint.id}/usage`, fx, { usageFails: true })?.status).toBe(503)
  })

  it('the measured usage names Tripoint and AmOne in Main Flow\'s Bid Group, live and draft, and nobody else', () => {
    const named = Object.entries(fx.usage as Record<string, { bid_group: Array<{ workflow_name: string; is_active: boolean }> }>)
      .filter(([, u]) => u.bid_group.length > 0)
      .map(([id, u]) => [fx.partners.find((p) => p.id === id)!.slug, u.bid_group.map((s) => `${s.workflow_name}${s.is_active ? '' : ' (off)'}`)])
    expect(named.sort()).toEqual([['amone', ['Main Flow', 'Main Flow (v2) (off)']], ['tripoint', ['Main Flow', 'Main Flow (v2) (off)']]])
  })

  // #2139: the held clicks cards, the lead id box and the Remove dialog are reached
  // from Liberty1's invented held clicks; every other read stays the empty panel.
  it('gives Liberty1 its held clicks only when asked to, with a held click, a sale with no lead id and a sale Salesforce refused', () => {
    const liberty1 = fx.partners.find((p) => p.slug === 'liberty1')!
    const url = `${W}/api/held-clicks?partner_id=${liberty1.id}`
    expect(answerFor('GET', url, fx)?.body).toEqual(fx.panels.held_clicks)
    const list = answerFor('GET', url, fx, { heldClicks: true })?.body as { entries: Array<{ claim: { status: string; partner_lead_id?: string | null }; salesforce_standing: string | null }>; total: number }
    expect(list).toEqual(fx.heldClicks.list)
    expect(list.entries.map((e) => [e.claim.status, e.claim.partner_lead_id ?? null, e.salesforce_standing])).toEqual([['held', null, null], ['sold', null, 'written'], ['sold', 'L1F-778', 'incomplete']])
    expect(answerFor('GET', `${W}/api/held-clicks?partner_id=${tripoint.id}`, fx, { heldClicks: true })?.body).toEqual(fx.panels.held_clicks)
  })

  it('answers adding a lead id only for a listed sale, and only when asked to', () => {
    const sale = fx.heldClicks.list.entries[1]
    expect(answerFor('POST', `${W}/api/held-clicks/${sale.id}/lead-id`, fx)).toBeNull()
    expect(answerFor('POST', `${W}/api/held-clicks/${sale.id}/lead-id`, fx, { heldClicks: true })).toEqual({ status: 200, body: fx.heldClicks.lead_id })
    expect(answerFor('POST', `${W}/api/held-clicks/not-listed/lead-id`, fx, { heldClicks: true })).toBeNull()
    expect(answerFor('POST', `${W}/api/held-clicks/${sale.id}/mark-sent`, fx, { heldClicks: true })).toBeNull()
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

  // #2135: the live channel's versions probe, its refetch and its miss report.
  it('answers the versions probe for every listed partner from its captured version and profile, and nothing for another', () => {
    for (const p of fx.partners) {
      const answer = answerFor('GET', `${W}/api/partners/${p.id}/versions`, fx)
      expect(answer, p.slug).toEqual({ status: 200, body: versionsFor(p, fx.buyerProfiles) })
      const body = answer!.body as { partnerVersion: number; profileVersion: number; latestChange: unknown }
      expect(body.partnerVersion, p.slug).toBe(p.version)
      expect(body.latestChange).toBeNull()
    }
    const tripointProfile = fx.buyerProfiles[tripoint.id].profile as { version: number }
    expect((answerFor('GET', `${W}/api/partners/${tripoint.id}/versions`, fx)!.body as { profileVersion: number }).profileVersion).toBe(tripointProfile.version)
    expect(answerFor('GET', `${W}/api/partners/not-a-partner/versions`, fx)).toBeNull()
  })

  it('answers the refetch of one partner with its captured row, and a live miss report as recorded', () => {
    expect(answerFor('GET', `${W}/api/partners/${tripoint.id}`, fx)).toEqual({ status: 200, body: tripoint })
    expect(answerFor('GET', `${W}/api/partners/not-a-partner`, fx)).toBeNull()
    expect(answerFor('POST', `${W}/api/partners/live-miss`, fx)).toEqual({ status: 201, body: { ok: true, id: LIVE_MISS_ID } })
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

// #2135: the live channel's socket is answered in the browser, never by production's Realtime.
describe('realtimeReplies', () => {
  const ORG = String(fx.partners[0].organization_id)

  it('admits the partners page join, and answers a heartbeat, a token refresh and a leave', () => {
    const join = realtimeReplies(JSON.stringify(['1', '1', `realtime:partners:${ORG}`, 'phx_join', { config: { private: true } }]))
    expect(join.unexpected).toBeNull()
    expect(JSON.parse(join.replies[0])).toEqual(['1', '1', `realtime:partners:${ORG}`, 'phx_reply', { status: 'ok', response: { postgres_changes: [] } }])
    for (const event of ['heartbeat', 'access_token', 'phx_leave']) expect(realtimeReplies(JSON.stringify([null, '2', 'phoenix', event, {}])).replies, event).toHaveLength(1)
  })

  it('records a join to any other topic, and ignores what it cannot read', () => {
    expect(realtimeReplies(JSON.stringify(['1', '1', 'realtime:test-run-1', 'phx_join', {}]))).toEqual({ replies: [], unexpected: 'JOIN realtime:test-run-1' })
    // Only a UUID: not any 36 characters of hex and dashes.
    const dashes = `realtime:partners:${'-'.repeat(36)}`
    expect(realtimeReplies(JSON.stringify(['1', '1', dashes, 'phx_join', {}]))).toEqual({ replies: [], unexpected: `JOIN ${dashes}` })
    expect(realtimeReplies('not json')).toEqual({ replies: [], unexpected: null })
  })

  it('is enough for the real Realtime client to subscribe the page\'s private channel', async () => {
    // A socket that answers through realtimeReplies, given to the real client as its transport.
    class FixtureSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      readyState = 0
      binaryType = 'arraybuffer'
      url: string
      protocol = ''
      onopen: ((e: unknown) => void) | null = null
      onmessage: ((e: { data: string }) => void) | null = null
      onclose: ((e: unknown) => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      constructor(url: string) {
        this.url = url
        queueMicrotask(() => { this.readyState = 1; this.onopen?.({}) })
      }
      send(data: string) {
        for (const r of realtimeReplies(data).replies) queueMicrotask(() => this.onmessage?.({ data: r }))
      }
      close() { this.readyState = 3; this.onclose?.({ code: 1000 }) }
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() { return true }
    }
    type Options = NonNullable<ConstructorParameters<typeof RealtimeClient>[1]>
    const client = new RealtimeClient('wss://fixture.example/realtime/v1', { params: { apikey: 'fixture' }, transport: FixtureSocket as unknown as Options['transport'] })
    await client.setAuth('fixture-jwt')
    const status = await new Promise<string>((resolve) => {
      client.channel(`partners:${ORG}`, { config: { private: true } }).subscribe((s) => resolve(s))
    })
    expect(status).toBe('SUBSCRIBED')
    client.disconnect()
  })
})
