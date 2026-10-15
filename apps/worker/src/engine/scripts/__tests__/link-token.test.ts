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
 * Six live workflows build these links in a code node: the Engine Bidding
 * Workflow (build_response_body) and Lead Economy (return_response) on
 * trypennie.com, the three RML bidding flows (build_response, #2092) on
 * reservemyloan.com, and the Forms flow's submit link (sign_submission_link,
 * #2092). The scripts cannot import, so each carries the same helper block, the
 * last tests hold every copy to one text, and each script names the hosts that
 * get the token just above it.
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
const RML_LENDSWIFT = keptScript('rml-lendswift', 'build_response')
const RML_GIGFI = keptScript('rml-gigfi', 'build_response')
const BIDDING_LENDSWIFT = keptScript('bidding-lendswift', 'build_response')
const SIGN_SUBMISSION_LINK = keptScript('forms-engine', 'sign_submission_link')

// The issue's worked example: a made up secret, never the real one. The issue writes
// the id as a04Ui00000ABCDEFGHI, 19 characters, which no Salesforce id has (15 or 18),
// and trypennie never checks a token for an id of another length. Only the first 15
// characters are signed, so its 18 character form below pins the same token.
const SECRET = 'example-secret-for-testing-only'
const RECORD_ID = 'a04Ui00000ABCDEFGH'
const WORKED_EXAMPLE_T = 'bbfRE5LpCpRlM6AY5qvdHVXEzAqsv1ZGRh8Oy0JTb7A'

type Json = Record<string, unknown>
type Offer = { click_url: string; rate?: number }
type Response = { body: { offers: Offer[] }; link_token?: string }

/** The landing pages as the live Engine constants node holds them (mirror, 2026-10-14). */
const LIVE_ENGINE_PAGES = {
  pennieClickUrl: 'https://www.trypennie.com/portal',
  pennieAlternateClickUrl: 'https://trypennie.com/offerhub',
  pennieExpLandingPage: 'https://trypennie.com/offerportal',
  TripointClickUrl: 'https://trypennie.com/portal/tpl',
}

const silentConsole = () => {
  const errors: string[] = []
  const log = () => {}
  return { errors, console: { log, info: log, debug: log, warn: log, error: (...a: unknown[]) => errors.push(a.map(String).join(' ')) } }
}

/** Runs a script with a console the test can read, which runCanvasScript does not offer. */
async function runWithConsole(script: string, run: CanvasRun) {
  const { errors, console } = silentConsole()
  const out = await compileCanvasScript(script)(run.payload, run.steps, run.env ?? {}, run.execution ?? {}, console, {}, run.fetch)
  return { out: out as Response, errors }
}

/**
 * The token for record ids the worked example does not cover, computed here with
 * its own base64url encoding rather than the scripts' btoa and replace chain, and
 * itself pinned to the worked example below.
 */
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
async function independentToken(secret: string, recordId: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(recordId.slice(0, 15))))
  let bits = 0
  let width = 0
  let out = ''
  for (const byte of bytes) {
    bits = (bits << 8) | byte
    width += 8
    while (width >= 6) {
      width -= 6
      out += B64URL[(bits >> width) & 63]
    }
  }
  if (width > 0) out += B64URL[(bits << (6 - width)) & 63]
  return out
}

it('the independent computation gives the worked example, so it can stand in for it on other ids', async () => {
  expect(await independentToken(SECRET, RECORD_ID)).toBe(WORKED_EXAMPLE_T)
  expect(await independentToken(SECRET, 'a04Ui00000ABCDEFGHI')).toBe(WORKED_EXAMPLE_T)
})

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

  it('with no secret sends the link unsigned, logs an error, and says why: the bid is never failed', async () => {
    const { out, errors } = await runWithConsole(BUILD_RESPONSE_BODY, engineRun({ env: {} }))
    expect(out.body.offers[0].click_url).toBe(`https://www.trypennie.com/portal/${RECORD_ID}`)
    expect(out.link_token).toBe('missing_secret')
    expect(errors.join('\n')).toContain('LINK_TOKEN_SECRET')
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

  it('with no secret sends the link unsigned, logs an error, and says why', async () => {
    const { out, errors } = await runWithConsole(RETURN_RESPONSE, leRun({ env: { TRIPOINT_PROXY_SECRET: 'proxy' } }))
    const le = out as unknown as LeResponse
    expect(le.response.body.offers[0].click_url).toBe(`https://www.trypennie.com/portal/${RECORD_ID}`)
    expect(le.link_token).toBe('missing_secret')
    expect(errors.join('\n')).toContain('LINK_TOKEN_SECRET')
  })
})

/**
 * The three RML bidding flows (#2092). Each builds
 * `<constants.pennieClickUrl>/<Applicant id>` and returns it only in the bid
 * response; the Salesforce patch writes the lender's own redirect_url, never this
 * link. The record is the Applicant (prefix a0G). Pipedream's eight RML workflows
 * sign with the same token (Dan, 2026-10-15), so the tokens must match theirs.
 */
