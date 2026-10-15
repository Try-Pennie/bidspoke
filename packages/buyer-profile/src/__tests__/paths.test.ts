/**
 * One declared source for profile path spellings (#2132, L26).
 *
 * The database's buyer_profile_flatten and this package's flatten key the same
 * document two ways (`windows.1.540` against `windows[1:540]`, and a tier by
 * field against a tier as one row). The partners page registry is keyed in the
 * TypeScript spelling, and SQL paths (audit rows, the 409 detail) are converted
 * at this one tested point. Both are checked against the shared fixture
 * fixtures/flatten-cases.json, which the SQL suite also checks
 * buyer_profile_flatten against.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { flattenProfileDocument } from '../diff'
import { normaliseSqlPath, registryPathOf } from '../paths'
import type { BuyerProfileDocument } from '../document'

interface FlattenCase { name: string; document: BuyerProfileDocument; paths: { ts: string[]; sql: string[] } }
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../../fixtures/flatten-cases.json'), 'utf8')) as { cases: FlattenCase[] }
const sorted = (xs: Iterable<string>) => [...xs].sort()

describe('the shared flatten fixture', () => {
  it('holds cases', () => {
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s: the TypeScript flatten gives exactly the ts paths', (_name, c) => {
    expect(sorted(flattenProfileDocument(c.document).keys())).toEqual(sorted(c.paths.ts))
  })

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s: every sql path normalises to a ts path, and together they cover them all', (_name, c) => {
    expect(sorted(new Set(c.paths.sql.map(normaliseSqlPath)))).toEqual(sorted(c.paths.ts))
  })
})

describe('normaliseSqlPath', () => {
  it('converts each row kind and leaves a scalar alone', () => {
    expect(normaliseSqlPath('windows.1.540')).toBe('windows[1:540]')
    expect(normaliseSqlPath('blackout_dates.2026-12-25')).toBe('blackout_dates[2026-12-25]')
    expect(normaliseSqlPath('tiers.engine.10000.debt_to')).toBe('tiers[engine:10000]')
    expect(normaliseSqlPath('tiers.engine.20000.5.multiplier')).toBe('tiers[engine:20000.5]')
    expect(normaliseSqlPath('click_delivery.routes[DV1]')).toBe('click_delivery.routes[DV1]')
    expect(normaliseSqlPath('debt_min')).toBe('debt_min')
  })

  it('refuses a path it cannot place, rather than passing it through as a new field', () => {
    expect(() => normaliseSqlPath('windows.1')).toThrow(/windows\.1/)
    expect(() => normaliseSqlPath('tiers.engine.10000.price')).toThrow(/tiers\.engine\.10000\.price/)
  })
})

describe('registryPathOf (#2133)', () => {
  it('names a profile field in the partners page registry spelling, under profile.', () => {
    expect(registryPathOf('debtMin')).toBe('profile.debt_min')
    expect(registryPathOf('hourlySpendCapCents')).toBe('profile.hourly_spend_cap_cents')
    expect(registryPathOf('allowedStates')).toBe('profile.allowed_states')
    expect(registryPathOf('soldOn')).toBe('profile.sold_on')
  })

  it('names the partner record rules the validator reads by their own keys', () => {
    expect(registryPathOf('acceptSignals')).toBe('accept_signals')
    expect(registryPathOf('clickUrl')).toBe('click_url')
    expect(registryPathOf('externalRoutingCode')).toBe('external_routing_code')
  })

  it('names a whole row list by its row pattern, and a click route by its name when it has one', () => {
    expect(registryPathOf('windows')).toBe('profile.windows[*]')
    expect(registryPathOf('blackoutDates')).toBe('profile.blackout_dates[*]')
    expect(registryPathOf('tiers')).toBe('profile.tiers[*]')
    expect(registryPathOf('clickDelivery')).toBe('profile.click_delivery.routes[*]')
    expect(registryPathOf('clickDelivery.routes')).toBe('profile.click_delivery.routes[*]')
    expect(registryPathOf('clickDelivery.successPattern')).toBe('profile.click_delivery.success_pattern')
    expect(registryPathOf('clickDelivery.routes[1].url', ['DV1', ' DI4 '])).toBe('profile.click_delivery.routes[DI4]')
    expect(registryPathOf('clickDelivery.routes[2].url', ['DV1'])).toBe('profile.click_delivery.routes[*]')
    expect(registryPathOf('clickDelivery.routes[0].name', [''])).toBe('profile.click_delivery.routes[*]')
  })
})
