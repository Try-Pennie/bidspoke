/**
 * Deterministic answers for every outbound request the money gate's fixtures make (#1704).
 *
 * Network is off in the gate. Each request the engine or a code node sends is
 * answered here by a rule chosen on the request's host and path, in a scenario
 * the fixture's variant picks ("accepted", "declined", ...). The same rules answer
 * the merge base and the head, so a response is never the source of a difference;
 * the gate does not claim these bodies are what partners really send, only that
 * both sides heard the same thing. The bodies carry the fields the live scripts
 * read, as of the definitions committed beside them.
 *
 * A request no rule matches is answered 599 and named in the coverage report, so a
 * fixture that wandered somewhere unexpected is visible rather than quietly green.
 */

export interface StubRequest {
  method: string
  url: URL
  headers: Record<string, string>
  body: unknown
}

export interface StubAnswer {
  status: number
  headers?: Record<string, string>
  body: unknown
}

/** Rule name to scenario name, from the fixture variant. A rule a variant does not name uses its default. */
export type Arms = Record<string, string>

export interface Rule {
  name: string
  match: (r: StubRequest) => boolean
  scenarios: Record<string, (r: StubRequest) => StubAnswer>
  default: string
}

const json = (body: unknown, status = 200): StubAnswer => ({ status, headers: { 'content-type': 'application/json' }, body })
const path = (r: StubRequest) => r.url.pathname
const host = (r: StubRequest) => r.url.host

/** A Salesforce record id, stable for an object name, 18 characters like the real ones. */
function sfId(object: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < object.length; i++) { h ^= object.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return `a0G${h.toString(36).padStart(7, '0').slice(0, 7)}GATE0001`.slice(0, 18)
}

const SF_OBJECT = /^\/services\/data\/v[\d.]+\/sobjects\/([^/]+)(?:\/([^/]+))?$/

const prospectTrades = (over: Record<string, unknown>) => (): StubAnswer => json({
  engineBid: 45,
  baseBid: 40,
  sellOff: false,
  altLandingPage: false,
  expLandingPage: false,
  testOfferLanguage: false,
  maxLoanPmt: 500,
  maxLoanAmt: 20000,
  discountApplied: false,
  tradeCalculations: { engineDebt: 25000, enrollableDebt: 24000 },
  ...over,
})

const equifaxReport = (report: Record<string, unknown>, status = 'completed') => (): StubAnswer => json({
  status,
  consumers: { equifaxUSConsumerCreditReport: [report] },
})

const ONE_TRADE = {
  trades: [{ accountType: 'R', balance: 12000, creditLimit: 15000, scheduledPaymentAmount: 300, narrativeCodes: null }],
  models: [{ modelNumber: '05402', score: 700 }],
  fraudIDScanAlertCodes: [],
}

/** The id a SOQL query asks for, echoed back so the record answers the query. */
function soqlId(r: StubRequest): string {
  const q = r.url.searchParams.get('q') ?? ''
  return /Id\s*=\s*'([A-Za-z0-9]{15,18})'/.exec(q)?.[1] ?? 'a0GUNKNOWNGATE0001'
}

const records = (_r: StubRequest, rec: Record<string, unknown>): StubAnswer => json({ totalSize: 1, done: true, records: [rec] })

/** A synthetic prospect: every person field is from a range no real person occupies. */
function prospectRecord(r: StubRequest, routingCode: string, status: string, id = soqlId(r)): Record<string, unknown> {
  return {
    attributes: { type: 'Prospect__c' },
    Id: id, SubaccountName__c: 'Gate Sub Account', SubaccountUUID__c: '00000000-0000-4000-8000-00000000c0de',
    First_Name__c: 'Synthia', Last_Name__c: 'Gatekeeper', Email__c: 'synthia.gatekeeper@example.com', Phone__c: '(555) 010-0199',
    Street__c: '1 Example Way', AptSuite__c: '', City__c: 'Testville', State__c: 'FL', Zip__c: '99999', BirthDate__c: '1980-01-01',
    SocialSecurityNumber__c: '912345678', LoanPurpose__c: 'debt_consolidation', LoanAmount__c: 10000, RentOrOwn__c: 'Rent',
    ApproximateCreditRating__c: 'Good (660-719)', EmploymentStatus__c: 'employed_full_time', IncomePmtFrequency__c: 'Monthly',
    AnnualIncomeBeforeTaxes__c: 85000, EducationLevel__c: 'Bachelors', FCRAConsentFlag__c: true, TCPAConsentFlag__c: true,
    User_IP__c: '192.0.2.1', ExternalRoutingCode__c: routingCode, ExternalExchangeStatus__c: status,
  }
}

