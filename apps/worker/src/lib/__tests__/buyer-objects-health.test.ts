/**
 * buyerObjectsHealth and the drill's pure parts (#1410). The probe reads one
 * throwaway object of each kind and reports each answer with its latency, ok or
 * named error, so a red is distinguishable from a shape (L11). The drill itself
 * runs against the real objects in the Workers suite; its percentile and summary
 * arithmetic is proven here.
 */
import { describe, expect, it } from 'vitest'
import { buyerObjectsHealth, percentiles, summarizeDrill, type DrillScenario } from '../buyer-objects-health'

function namespace(handler: (req: Request) => Promise<Response> | Response) {
  const names: string[] = []
  const ns = {
    idFromName: (name: string) => {
      names.push(name)
      return { name } as unknown as DurableObjectId
    },
    get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input, init))) }),
  } as unknown as DurableObjectNamespace
  return { ns, names }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('buyerObjectsHealth', () => {
  it('peeks the ledger and reads the claim under throwaway rehearsal names, reporting each latency', async () => {
    let t = 1000
    const clock = () => (t += 5)
    const ledger = namespace((req) => (new URL(req.url).pathname === '/peek' ? json({ hour_leads: 0 }) : json({ error: 'not_found' }, 404)))
    const sale = namespace((req) => (new URL(req.url).pathname === '/read' ? json({ state: 'free', generation: 0 }) : json({ error: 'not_found' }, 404)))
    const report = await buyerObjectsHealth({ BUYER_LEDGER: ledger.ns, LEAD_SALE: sale.ns }, { clock })
    expect(report).toEqual({
      ok: true,
      probed_at: new Date(1005).toISOString(),
      ledger: { ok: true, ms: 5 },
      sale: { ok: true, ms: 5 },
    })
    expect(ledger.names).toEqual(['buyer:health-probe'])
    expect(sale.names).toEqual(['sale:rehearsal:engine:health-probe'])
  })

  it('a failing object is reported by name with its error, and the whole report is not ok', async () => {
    const ledger = namespace(() => json({ hour_leads: 0 }))
    const sale = namespace(() => new Response('boom', { status: 500 }))
    const report = await buyerObjectsHealth({ BUYER_LEDGER: ledger.ns, LEAD_SALE: sale.ns }, { clock: () => 0 })
    expect(report.ok).toBe(false)
    expect(report.ledger).toEqual({ ok: true, ms: 0 })
    expect(report.sale).toEqual({ ok: false, ms: 0, error: 'lead sale read answered 500: boom' })
  })
})

describe('percentiles', () => {
  it('reports p50, p99 and max over the recorded calls, by nearest rank', () => {
    expect(percentiles([5, 1, 3, 2, 4])).toEqual({ calls: 5, p50_ms: 3, p99_ms: 5, max_ms: 5 })
    expect(percentiles([7])).toEqual({ calls: 1, p50_ms: 7, p99_ms: 7, max_ms: 7 })
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentiles(hundred)).toEqual({ calls: 100, p50_ms: 50, p99_ms: 99, max_ms: 100 })
  })

  it('refuses an empty sample rather than inventing a number (L90)', () => {
    expect(() => percentiles([])).toThrow('no calls recorded')
  })
})

describe('summarizeDrill', () => {
  it('is ok only when every scenario is ok, and carries each scenario as it was', () => {
    const passed: DrillScenario[] = [{ name: 'a', ok: true }, { name: 'b', ok: true }]
    const mixed: DrillScenario[] = [{ name: 'a', ok: true }, { name: 'b', ok: false, detail: 'expected sold, got no_sale' }]
    expect(summarizeDrill(passed)).toBe(true)
    expect(summarizeDrill(mixed)).toBe(false)
    expect(summarizeDrill([])).toBe(false)
  })
})
