/**
 * unflattenProfileDocument, the inverse of flattenProfileDocument (#2134).
 *
 * The partners page merge (apps/web/src/lib/partner-page-merge.ts) decides a
 * buyer profile path by path, in flattenProfileDocument's keys, and rebuilds the
 * document it saves from the chosen paths. So the rebuild must give back every
 * document the flatten was made from: checked over every document in the shared
 * fixture, which covers every row kind and every scalar.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { flattenProfileDocument, unflattenProfileDocument } from '../diff'
import { parseProfileDocument, type BuyerProfileDocument } from '../document'

const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../../fixtures/flatten-cases.json'), 'utf8')) as { cases: Array<{ name: string; document: BuyerProfileDocument }> }

/** The document as flatten normalises it: no identity, states sorted, a route's states sorted, no delivery read as none. */
function normalised(doc: BuyerProfileDocument): BuyerProfileDocument {
  const { partner_id: _p, version: _v, ...rest } = doc
  return {
    ...rest,
    allowed_states: [...doc.allowed_states].sort(),
    click_delivery: doc.click_delivery ? { ...doc.click_delivery, routes: doc.click_delivery.routes.map((r) => ({ ...r, states: [...r.states].sort() })) } : null,
  }
}

describe('unflattenProfileDocument', () => {
  it('has fixture documents to check, so the round trip cannot pass vacuously', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(2)
  })

  it.each(fixture.cases.map((c) => [c.name, c.document] as const))('gives back %s, and the rebuilt document parses', (_name, doc) => {
    const rebuilt = unflattenProfileDocument(flattenProfileDocument(doc))
    expect(rebuilt).toEqual(normalised(doc))
    expect(parseProfileDocument(rebuilt)).toMatchObject({ ok: true })
    expect([...flattenProfileDocument(rebuilt).entries()]).toEqual([...flattenProfileDocument(doc).entries()])
  })

  it('keeps rows in the order of the paths it is given, so a merge decides the order and not the rebuild', () => {
    const doc = fixture.cases[0].document
    const twoWindows: BuyerProfileDocument = { ...doc, windows: [{ day_of_week: 3, opens_minute: 60, closes_minute: 120 }, { day_of_week: 1, opens_minute: 540, closes_minute: 1020 }] }
    expect(unflattenProfileDocument(flattenProfileDocument(twoWindows)).windows.map((w) => w.day_of_week)).toEqual([3, 1])
  })

  it('a document with no delivery paths has no delivery, and one with only a success line has no routes', () => {
    const doc = fixture.cases[0].document
    const paths = flattenProfileDocument(doc)
    for (const key of [...paths.keys()]) if (key.startsWith('click_delivery.routes[')) paths.delete(key)
    expect(unflattenProfileDocument(paths).click_delivery).toEqual({ success_pattern: doc.click_delivery!.success_pattern, routes: [] })
    paths.delete('click_delivery.success_pattern')
    expect(unflattenProfileDocument(paths).click_delivery).toBeNull()
  })

  it('refuses a document missing a scalar or the state list rather than rebuilding it empty', () => {
    for (const key of ['daily_lead_cap', 'allowed_states']) {
      const paths = flattenProfileDocument(fixture.cases[1].document)
      paths.delete(key)
      expect(() => unflattenProfileDocument(paths), key).toThrow(new RegExp(key))
    }
  })

  it('refuses a route path whose value is not an address and states, by name', () => {
    const paths = flattenProfileDocument(fixture.cases[0].document)
    const key = [...paths.keys()].find((k) => k.startsWith('click_delivery.routes['))!
    paths.set(key, { url: 'https://x.example' })
    expect(() => unflattenProfileDocument(paths)).toThrow(/is not a route of an address and states/)
  })

  it('refuses a path it cannot place rather than dropping it', () => {
    const paths = flattenProfileDocument(fixture.cases[1].document)
    paths.set('loan_amount_max', 5)
    expect(() => unflattenProfileDocument(paths)).toThrow(/loan_amount_max/)
  })
})
