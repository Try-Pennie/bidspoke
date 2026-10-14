/**
 * The signed link token on the customer links the bidding workflows build (#2089).
 *
 * trypennie.com refuses a link to a Salesforce record created after its cutoff
 * unless the link carries `?t=<token>`: HMAC-SHA256 of the first 15 characters of
 * the record id, keyed with LINK_TOKEN_SECRET, base64url with no padding
 * (trypennie PR #534, src/lib/recordAccess/linkToken.ts). Salesforce's LinkToken
 * class and the Pipedream helper sign the same way, so the token is pinned here to
 * the issue's worked example rather than to a second implementation of our own.
 *
 * Two live workflows build these links in a code node: the Engine Bidding
 * Workflow (build_response_body) and Lead Economy (return_response). The scripts
 * cannot import, so each carries the same helper block, and the last test holds
 * the two copies to one text.
 */
import { describe, expect, it } from 'vitest'
import fixtures from './fixtures/engine-lead.json'
import { KEPT_CANVAS_WORKFLOWS } from '../../../lib/engine-script-drift'
import { answerWith, compileCanvasScript, runCanvasScript, type CanvasRun } from './canvas-script'

const keptScript = (folder: string, namespace: string): string => {
  const kept = KEPT_CANVAS_WORKFLOWS.find((w) => w.folder === folder)?.scripts.find((k) => k.namespace === namespace)
  if (!kept) throw new Error(`no kept script ${folder}/${namespace}`)
  return kept.script
}
const BUILD_RESPONSE_BODY = keptScript('engine-bidding', 'build_response_body')
const RETURN_RESPONSE = keptScript('lead-economy', 'return_response')

// The issue's worked example: a made up secret, never the real one. The issue writes
// the id as a04Ui00000ABCDEFGHI, 19 characters, which no Salesforce id has (15 or 18),
// and trypennie never checks a token for an id of another length. Only the first 15
// characters are signed, so its 18 character form below pins the same token.
const SECRET = 'example-secret-for-testing-only'
const RECORD_ID = 'a04Ui00000ABCDEFGH'
const WORKED_EXAMPLE_T = 'bbfRE5LpCpRlM6AY5qvdHVXEzAqsv1ZGRh8Oy0JTb7A'

type Json = Record<string, unknown>
type Offer = { click_url: string }
type Response = { body: { offers: Offer[] }; link_token?: string }

/** The landing pages as the live Engine constants node holds them (mirror, 2026-10-14). */
const LIVE_ENGINE_PAGES = {
  pennieClickUrl: 'https://www.trypennie.com/portal',
  pennieAlternateClickUrl: 'https://trypennie.com/offerhub',
  pennieExpLandingPage: 'https://trypennie.com/offerportal',
  TripointClickUrl: 'https://trypennie.com/portal/tpl',
}

const silentConsole = () => {
  const warnings: string[] = []
  const log = () => {}
  return { warnings, console: { log, info: log, debug: log, error: log, warn: (...a: unknown[]) => warnings.push(a.map(String).join(' ')) } }
}

/** Runs a script with a console the test can read, which runCanvasScript does not offer. */
async function runWithConsole(script: string, run: CanvasRun) {
  const { warnings, console } = silentConsole()
  const out = await compileCanvasScript(script)(run.payload, run.steps, run.env ?? {}, run.execution ?? {}, console, {}, run.fetch)
  return { out: out as Response, warnings }
}

