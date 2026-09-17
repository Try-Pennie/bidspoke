/**
 * detectBlockPage (#1265): a partner's firewall answering with a block page instead of data.
 *
 * Achieve's Cloudflare firewall refused every call from the worker for five days with a 403
 * HTML page, and nothing recognised it; the first surface to say anything was the daily field
 * presence check, four days in, naming a symptom. The detector's job is narrow on purpose.
 * Every response that passes through Cloudflare carries a `cf-ray` header and Cloudflare's
 * own origin-error pages (502, 504, 520 to 526) carry a Ray ID too, so a Ray ID is NOT
 * evidence of a block: only the markers a block or challenge page carries are. A 403 HTML
 * page with none of those markers is reported as exactly that, an HTML page where data was
 * expected, with no firewall wording, because the check did not measure a firewall.
 *
 * The detector changes no classification: `classifyHttpErrorWithBody` answers the same for
 * every fixture here whether or not a block is recognised (asserted at the bottom).
 */
import { describe, it, expect } from 'vitest'
import { detectBlockPage } from '../html-error-summary'
import { classifyHttpErrorWithBody } from '../../engine/error-classifier'
import { ACHIEVE_CLOUDFLARE_BLOCK_PAGE, ACHIEVE_CLOUDFLARE_BLOCK_PAGE_RAY_ID } from './fixtures/achieve-cloudflare-block-page'
import { SALESFORCE_EDGE_ERROR_PAGE } from './fixtures/salesforce-edge-error-page'

const headers = (h: Record<string, string>) => new Headers(h)

/** Cloudflare's origin error page shape: a Ray ID and the word cloudflare, but the ORIGIN failed. */
const CLOUDFLARE_502_PAGE =
  '<!DOCTYPE html><html><head><title>api.example.com | 502: Bad gateway</title></head><body>' +
  '<h1><span class="cf-error-type">Error</span><span class="cf-error-code">502</span></h1>' +
  '<h2>Bad gateway</h2><p>The web server reported a bad gateway error.</p>' +
  '<div class="cf-footer">Cloudflare Ray ID: <strong>a3a0c1d2e3f40001</strong></div></body></html>'

/** A 403 HTML page from an origin behind Cloudflare: nginx forbade it, Cloudflare only proxied. */
const NGINX_403_PAGE = '<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center><hr><center>nginx</center></body></html>'

/** A Cloudflare managed challenge interstitial (status 503 with cf-mitigated). */
const CHALLENGE_PAGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget">Checking your browser before accessing api.example.com.</div></body></html>'