function submissionRecord(r: StubRequest, routingCode: string | null, status: string): Record<string, unknown> {
  return {
    attributes: { type: 'Submission__c' },
    Id: soqlId(r), Prospect__c: null, Lead__c: '00QGATE00000000001', Source__c: 'Gate', FundedDemandSubAccountName__c: 'Gate Sub Account',
    SubaccountUUID__c: '00000000-0000-4000-8000-00000000c0de', FirstNameSO__c: 'Synthia', LastNameSO__c: 'Gatekeeper',
    Email_SO__c: 'synthia.gatekeeper@example.com', Home_Phone__c: '5550100199', StreetSO__c: '1 Example Way', City_SO__c: 'Testville',
    State_SO__c: 'FL', Zip_Code_SO__c: '99999', Date_of_Birth_SO__c: '1980-01-01', Social_Security_Number_SO__c: '912345678',
    Loan_Purpose_SO__c: 'debt_consolidation', Loan_Amount_SO__c: 10000, Rent_or_Own_SO__c: 'Rent', Approximate_Credit_Rating_SO__c: 'Good (660-719)',
    Employment_Status_SO__c: 'employed_full_time', Income_Pmt_Frequency_SO__c: 'Monthly', Annual_Income_Before_Taxes_SO__c: 85000,
    Education_Level_SO__c: 'Bachelors', ConsentFCRA__c: true, Consent__c: true, User_IP__c: '192.0.2.1',
    Lead__r: { FirstName: 'Synthia', LastName: 'Gatekeeper', Email: 'synthia.gatekeeper@example.com', Phone: '5550100199', MobilePhone: null },
    External_Routing_Code__c: routingCode, External_Exchange_Status__c: status,
  }
}

const creditTrades = (calc: Record<string, unknown>) => (): StubAnswer => json({ pennieLeadCalculations: [calc] })

const engineData = (loanOffers: unknown[]) => ({ uuid: 'engine-gate-uuid-0001', leadUuid: 'engine-gate-lead-0001', loanOffers, specialOffers: [] })

const tripoint = (createLead: Record<string, unknown> | null, ok = true, status = 200) => (): StubAnswer => json({ ok, data: { createLead } }, status)

