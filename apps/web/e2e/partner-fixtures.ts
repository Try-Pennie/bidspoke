/**
 * Every Worker call the partners page makes, answered from recorded fixtures
 * (#2134, plan #2130 Rules: accessibility coverage never waits on production).
 *
 * The accessibility job used to scan /partners against the production Worker,
 * so a surface that needs a save (the merge dialog) could not be reached without
 * writing to production. Here every request to the Worker is answered from
 * fixtures/partners/: the captured reads (capture-partners.mjs) and, under
 * synthetic/, the hand made answers for what cannot be read (a stale save's 409,
 * a matrix to delete, the usage panels a Durable Object answers in production).
 * Nothing is forwarded: a Worker API call with no answer here is recorded as
 * unmatched and answered 599, and the spec fails on any unmatched call (the guard the plan
 * asks for), so a new Worker route on this page cannot go unscanned.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { mergeHistory, type PartnerHistory } from '@bidspoke/partner-history'

const DIR = path.join(__dirname, 'fixtures', 'partners')
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(DIR, file), 'utf8')) as T

type Row = Record<string, unknown> & { id: string; slug: string; partner_type: string }

export interface PartnerFixtures {
  partners: Row[]
  buyerProfiles: Record<string, { profile: { sold_on?: string | null } | null; accept_signals: unknown[]; other_sellers: unknown[] }>
  uuids: unknown[]
  bidConfigs: Record<string, unknown[]>
  stale: Record<string, unknown> & { partner: { id: string } }
  matrix: { list: Array<{ id: string; partner_id: string }>; detail: unknown }
  panels: { history: unknown; buyer_sales: unknown; held_clicks: unknown; usage_offer: unknown; usage_click: unknown }
  /** GET /api/partners/:id/usage by partner id (#2137), measured read only from production on 2026-10-16. */
  usage: Record<string, unknown>
  /**
   * GET /api/partners/:id/history by partner id (#2141): production's 59 audit
   * rows for the nine partners, read only on 2026-10-16, mapped as the route
   * maps them and redacted as a capture is.
   */
  history: Record<string, PartnerHistory>
  /** Tripoint's History with three synthetic matrix entries on top: production holds no matrix sync rows. */
  historyMatrix: PartnerHistory
}

export function loadPartnerFixtures(): PartnerFixtures {
  return {
    partners: read('partners.json'),
    buyerProfiles: read('buyer-profiles.json'),
    uuids: read('partner-uuids.json'),
    bidConfigs: read('partner-bid-configs.json'),
    stale: read('synthetic/page-save-409.tripoint.json'),
    matrix: read('synthetic/matrix.tripoint.json'),
    panels: read('synthetic/panels.json'),
    usage: read('usage.json'),
    history: read('history.json'),
    historyMatrix: read('synthetic/history-matrix.tripoint.json'),
  }
}

export interface FixtureOptions {
  /** Answer a page save of the 409's partner with the recorded stale_version 409, which opens the merge dialog. */
  staleSave?: boolean
  /** Give the 409's partner the synthetic matrix, so its delete dialog can be opened. */
  matrix?: boolean
  /** Give one partner (by slug) a credential warning, so the warning surfaces are scanned. */
  credentialWarningFor?: string
  /** Answer the usage read (#2137) with a 503, so the Bid Group tab's failed state is reached. */
  usageFails?: boolean
  /** Answer the History read (#2141) with the route's error for a failed users read. */
  historyFails?: boolean
  /** Give Tripoint the synthetic History holding matrix syncs and a matrix created. */
  historyMatrix?: boolean
  /** Answer Tripoint's History as the route does when a source was cut at its bound (mergeHistory with the source truncated). */
  historyIncomplete?: boolean
}

export interface Answer { status: number; body: unknown }