describe('detectBlockPage: the real Achieve page', () => {
  it('recognises the archived Cloudflare block page as a cloudflare block with the body Ray ID', () => {
    const got = detectBlockPage(403, ACHIEVE_CLOUDFLARE_BLOCK_PAGE, headers({ 'cf-ray': 'a369312f2f2faa85-EWR', 'content-type': 'text/html' }))
    expect(got).not.toBeNull()
    expect(got?.vendor).toBe('cloudflare')
    expect(got?.status).toBe(403)
    expect(got?.bodyRayId).toBe(ACHIEVE_CLOUDFLARE_BLOCK_PAGE_RAY_ID)
    expect(got?.edgeRayId).toBe('a369312f2f2faa85-EWR')
    expect(got?.markers).toContain('Sorry, you have been blocked')
  })

  it('still recognises it with no headers at all, reading the Ray ID from the body', () => {
    const got = detectBlockPage(403, ACHIEVE_CLOUDFLARE_BLOCK_PAGE)
    expect(got?.vendor).toBe('cloudflare')
    expect(got?.bodyRayId).toBe(ACHIEVE_CLOUDFLARE_BLOCK_PAGE_RAY_ID)
    expect(got?.edgeRayId).toBeNull()
  })

  it('reads the Ray ID from the body, never from a stray hex run elsewhere in the page', () => {
    const got = detectBlockPage(403, ACHIEVE_CLOUDFLARE_BLOCK_PAGE)
    expect(got?.bodyRayId).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('detectBlockPage: other block and challenge shapes', () => {
  it('recognises a challenge response by the cf-mitigated header', () => {
    const got = detectBlockPage(503, CHALLENGE_PAGE, headers({ 'cf-mitigated': 'challenge', 'cf-ray': 'a3a0c1d2e3f40002-IAD' }))
    expect(got?.vendor).toBe('cloudflare')
    expect(got?.markers).toContain('cf-mitigated: challenge')
  })

  it('recognises a challenge page by its body markers when the header is absent', () => {
    const got = detectBlockPage(503, CHALLENGE_PAGE)
    expect(got?.vendor).toBe('cloudflare')
  })

  it('recognises the newer 1020 access denied page by its error code', () => {
    const page = '<!DOCTYPE html><html><head><title>Access denied | api.example.com used Cloudflare to restrict access</title></head><body><h1>Access denied</h1><p>error code: 1020</p><p>Cloudflare Ray ID: <strong>a3a0c1d2e3f40003</strong></p></body></html>'
    const got = detectBlockPage(403, page)
    expect(got?.vendor).toBe('cloudflare')
    expect(got?.bodyRayId).toBe('a3a0c1d2e3f40003')
  })

  it('reports a 403 HTML page from an unknown vendor as unknown, even behind a cf-ray header', () => {
    const got = detectBlockPage(403, NGINX_403_PAGE, headers({ 'cf-ray': 'a3a0c1d2e3f40004-CDG' }))
    expect(got).not.toBeNull()
    expect(got?.vendor).toBe('unknown')
    expect(got?.bodyRayId).toBeNull()
    expect(got?.edgeRayId).toBe('a3a0c1d2e3f40004-CDG')
  })
})

describe('detectBlockPage: what is NOT a block', () => {
  it('a Cloudflare origin error page with a Ray ID: the partner is down, not blocking us', () => {
    expect(detectBlockPage(502, CLOUDFLARE_502_PAGE, headers({ 'cf-ray': 'a3a0c1d2e3f40001-EWR' }))).toBeNull()
    expect(detectBlockPage(524, CLOUDFLARE_502_PAGE.replace('502', '524'))).toBeNull()
  })

  it('a 503 HTML page with a Ray ID and no challenge marker', () => {
    expect(detectBlockPage(503, CLOUDFLARE_502_PAGE.replace('502', '503'))).toBeNull()
  })

  it('the real Salesforce Edge HTML 400', () => {
    expect(detectBlockPage(400, SALESFORCE_EDGE_ERROR_PAGE)).toBeNull()
  })

  it('a JSON 403', () => {
    expect(detectBlockPage(403, JSON.stringify({ error: 'forbidden' }), headers({ 'content-type': 'application/json' }))).toBeNull()
  })

  it('an HTML 500, an HTML 200, a plain text 403 and an empty body', () => {
    expect(detectBlockPage(500, NGINX_403_PAGE.replace(/403 Forbidden/g, '500 Internal Server Error'))).toBeNull()
    expect(detectBlockPage(200, ACHIEVE_CLOUDFLARE_BLOCK_PAGE)).toBeNull()
    expect(detectBlockPage(403, 'Forbidden')).toBeNull()
    expect(detectBlockPage(403, '')).toBeNull()
    expect(detectBlockPage(403, null)).toBeNull()
    expect(detectBlockPage(403, undefined)).toBeNull()
  })
})

describe('detectBlockPage changes no classification', () => {
  it('classifyHttpErrorWithBody answers the same for every fixture, block or not', () => {
    // An HTML body is transient at any status by the existing rule; the detector adds
    // recognition on top and must never move this.
    expect(classifyHttpErrorWithBody(403, ACHIEVE_CLOUDFLARE_BLOCK_PAGE)).toBe('transient')
    expect(classifyHttpErrorWithBody(403, NGINX_403_PAGE)).toBe('transient')
    expect(classifyHttpErrorWithBody(503, CHALLENGE_PAGE)).toBe('transient')
    expect(classifyHttpErrorWithBody(502, CLOUDFLARE_502_PAGE)).toBe('transient')
    expect(classifyHttpErrorWithBody(403, JSON.stringify({ error: 'forbidden' }))).toBe('permanent')
  })
})