const RML_FLOWS = [
  { name: 'RML - Bidding Workflow (LendSwift)', script: RML_LENDSWIFT, ping: 'ping_lendswift', floorKey: 'LendswiftSubAccountMinBids', page: 'https://reservemyloan.com/portal/ls' },
  { name: 'RML - Bidding Workflow (GigFi)', script: RML_GIGFI, ping: 'ping_gigfi', floorKey: 'GigfiSubAccountMinBids', page: 'https://reservemyloan.com/portal/gf' },
  { name: 'Bidding - LendSwift', script: BIDDING_LENDSWIFT, ping: 'ping_lendswift', floorKey: 'LendswiftSubAccountMinBids', page: 'https://reservemyloan.com/portal/ls' },
] as const

/** A made up Applicant id with the a0G prefix, 18 characters. */
const APPLICANT_ID = 'a0GUi00000XYZ12QAB'

for (const flow of RML_FLOWS) {
  describe(`${flow.name}: build_response signs the reservemyloan.com link`, () => {
    type RmlOut = { body: { offers?: Offer[]; status?: string }; link_token?: string; bidAmount?: number; redirectUrl?: unknown }
    const rmlRun = (opts: { env?: Json; ping?: Json; applicantId?: string; page?: string; floor?: number }): CanvasRun => ({
      payload: { leadUuid: 'lead-1', subAccountUuid: 'sub-1' },
      env: opts.env ?? { LINK_TOKEN_SECRET: SECRET },
      execution: { trace_id: 'trace-1' },
      steps: {
        constants: {
          output: {
            offerName: 'Reserve My Loan', productType: 'installment_loan', logoSrc: 'https://cdn.example.test/rml.png',
            offerTitle: 'Get Cash', offerDetails: '<ul><li>x</li></ul>', multiplier: 0.65,
            pennieClickUrl: opts.page ?? flow.page,
            ...(opts.floor !== undefined ? { [flow.floorKey]: { 'sub-1': opts.floor } } : {}),
          },
        },
        [flow.ping]: { output: { data: { data: { status: 'ACCEPTED', bid_amount: 40, min_bid_value: 5, redirect_url: 'https://lender.example.test/apply/xyz', ...(opts.ping ?? {}) } } } },
        create_applicant: { output: { body: { id: opts.applicantId ?? APPLICANT_ID } } },
      },
    })
    const run = async (opts: Parameters<typeof rmlRun>[0]) => (await runCanvasScript(flow.script, rmlRun(opts))) as RmlOut

    it('pins the worked example: the issue record id gives the issue token', async () => {
      const out = await run({ applicantId: RECORD_ID })
      expect(out.body.offers?.[0].click_url).toBe(`${flow.page}/${RECORD_ID}?t=${WORKED_EXAMPLE_T}`)
    })

    it('signs the Applicant link with the token for that Applicant id, and says it signed', async () => {
      const out = await run({})
      expect(out.body.offers?.[0].click_url).toBe(`${flow.page}/${APPLICANT_ID}?t=${await independentToken(SECRET, APPLICANT_ID)}`)
      expect(out.link_token).toBe('signed')
    })

    it('gives the 15 character Applicant id the same token as its 18 character form', async () => {
      const short = APPLICANT_ID.slice(0, 15)
      const out = await run({ applicantId: short })
      expect(out.body.offers?.[0].click_url).toBe(`${flow.page}/${short}?t=${await independentToken(SECRET, APPLICANT_ID)}`)
    })

    it('leaves the bid itself and the lender redirect written to Salesforce exactly as before', async () => {
      const out = await run({})
      expect(out.bidAmount).toBe(40 * 0.65)
      expect(out.body.offers?.[0]).toMatchObject({ rate: 40 * 0.65, name: 'Reserve My Loan' })
      expect(out.redirectUrl).toBe('https://lender.example.test/apply/xyz')
    })

    it('with no secret sends the link unsigned and logs an error, and the bid still goes out', async () => {
      const { out, errors } = await runWithConsole(flow.script, rmlRun({ env: {} }))
      const rml = out as unknown as RmlOut
      expect(rml.body.offers?.[0].click_url).toBe(`${flow.page}/${APPLICANT_ID}`)
      expect(rml.body.offers?.[0].rate).toBe(40 * 0.65)
      expect(rml.link_token).toBe('missing_secret')
      expect(errors.join('\n')).toContain('LINK_TOKEN_SECRET')
    })

    it('never sends the token to a host outside its list', async () => {
      for (const page of ['https://lender.example.test/p', 'https://notreservemyloan.com/portal/ls', 'https://reservemyloan.com.evil.test/portal/ls']) {
        const out = await run({ page })
        expect(out.body.offers?.[0].click_url, page).toBe(`${page}/${APPLICANT_ID}`)
        expect(out.link_token, page).toBe('not_our_host')
      }
    })

    it('a rejected or below threshold lead carries no link and no link_token', async () => {
      for (const out of [await run({ ping: { status: 'REJECTED', bid_amount: 0 } }), await run({ floor: 100 })]) {
        expect(out.body.status).toBe('rejected')
        expect(out.body.offers).toBeUndefined()
        expect(out).not.toHaveProperty('link_token')
      }
    })
  })
}