export const RULES: Rule[] = [
  // ── Salesforce (the instance host is a placeholder, so these match on path) ──
  {
    name: 'salesforce_token',
    match: (r) => path(r) === '/services/oauth2/token',
    default: 'ok',
    scenarios: {
      ok: (r) => json({ access_token: 'gate-salesforce-token', instance_url: `https://${host(r)}`, token_type: 'Bearer' }),
      unauthorized: () => json([{ errorCode: 'INVALID_SESSION_ID', message: 'money gate: token refused' }], 401),
    },
  },
  {
    name: 'salesforce_create',
    match: (r) => r.method === 'POST' && SF_OBJECT.test(path(r)) && !SF_OBJECT.exec(path(r))![2],
    default: 'ok',
    scenarios: {
      ok: (r) => json({ id: sfId(SF_OBJECT.exec(path(r))![1]), success: true, errors: [] }, 201),
      duplicate_lead: () => json([{ errorCode: 'DUPLICATE_VALUE', message: 'duplicate value found: LeadUUID__c duplicates value on record with id: a0GDUPLICATE000001', fields: [] }], 400),
      blocked: () => json([{ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Creation is blocked: a lead with this SSN was seen recently', fields: [] }], 400),
    },
  },
  // Main Flow's native Submission PATCHes: set_completed_submission today, and the
  // nine outcome writes once the relay port (#1680, src/lib/main-flow-port) is PUT.
  // Its own rule so a variant can fail them without failing every other update.
  {
    name: 'salesforce_submission_update',
    match: (r) => r.method === 'PATCH' && SF_OBJECT.exec(path(r))?.[1] === 'Submission__c' && !!SF_OBJECT.exec(path(r))![2],
    default: 'ok',
    scenarios: {
      ok: () => ({ status: 204, body: '' }),
      failed: () => json([{ errorCode: 'UNABLE_TO_LOCK_ROW', message: 'money gate: submission update refused' }], 400),
    },
  },
  {
    name: 'salesforce_update',
    match: (r) => (r.method === 'PATCH' || r.method === 'POST') && SF_OBJECT.test(path(r)) && !!SF_OBJECT.exec(path(r))![2],
    default: 'ok',
    scenarios: {
      ok: () => ({ status: 204, body: '' }),
      failed: () => json([{ errorCode: 'UNABLE_TO_LOCK_ROW', message: 'money gate: update refused' }], 400),
    },
  },
  {
    name: 'salesforce_query',
    match: (r) => /^\/services\/data\/v[\d.]+\/query/.test(path(r)),
    default: 'empty',
    scenarios: {
      empty: () => json({ totalSize: 0, done: true, records: [] }),
      liberty1_open: (r) => records(r, prospectRecord(r, '4', 'Bid')),
      liberty1_completed: (r) => records(r, prospectRecord(r, '4', 'Completed')),
      liberty1_other_buyer: (r) => records(r, prospectRecord(r, '2', 'Bid')),
      submission_trusted: (r) => records(r, submissionRecord(r, null, 'Open')),
      submission_sold_elsewhere: (r) => records(r, submissionRecord(r, '2', 'Completed')),
      submission_with_prospect: (r) => records(r, { ...submissionRecord(r, null, 'Open'), Prospect__c: 'a0GPROSPECTGATE001', Prospect__r: prospectRecord(r, '4', 'Bid', 'a0GPROSPECTGATE001') }),
    },
  },
  {
    name: 'salesforce_prospect_trades',
    match: (r) => path(r) === '/services/apexrest/prospect-trades',
    default: 'bid',
    scenarios: {
      bid: prospectTrades({}),
      sell_off: prospectTrades({ sellOff: true }),
      sell_off_debt_10k: prospectTrades({ sellOff: true, tradeCalculations: { engineDebt: 10000, enrollableDebt: 10000 } }),
      no_bid: prospectTrades({ engineBid: 0 }),
      bid_alt_landing: prospectTrades({ altLandingPage: true, testOfferLanguage: true }),
    },
  },
  {
    name: 'salesforce_bid_settings',
    match: (r) => path(r) === '/services/apexrest/custommdt/bid',
    default: 'active',
    scenarios: {
      active: () => json({ IsActive: true }),
      inactive: () => json({ IsActive: false }),
    },
  },

  {
    name: 'salesforce_credit_trades',
    match: (r) => path(r) === '/services/apexrest/credit-trades',
    default: 'debt_25k',
    scenarios: {
      debt_25k: creditTrades({ EngineDebt__c: 25000, BESOverwrite__c: null, EnrolledPennieDebt__c: 24000 }),
      debt_5k: creditTrades({ EngineDebt__c: 5000, BESOverwrite__c: null, EnrolledPennieDebt__c: 5000 }),
      debt_zero: creditTrades({ EngineDebt__c: 0, BESOverwrite__c: null, EnrolledPennieDebt__c: 0 }),
      debt_zero_salesforce_high: creditTrades({ EngineDebt__c: 0, BESOverwrite__c: null, EnrolledPennieDebt__c: 15000 }),
      bes_overwrite: creditTrades({ EngineDebt__c: 25000, BESOverwrite__c: 7, EnrolledPennieDebt__c: 24000 }),
      no_calculation: () => json({ pennieLeadCalculations: [] }),
    },
  },
  // The credit-inquiries Apex REST call that follows each Main Flow outcome write
  // once the inquiry post moves after the answer (#1680 phase 7). The success body
  // is the one the endpoint answered live on 2026-10-15 (the write contract,
  // question 1); `InquiryParserRest` answers any exception with a 500.
  {
    name: 'salesforce_credit_inquiries',
    match: (r) => r.method === 'POST' && path(r) === '/services/apexrest/credit-inquiries',
    default: 'ok',
    scenarios: {
      ok: () => json({ message: 'Inquiries inserted successfully', statusCode: 200, leadId: '00QGATE00000000001' }),
      failed: () => json({ message: 'money gate: UNABLE_TO_LOCK_ROW, unable to obtain exclusive access to this record', statusCode: 500 }, 500),
    },
  },
  {
    name: 'salesforce_apex_other',
    match: (r) => path(r).startsWith('/services/apexrest/'),
    default: 'ok',
    scenarios: { ok: () => json({}) },
  },

  // ── Eligibility Scout (Main Flow, when there is no Engine Debt) ──
  {
    name: 'eligibility_scout_token',
    match: (r) => host(r) === 'eligibility-scout-token-url.placeholder.invalid',
    default: 'ok',
    scenarios: { ok: () => json({ access_token: 'gate-scout-token', token_type: 'Bearer' }), refused: () => json({ message: 'money gate: refused' }, 401) },
  },
  {
    name: 'eligibility_scout',
    match: (r) => host(r) === 'fdrapis-gateway.prd.fdrgcp.com' && path(r) === '/v2/application/eligibility',
    default: 'estimate_30k',
    scenarios: {
      estimate_30k: () => json({ application: { estimated_total_debt: 30000, estimated_monthly_creditor_payment: 600 } }),
      estimate_60k: () => json({ application: { estimated_total_debt: 60000, estimated_monthly_creditor_payment: 1200 } }),
      no_estimate: () => json({ application: { estimated_total_debt: null } }),
      refused: () => json({ message: 'money gate: not eligible' }, 422),
    },
  },

  // ── Pipedream (Main Flow posts its Salesforce writes there) ──
  {
    name: 'pipedream',
    match: (r) => host(r).endsWith('.m.pipedream.net'),
    default: 'ok',
    scenarios: { ok: () => json({ success: true }), failed: () => json({ error: 'money gate: pipedream failed' }, 500) },
  },

  // ── Engine (the offer wall), through our proxy or direct ──
  {
    name: 'engine_proxy',
    match: (r) => host(r) === 'engine-proxy.trypennie.dev',
    default: 'offers',
    scenarios: {
      offers: () => json({ ok: true, data: engineData([{ id: 'offer-gate-1', apr: 19.9 }]) }),
      no_offers: () => json({ ok: true, data: engineData([]) }),
      failed: () => json({ ok: false, error: 'money gate: engine refused', details: { reason: 'invalid' } }, 400),
    },
  },
  {
    name: 'engine_direct',
    match: (r) => host(r) === 'integrations.evenfinancial.com',
    default: 'ok',
    scenarios: {
      ok: () => json(engineData([{ id: 'offer-gate-1', apr: 19.9 }])),
      no_uuid: () => json({ loanOffers: [] }),
      failed: () => json({ message: 'money gate: engine unavailable' }, 503),
    },
  },

  // ── AmOne, through its proxy (a bid_group partner) ──
  {
    name: 'amone_ping',
    match: (r) => host(r) === 'am-one-proxy.trypennie.dev',
    default: 'no_bid',
    scenarios: {
      bid_high: () => json({ data: { bid: 500, ClickThrough_url: 'https://example.com/amone-click' } }),
      no_bid: () => json({ data: { bid: 0 } }),
      outage: () => json({ error: 'money gate: amone unavailable' }, 503),
    },
  },

  // ── Achieve evaluations (achieve_offers nodes) ──
  {
    name: 'achieve_evaluations',
    match: (r) => path(r).endsWith('/evaluations'),
    default: 'accepted',
    scenarios: {
      accepted: () => json({ response: 'accepted', response_reason: null, offers: [{ product: 'fdr', amount: 20000 }] }),
      rejected: () => json({ response: 'rejected', response_reason: 'money gate: credit policy' }),
      outage: () => json({ message: 'money gate: unavailable' }, 503),
    },
  },

  // ── Equifax ──
  {
    name: 'equifax_token',
    match: (r) => host(r) === 'api.equifax.com' && path(r) === '/v2/oauth/token',
    default: 'ok',
    scenarios: {
      ok: () => json({ access_token: 'gate-equifax-token', token_type: 'Bearer', expires_in: 3600 }),
      refused: () => json({ error: 'invalid_client' }, 401),
    },
  },
  {
    name: 'equifax_report',
    match: (r) => host(r) === 'api.equifax.com' && path(r).endsWith('/reports/credit-report'),
    default: 'match',
    scenarios: {
      match: equifaxReport(ONE_TRADE),
      match_high_score: equifaxReport({ ...ONE_TRADE, models: [{ modelNumber: '05402', score: 760 }] }),
      // A report carrying credit inquiries, as about 88% of live ones do (#2169), so
      // the inquiry post (the Pipedream relay today, the credit-inquiries Apex call
      // after the #1680 port) has something to send rather than skipping.
      match_with_inquiries: equifaxReport({ ...ONE_TRADE, inquiries: [{ industryCode: 'BB', inquiryDate: '2026-09-01', subscriberName: 'GATE BANK', customerNumber: null }] }),
      credit_freeze: equifaxReport({ trades: [], hitCode: { code: 'A' } }),
      no_trades: equifaxReport({ trades: [], models: [{ modelNumber: '05402', score: 640 }] }),
      no_hit: equifaxReport({}, 'no_hit'),
      fraud_alert_l: equifaxReport({ ...ONE_TRADE, fraudIDScanAlertCodes: [{ code: 'L' }] }),
      outage: () => json({ error: 'money gate: equifax unavailable' }, 503),
    },
  },

  // ── Tripoint, through the proxy ──
  {
    name: 'tripoint_create',
    match: (r) => host(r) === 'tripoint-proxy.trypennie.dev' && path(r) === '/leads/create',
    default: 'accepted',
    scenarios: {
      accepted: tripoint({ id: 'TP-GATE-0001', resultCode: 1000 }),
      declined: tripoint({ id: 'TP-GATE-0002', resultCode: 2001 }),
      duplicate: tripoint({ id: 'TP-GATE-0003', resultCode: 1003 }),
      in_progress: tripoint({ id: 'TP-GATE-0004', resultCode: 1009 }),
      null_id_fault: () => json({ ok: false, details: [{ message: 'Cannot return null for non-nullable field CreateLeadResponse.id.' }] }, 502),
      invalid_data: () => json({ ok: false, details: [{ message: 'Invalid email address' }] }, 502),
      outage: () => json({ error: 'upstream timeout' }, 504),
    },
  },

  // ── Liberty1's click webhook (the buyer profile's click delivery) ──
  {
    name: 'liberty1_click',
    match: (r) => host(r) === 'services.leadconnectorhq.com',
    default: 'success',
    scenarios: {
      success: () => json({ status: 'Success: lead received', id: 'LCGATE0000000000001' }),
      refused: () => json({ status: 'Rejected', message: 'money gate: duplicate contact' }, 400),
      unreadable: () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html>money gate: not the answer</html>' }),
      outage: () => json({ message: 'money gate: unavailable' }, 503),
    },
  },

  // ── Taktile decide (LendSwift, GigFi) ──
  {
    name: 'taktile_decide',
    match: (r) => host(r).endsWith('.decide.taktile.com'),
    default: 'accepted',
    scenarios: {
      accepted: () => json({ data: { status: 'ACCEPTED', bid_amount: 40, min_bid_value: null, redirect_url: 'https://example.com/accepted', rejection_reason: null } }),
      low_bid: () => json({ data: { status: 'ACCEPTED', bid_amount: 0.5, min_bid_value: null, redirect_url: 'https://example.com/accepted', rejection_reason: null } }),
      rejected: () => json({ data: { status: 'REJECTED', bid_amount: 0, min_bid_value: null, redirect_url: null, rejection_reason: 'credit_policy' } }),
      outage: () => json({ message: 'money gate: decide unavailable' }, 503),
    },
  },
]

export function ruleNames(): string[] {
  return RULES.map((r) => r.name)
}

export function stubAnswer(req: StubRequest, arms: Arms): { rule: string; scenario: string; answer: StubAnswer } | null {
  for (const rule of RULES) {
    if (!rule.match(req)) continue
    const scenario = arms[rule.name] ?? rule.default
    const fn = rule.scenarios[scenario]
    if (!fn) throw new Error(`money gate stub rule ${rule.name} has no scenario ${scenario}`)
    return { rule: rule.name, scenario, answer: fn(req) }
  }
  return null
}

/** The answer as a Response, with no body where HTTP allows none (a 204 carries none). */
export function toResponse(answer: StubAnswer): Response {
  const empty = answer.status === 204 || answer.status === 205 || answer.status === 304
  const body = empty ? null : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
  return new Response(body, { status: answer.status, headers: answer.headers ?? { 'content-type': 'application/json' } })
}

/** A request body as text whatever its content type, read as bytes so a form body is not flagged as binary. */
export async function readBodyText(request: Request): Promise<string> {
  if (request.method === 'GET' || request.method === 'HEAD') return ''
  return new TextDecoder().decode(await request.arrayBuffer())
}

export const NO_RULE_STATUS = 599

export function noRuleAnswer(req: StubRequest): StubAnswer {
  return json({ money_gate: 'no stub rule for this request', host: req.url.host, path: req.url.pathname }, NO_RULE_STATUS)
}
