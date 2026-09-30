/**
 * The buyer objects drill against the REAL objects in workerd (#1410).
 *
 * This is the same code the POST /api/admin/buyer-objects/drill route runs in
 * production after deploy: the two lead race, the in_doubt race and a kill
 * after reserve, under the rehearsal kind against a throwaway buyer, with the
 * p50 and p99 of every object call recorded. Here it proves the drill itself
 * passes against real storage, so a red in production is about production.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../index'
import { buyerObjectsHealth, runBuyerObjectsDrill } from '../../lib/buyer-objects-health'

const bindings = env as unknown as Pick<Env, 'BUYER_LEDGER' | 'LEAD_SALE'>

describe('buyer objects health probe', () => {
  it('reads one object of each kind and reports ok', async () => {
    const report = await buyerObjectsHealth(bindings)
    expect(report.ok).toBe(true)
    expect(report.ledger.ok).toBe(true)
    expect(report.sale.ok).toBe(true)
  })
})

describe('buyer objects drill', () => {
  it('every scenario passes and every object call has a latency sample', async () => {
    const report = await runBuyerObjectsDrill(bindings, { partnerId: 'drill-test' })
    expect(report.scenarios.map((s) => `${s.name}: ${s.ok ? 'ok' : s.detail}`)).toEqual([
      'two leads race for one slot: ok',
      'two executions race on an in_doubt claim: ok',
      'an attempt killed after its reserve: ok',
      'an attempt killed after its commit is healed from the ledger: ok',
    ])
    expect(report.ok).toBe(true)
    // The drill's own claim events (#1643): the in_doubt race, the kill after reserve and the kill
    // after commit each expire one claim, and the kill after commit is healed from the ledger.
    expect(report.claim_events).toEqual({ expired_in_flight: 3, in_doubt_heals: 1 })
    expect(report.partner_id).toBe('drill-test')
    for (const op of ['lead sale claim', 'buyer ledger reserve', 'buyer ledger commit', 'lead sale sold', 'buyer ledger entry', 'lead sale free', 'buyer ledger release', 'lead sale heal']) {
      expect(report.latency[op], op).toMatchObject({ calls: expect.any(Number), p50_ms: expect.any(Number), p99_ms: expect.any(Number) })
      expect(report.latency[op].calls).toBeGreaterThan(0)
    }
  })

  it('a second drill against the same throwaway buyer also passes, whatever the first left in the hour', async () => {
    const first = await runBuyerObjectsDrill(bindings, { partnerId: 'drill-repeat' })
    const second = await runBuyerObjectsDrill(bindings, { partnerId: 'drill-repeat' })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
  })
})