describe('Forms <> Engine <> Data Store: sign_submission_link signs the submit link', () => {
  type SignOut = { url: string; link_token: string }
  const formsRun = (opts: { env?: Json; submission?: unknown }): CanvasRun => ({
    payload: { Submission__c: opts.submission === undefined ? RECORD_ID : opts.submission },
    env: opts.env ?? { LINK_TOKEN_SECRET: SECRET },
    steps: {},
  })

  it('appends the worked example token to the Submission link, joined with &', async () => {
    const out = (await runCanvasScript(SIGN_SUBMISSION_LINK, formsRun({}))) as SignOut
    expect(out).toEqual({ url: `https://trypennie.com/submit?submission_id=${RECORD_ID}&t=${WORKED_EXAMPLE_T}`, link_token: 'signed' })
  })

  it('with no secret gives the link unsigned and logs an error', async () => {
    const { out, errors } = await runWithConsole(SIGN_SUBMISSION_LINK, formsRun({ env: {} }))
    expect(out).toEqual({ url: `https://trypennie.com/submit?submission_id=${RECORD_ID}`, link_token: 'missing_secret' })
    expect(errors.join('\n')).toContain('LINK_TOKEN_SECRET')
  })

  it('with no Submission id gives the link with an empty id, as the webhook template did, unsigned, and says why', async () => {
    for (const submission of [null, '']) {
      const out = (await runCanvasScript(SIGN_SUBMISSION_LINK, formsRun({ submission }))) as SignOut
      expect(out, String(submission)).toEqual({ url: 'https://trypennie.com/submit?submission_id=', link_token: 'no_record_id' })
    }
    const missing = (await runCanvasScript(SIGN_SUBMISSION_LINK, { payload: {}, env: { LINK_TOKEN_SECRET: SECRET }, steps: {} })) as SignOut
    expect(missing).toEqual({ url: 'https://trypennie.com/submit?submission_id=', link_token: 'no_record_id' })
  })
})

describe('one helper, six scripts', () => {
  const TRYPENNIE = ['trypennie.com', 'www.trypennie.com']
  const RESERVEMYLOAN = [...TRYPENNIE, 'reservemyloan.com']
  const SIGNERS = [
    { name: 'Engine build_response_body', script: BUILD_RESPONSE_BODY, hosts: TRYPENNIE },
    { name: 'Lead Economy return_response', script: RETURN_RESPONSE, hosts: TRYPENNIE },
    { name: 'RML LendSwift build_response', script: RML_LENDSWIFT, hosts: RESERVEMYLOAN },
    { name: 'RML GigFi build_response', script: RML_GIGFI, hosts: RESERVEMYLOAN },
    { name: 'Bidding - LendSwift build_response', script: BIDDING_LENDSWIFT, hosts: RESERVEMYLOAN },
    { name: 'Forms sign_submission_link', script: SIGN_SUBMISSION_LINK, hosts: TRYPENNIE },
  ]

  const block = (name: string, script: string): string => {
    const start = script.indexOf('// BEGIN link token (#2089)')
    const end = script.indexOf('// END link token (#2089)')
    expect(start, `${name}: BEGIN marker`).toBeGreaterThanOrEqual(0)
    expect(end, `${name}: END marker`).toBeGreaterThan(start)
    expect(script.indexOf('// BEGIN link token (#2089)', start + 1), `${name}: one block only`).toBe(-1)
    return script.slice(start, end)
  }

  it('every script carries the identical helper block, so a fix to one cannot leave another behind', () => {
    const [first, ...rest] = SIGNERS
    for (const s of rest) expect(block(s.name, s.script), s.name).toBe(block(first.name, first.script))
  })

  it('the block names no host: each script sets its own list just above it', () => {
    expect(block(SIGNERS[0].name, SIGNERS[0].script)).not.toMatch(/const LINK_TOKEN_HOSTS/)
  })

  it('each script gives the token to its own sites only: trypennie.com everywhere, reservemyloan.com in the RML flows alone', () => {
    for (const s of SIGNERS) {
      const declared = [...s.script.matchAll(/^const LINK_TOKEN_HOSTS = (\[[^\]]*\]);$/gm)]
      expect(declared, s.name).toHaveLength(1)
      expect(JSON.parse(declared[0][1].replace(/'/g, '"')), s.name).toEqual(s.hosts)
      expect(declared[0].index, `${s.name}: the list sits before the block`).toBeLessThan(s.script.indexOf('// BEGIN link token (#2089)'))
    }
  })
})