/** The answer to one Worker request, or null when the fixtures hold none. Pure, so it is unit tested. */
export function answerFor(method: string, url: string, fx: PartnerFixtures, opts: FixtureOptions = {}): Answer | null {
  const u = new URL(url)
  const p = u.pathname
  const ok = (body: unknown): Answer => ({ status: 200, body })
  let m: RegExpExecArray | null
  if (method === 'PUT' && (m = /^\/api\/partners\/([^/]+)\/page$/.exec(p))) {
    return opts.staleSave && m[1] === fx.stale.partner.id ? { status: 409, body: fx.stale } : null
  }
  if (method !== 'GET') return null
  if (p === '/api/partners') {
    return ok(fx.partners.map((row) => (opts.credentialWarningFor && row.slug === opts.credentialWarningFor
      ? { ...row, credential_warning: `Credential '${String(row.cf_secret_key ?? 'PARTNER_SECRET')}' is not set, so this partner will fail on the next live lead.` }
      : row)))
  }
  if ((m = /^\/api\/partners\/([^/]+)\/buyer-profile$/.exec(p))) return fx.buyerProfiles[m[1]] ? ok(fx.buyerProfiles[m[1]]) : null
  if (/^\/api\/partners\/[^/]+\/buyer-profile\/history$/.test(p)) return ok(fx.panels.history)
  if ((m = /^\/api\/partners\/([^/]+)\/buyer-usage$/.exec(p))) {
    const soldOn = fx.buyerProfiles[m[1]]?.profile?.sold_on
    return ok(soldOn === 'click' ? fx.panels.usage_click : fx.panels.usage_offer)
  }
  if ((m = /^\/api\/partners\/([^/]+)\/usage$/.exec(p))) {
    if (opts.usageFails) return { status: 503, body: { error: 'Service unavailable' } }
    return fx.usage[m[1]] ? ok(fx.usage[m[1]]) : null
  }
  if ((m = /^\/api\/partners\/([^/]+)\/history$/.exec(p))) {
    if (opts.historyFails) return { status: 500, body: { error: 'history_unavailable', read: 'users', message: 'History could not be loaded: the users read failed.' } }
    const tripointId = fx.historyMatrix.partnerId
    if (opts.historyMatrix && m[1] === tripointId) return ok(fx.historyMatrix)
    const history = fx.history[m[1]]
    if (!history) return null
    if (opts.historyIncomplete && m[1] === tripointId) return ok({ partnerId: m[1], ...mergeHistory([{ entries: history.entries, truncated: true }]) })
    return ok(history)
  }
  if (p === '/api/partner-uuids') return ok(fx.uuids)
  if (p === '/api/partner-bid-configs') {
    const id = u.searchParams.get('partner_id') ?? ''
    if (opts.matrix && id === fx.matrix.list[0].partner_id) return ok(fx.matrix.list)
    return fx.bidConfigs[id] ? ok(fx.bidConfigs[id]) : null
  }
  if ((m = /^\/api\/partner-bid-configs\/([^/]+)$/.exec(p))) return opts.matrix && m[1] === fx.matrix.list[0].id ? ok(fx.matrix.detail) : null
  if (p === '/api/buyer-sales') return ok(fx.panels.buyer_sales)
  if (p === '/api/held-clicks') return ok(fx.panels.held_clicks)
  return null
}

/**
 * A request the fixtures answer: one to the Worker's API. Only `/api/` paths are
 * taken, so if the Worker were ever served from the web app's own origin the
 * page's own documents and scripts would still load.
 */
export function isWorkerApiRequest(url: URL, workerOrigin: string): boolean {
  return url.origin === new URL(workerOrigin).origin && url.pathname.startsWith('/api/')
}

/**
 * Answer every request to the Worker from the fixtures. Returns the requests
 * that had no answer; the caller asserts it is empty.
 */
export async function routePartnerFixtures(page: Page, workerUrl: string, opts: FixtureOptions = {}): Promise<{ unmatched: string[] }> {
  const fx = loadPartnerFixtures()
  const unmatched: string[] = []
  await page.route((url) => isWorkerApiRequest(url, workerUrl), async (route) => {
    const req = route.request()
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const answer = answerFor(req.method(), req.url(), fx, opts)
    if (!answer) {
      unmatched.push(`${req.method()} ${new URL(req.url()).pathname}`)
      return route.fulfill({ status: 599, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: 'no_fixture' }) })
    }
    return route.fulfill({ status: answer.status, headers: cors, contentType: 'application/json', body: JSON.stringify(answer.body) })
  })
  return { unmatched }
}