describe('Engine Bidding: build_response_body signs the offer link', () => {
  const engineRun = (opts: { env?: Json; pt?: Json; constants?: Json; prospectId?: string; steps?: CanvasRun['steps'] }): CanvasRun => ({
    payload: fixtures.payload,
    env: opts.env ?? { LINK_TOKEN_SECRET: SECRET },
    execution: fixtures.execution,
    steps: {
      constants: { output: { ...fixtures.constants, ...LIVE_ENGINE_PAGES, ...(opts.constants ?? {}) } },
      prospect_trades: { output: { body: opts.pt ?? fixtures.prospect_trades_not_sell_off } },
      create_prospect: { output: { body: { id: opts.prospectId ?? RECORD_ID } } },
      ...(opts.steps ?? {}),
    },
  })

  it('appends the issue example token to the Pennie portal link, and says it signed', async () => {
    const out = (await runCanvasScript(BUILD_RESPONSE_BODY, engineRun({}))) as Response
    expect(out.body.offers[0].click_url).toBe(`https://www.trypennie.com/portal/${RECORD_ID}?t=${WORKED_EXAMPLE_T}`)
    expect(out.link_token).toBe('signed')
  })

  it('gives the 15 character id the same token as its 18 character form', async () => {
    const short = RECORD_ID.slice(0, 15)
    const out = (await runCanvasScript(BUILD_RESPONSE_BODY, engineRun({ prospectId: short }))) as Response
    expect(out.body.offers[0].click_url).toBe(`https://www.trypennie.com/portal/${short}?t=${WORKED_EXAMPLE_T}`)
  })

  it('signs the alternate and experiment landing pages too', async () => {
    const alt = (await runCanvasScript(BUILD_RESPONSE_BODY, engineRun({ pt: { ...fixtures.prospect_trades_not_sell_off, altLandingPage: true } }))) as Response
    expect(alt.body.offers[0].click_url).toBe(`https://trypennie.com/offerhub/${RECORD_ID}?t=${WORKED_EXAMPLE_T}`)
    const exp = (await runCanvasScript(BUILD_RESPONSE_BODY, engineRun({ pt: { ...fixtures.prospect_trades_not_sell_off, expLandingPage: true } }))) as Response
    expect(exp.body.offers[0].click_url).toBe(`https://trypennie.com/offerportal/${RECORD_ID}?t=${WORKED_EXAMPLE_T}`)
  })

  it('signs a sold Tripoint lead landing on trypennie.com/portal/tpl', async () => {
    const sold = { output: { sale: { skipped: false, accepted: true, buyer_reference: 'x', result_code: '1001', partner_slug: 'tripoint', partner_name: 'Tripoint', click_url: LIVE_ENGINE_PAGES.TripointClickUrl, routing_code: 2, response_class: 'Success' } } }
    const out = (await runCanvasScript(BUILD_RESPONSE_BODY, engineRun({ pt: fixtures.prospect_trades_sell_off, steps: { tripoint_ping: sold } }))) as Response
    expect(out.body.offers[0].click_url).toBe(`https://trypennie.com/portal/tpl/${RECORD_ID}?t=${WORKED_EXAMPLE_T}`)
  })

  const clickSteps = (clickUrl: string): CanvasRun['steps'] => ({
    tripoint_ping: { output: { sale: { skipped: false, accepted: false, buyer_reference: null, result_code: '1003', partner_slug: 'tripoint', partner_name: 'Tripoint', click_url: null, routing_code: null, response_class: 'Duplicate' } } },
    known_no_gate: { output: { known_no: true } },
    buyer_click_check: { output: { _route: 'eligible', partner_slug: 'liberty1', partner_name: 'Liberty1', click_url: clickUrl, external_routing_code: 7 } },
  })

  it('signs a click buyer whose landing page is our own site (Liberty1)', async () => {
    const run = engineRun({ pt: fixtures.prospect_trades_sell_off, steps: clickSteps('https://trypennie.com/portal/liberty/{prospect_id}') })
    const out = (await runCanvasScript(BUILD_RESPONSE_BODY, run)) as Response
    expect(out.body.offers[0].click_url).toBe(`https://trypennie.com/portal/liberty/${RECORD_ID}?t=${WORKED_EXAMPLE_T}`)
  })

  it('joins with & when the link already carries a query', async () => {
    const run = engineRun({ pt: fixtures.prospect_trades_sell_off, steps: clickSteps('https://trypennie.com/portal/liberty/{prospect_id}?src=engine') })
    const out = (await runCanvasScript(BUILD_RESPONSE_BODY, run)) as Response
    expect(out.body.offers[0].click_url).toBe(`https://trypennie.com/portal/liberty/${RECORD_ID}?src=engine&t=${WORKED_EXAMPLE_T}`)
  })

  it('never sends the token to a partner domain, including one that merely ends in trypennie.com', async () => {
    for (const url of ['https://buyer.example.test/apply/{prospect_id}', 'https://nottrypennie.com/p/{prospect_id}', 'https://trypennie.com.evil.test/p/{prospect_id}']) {
      const out = (await runCanvasScript(BUILD_RESPONSE_BODY, engineRun({ pt: fixtures.prospect_trades_sell_off, steps: clickSteps(url) }))) as Response
      expect(out.body.offers[0].click_url, url).toBe(url.replace('{prospect_id}', RECORD_ID))
      expect(out.link_token, url).toBe('not_our_host')
    }
  })

  it('with no secret sends the link unsigned, warns, and says why: the bid is never failed', async () => {
    const { out, warnings } = await runWithConsole(BUILD_RESPONSE_BODY, engineRun({ env: {} }))
    expect(out.body.offers[0].click_url).toBe(`https://www.trypennie.com/portal/${RECORD_ID}`)
    expect(out.link_token).toBe('missing_secret')
    expect(warnings.join('\n')).toContain('LINK_TOKEN_SECRET')
  })

  it('leaves a link whose record id is not a Salesforce id unsigned, and says so', async () => {
    const out = (await runCanvasScript(BUILD_RESPONSE_BODY, engineRun({ prospectId: 'a0XSF0000001ABCD' }))) as Response
    expect(out.body.offers[0].click_url).toBe('https://www.trypennie.com/portal/a0XSF0000001ABCD')
    expect(out.link_token).toBe('no_record_id')
  })

  it('a rejected lead carries no link and no link_token', async () => {
    const out = (await runCanvasScript(BUILD_RESPONSE_BODY, engineRun({ pt: fixtures.prospect_trades_zero_bid }))) as Json
    expect(out.isRejected).toBe(true)
    expect(out).not.toHaveProperty('link_token')
  })
})

describe('Lead Economy: return_response signs the offer link', () => {
  /** The live Lead Economy constants node's landing pages (mirror, 2026-10-14). */
  const LEAD_ECONOMY_CONSTANTS = {
    offerName: 'Pennie', productType: 'installment_loan', logoSrc: 'https://cdn.example-pennie.test/logo.png',
    mainOfferTitle: 'Income-Focused Lending', mainOfferDetails: '<ul><li>x</li></ul>',
    sellOffOfferTitle: 'Denied a personal loan?', sellOffOfferDetails: '<ul><li>y</li></ul>',
    pennieClickUrl: 'https://www.trypennie.com/portal',
    pennieAlternateClickUrl: 'https://trypennie.com/offerhub',
    pennieExpLandingPage: 'https://trypennie.com/offerportal',
    tripointClickUrl: 'https://trypennie.com/portal/tpl',
  }
  const pt = (over: Json = {}): Json => ({ engineBid: 42, sellOff: false, expLandingPage: false, altLandingPage: false, testOfferLanguage: false, maxLoanPmt: 300, maxLoanAmt: 10000, tradeCalculations: { engineDebt: 20000, enrollableDebt: 22000 }, ...over })
  const leRun = (opts: { env?: Json; pt?: Json; fetch?: CanvasRun['fetch'] }): CanvasRun => ({
    payload: { leadId1: 'lead-1', personalInformation: { firstName: 'jordan' }, financialInformation: { annualIncome: 85000 } },
    env: opts.env ?? { LINK_TOKEN_SECRET: SECRET, TRIPOINT_PROXY_SECRET: 'proxy' },
    execution: { trace_id: 'trace-1' },
    steps: {
      constants: { output: LEAD_ECONOMY_CONSTANTS },
      prospect_trades: { output: { body: opts.pt ?? pt() } },
      create_prospect: { output: { body: { id: RECORD_ID } } },
    },
    fetch: opts.fetch,
  })
  type LeResponse = { response: { body: { offers: Offer[] } }; link_token?: string }

  it('appends the issue example token to the Pennie portal link', async () => {
    const out = (await runCanvasScript(RETURN_RESPONSE, leRun({}))) as LeResponse
    expect(out.response.body.offers[0].click_url).toBe(`https://www.trypennie.com/portal/${RECORD_ID}?t=${WORKED_EXAMPLE_T}`)
    expect(out.link_token).toBe('signed')
  })

  it('signs a sell off lead Tripoint took, landing on /portal/tpl', async () => {
    const out = (await runCanvasScript(RETURN_RESPONSE, leRun({ pt: pt({ sellOff: true }), fetch: answerWith(200, { ok: true, data: { createLead: { resultCode: 1001, id: 'tp-1' } } }) }))) as LeResponse
    expect(out.response.body.offers[0].click_url).toBe(`https://trypennie.com/portal/tpl/${RECORD_ID}?t=${WORKED_EXAMPLE_T}`)
  })

  it('with no secret sends the link unsigned, warns, and says why', async () => {
    const { out, warnings } = await runWithConsole(RETURN_RESPONSE, leRun({ env: { TRIPOINT_PROXY_SECRET: 'proxy' } }))
    const le = out as unknown as LeResponse
    expect(le.response.body.offers[0].click_url).toBe(`https://www.trypennie.com/portal/${RECORD_ID}`)
    expect(le.link_token).toBe('missing_secret')
    expect(warnings.join('\n')).toContain('LINK_TOKEN_SECRET')
  })
})

describe('one helper, two scripts', () => {
  const block = (script: string): string => {
    const start = script.indexOf('// BEGIN link token (#2089)')
    const end = script.indexOf('// END link token (#2089)')
    expect(start, 'BEGIN marker').toBeGreaterThanOrEqual(0)
    expect(end, 'END marker').toBeGreaterThan(start)
    return script.slice(start, end)
  }

  it('Engine and Lead Economy carry the identical helper block, so a fix to one cannot leave the other behind', () => {
    expect(block(RETURN_RESPONSE)).toBe(block(BUILD_RESPONSE_BODY))
  })
})
