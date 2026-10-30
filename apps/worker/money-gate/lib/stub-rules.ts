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
 *
 * An answer can also fail to arrive whole (#3086), as a buyer's sometimes does:
 * its `ending` says how, and answerFetch plays it out as the platform's fetch
 * would. Only the engine's own fetch can be given one; a code bundle's requests
 * reach the gate through its outbound service, where a throw arrives as an HTTP
 * 500, so codeBundleRefusal names any such answer there instead.
 *
 * An answer can also arrive whole but late (#3128): its `arrivesAfterMs` holds it
 * that long on the replay's own time, so the pinned clock moves on with it. The
 * Achieve step reads how much of the window after the answer is left from that
 * clock, so a slow write before it is what makes it start late. A code bundle is
 * refused one too, since its timers are out of the lift's reach.
 */
import type { WaitOnReplayTime } from './engine-timers'

export type { WaitOnReplayTime } from './engine-timers'

export interface StubRequest {
  method: string
  url: URL
  headers: Record<string, string>
  body: unknown
}

/**
 * How an answer fails to arrive whole (#3086). Absent, it arrives whole.
 *   connection_failed  the fetch rejects before any header, with nothing aborted,
 *                      as a refused or dropped connection does.
 *   no_headers         no header ever arrives: the fetch rejects only when the
 *                      request's own signal aborts, with that signal's reason.
 *   body_cut_off       the headers and the first piece of the body arrive, then
 *                      the connection drops.
 *   body_trickles      the headers and the first piece arrive at once, then one
 *                      piece every TRICKLE_EVERY_MS of replay time, the last far
 *                      past any buyer call's limit, until the signal aborts.
 */
export type AnswerEnding = 'connection_failed' | 'no_headers' | 'body_cut_off' | 'body_trickles'

export interface StubAnswer {
  status: number
  headers?: Record<string, string>
  /** For an answer with an ending, what the buyer would have sent had it arrived whole. */
  body: unknown
  ending?: AnswerEnding
  /**
   * The whole answer arrives this long after the request, in replay time (#3128).
   * The gate lifts each step's own limit, so a step never times out on it; one
   * late answer stands for the time a slow write takes, its retries included.
   */
  arrivesAfterMs?: number
}

/** A trickling body's pace, in replay time: its last piece arrives at seven times this, past a 20 s limit. */
export const TRICKLE_EVERY_MS = 5_000
/** How many pieces a cut off or trickling body is sent in. */
const BODY_PIECES = 8

/** Rule name to scenario name, from the fixture variant. A rule a variant does not name uses its default. */
export type Arms = Record<string, string>

export interface Rule {
  name: string
  match: (r: StubRequest) => boolean
  /**
   * Each scenario's answer to a request. `attempt` counts the requests this rule
   * already answered in the run (0 for the first), so a scenario can answer a
   * retry differently from the attempt before it (#3138).
   */
  scenarios: Record<string, (r: StubRequest, attempt: number) => StubAnswer>
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

/** The Pipedream relay Main Flow's outcome writes post to, as its committed definition names it (#3128). */
export const PIPEDREAM_OUTCOME_RELAY_HOST = 'eocv5xd49efymsn.m.pipedream.net'

/** The answer `whole` gives, arriving whole only after `ms` of replay time (#3128). */
const late = (ms: number, whole: (r: StubRequest) => StubAnswer) => (r: StubRequest): StubAnswer => ({ ...whole(r), arrivesAfterMs: ms })

/** The answer `whole` gives, failing to arrive whole as `how` says (#3086). */
const ending = (how: AnswerEnding, whole: (r: StubRequest) => StubAnswer) => (r: StubRequest): StubAnswer => ({ ...whole(r), ending: how })

/** No answer to the first `n` attempts (each ends only when its request aborts), then the answer `whole` gives (#3138). */
const unansweredFirst = (n: number, whole: (r: StubRequest) => StubAnswer) => (r: StubRequest, attempt: number): StubAnswer =>
  attempt < n ? { ...whole(r), ending: 'no_headers' } : whole(r)

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
  // The credit-collections Apex REST call, a slot of parallel_1 before the answer
  // once the collections stage is applied (#2832). The endpoint
  // (CollectionParserRest) is not live yet, so the success body is the gate's own,
  // not one measured from the org.
  {
    name: 'salesforce_credit_collections',
    match: (r) => r.method === 'POST' && path(r) === '/services/apexrest/credit-collections',
    default: 'ok',
    scenarios: {
      ok: () => json({ message: 'money gate: collections accepted', statusCode: 200 }),
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
  // The outcome relay: the Salesforce write each answered arm of Main Flow posts
  // after the answer (tripoint_sf_post, amone_sf_post and the rest), the step just
  // before its Achieve step. Its own rule, ahead of the catch all below, so a
  // variant can slow it without slowing the inquiry relay inside parallel_1, which
  // runs before the answer. The two late answers (#3128) put the Achieve step on
  // either side of its cutoff: with the 12 s window, the 500 ms margin and the 4 s
  // floor, a step starting 7.5 s after the answer sends and one at 7.501 s skips.
  // In production that time is a write's attempts and the waits between them (a
  // 3,750 ms attempt timing out, 500 ms, then a slow second attempt). The two
  // no_answer scenarios (#3138) are that: the first attempts get no answer, so the
  // step's own deadline ends each (a fixture keeps it with `timed_steps`), and the
  // retry after the backoff is answered.
  {
    name: 'pipedream_outcome_post',
    match: (r) => host(r) === PIPEDREAM_OUTCOME_RELAY_HOST,
    default: 'ok',
    scenarios: {
      ok: () => json({ success: true }),
      ok_after_7500ms: late(7_500, () => json({ success: true })),
      ok_after_7501ms: late(7_501, () => json({ success: true })),
      no_answer_then_ok: unansweredFirst(1, () => json({ success: true })),
      no_answer_twice_then_ok: unansweredFirst(2, () => json({ success: true })),
    },
  },
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
      // The live buyer call getting no complete answer (#3086), each an acceptance
      // that never arrives whole, since a buyer that may have taken the lead is the
      // case the hold exists for.
      no_answer_timeout: ending('no_headers', tripoint({ id: 'TP-GATE-0005', resultCode: 1000 })),
      connection_failed: ending('connection_failed', tripoint({ id: 'TP-GATE-0005', resultCode: 1000 })),
      body_cut_off: ending('body_cut_off', tripoint({ id: 'TP-GATE-0005', resultCode: 1000 })),
      body_trickle_timeout: ending('body_trickles', tripoint({ id: 'TP-GATE-0005', resultCode: 1000 })),
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
      // The two error shapes LendSwift's decide answered on 2026-10-21 (#2582), with
      // synthetic ids. The provider message embeds a provider URL, which for one of
      // their providers ends in the applicant's SSN; nine zeros stand in for it here.
      decide_error: () => taktileError('AttributeError: Attribute: `data` not found', 'runtime'),
      provider_timeout: () => taktileError(`We encountered an issue while retrieving the response from the provider. Details: ${JSON.stringify({
        detail: [{ msg: 'Timeout on downstream API: get https://ms.lendswift.com/leads/v1/ssn/000000000', type: 'provider_timeout', ctx: { msg: 'Request to downstream API timed out', provider_raw_response: null, provider_status_code: 504 } }],
        meta: { request_attempts: 1, provider_response_status: 'timeout' },
      })}`, 'provider'),
      // A 200 with no decision in it, which the flow's build_response cannot read.
      no_decision: () => json({ status: 'error', detail: { msg: 'money gate: no decision', exc_type: 'runtime' } }),
    },
  },
]

/** A Taktile decide error body, as LendSwift's answered on 2026-10-21 (#2582), with nothing real in it. */
function taktileError(msg: string, excType: string): StubAnswer {
  return json({
    status: 'error',
    detail: { msg, node_id: '00000000-0000-4000-8000-00000000d0de', exc_type: excType },
    metadata: { version: 'gate', entity_id: 'gate-entity', flow_slug: 'training', decision_id: 'gate-decision-0001', environment: 'gate' },
    raw_provider_requests: [{ money_gate: 'stands in for the requests LendSwift sent its providers' }],
    raw_provider_responses: [],
  }, 500)
}

export function ruleNames(): string[] {
  return RULES.map((r) => r.name)
}

/**
 * The rule and scenario that answer `req`, and the answer. `attempts` is the run's
 * count of requests each rule has answered (#3138), kept by the caller for one run
 * and moved on here; without it every request is answered as a first attempt.
 */
export function stubAnswer(req: StubRequest, arms: Arms, attempts?: Map<string, number>): { rule: string; scenario: string; answer: StubAnswer } | null {
  for (const rule of RULES) {
    if (!rule.match(req)) continue
    const scenario = arms[rule.name] ?? rule.default
    const fn = rule.scenarios[scenario]
    if (!fn) throw new Error(`money gate stub rule ${rule.name} has no scenario ${scenario}`)
    const attempt = attempts?.get(rule.name) ?? 0
    attempts?.set(rule.name, attempt + 1)
    return { rule: rule.name, scenario, answer: fn(req, attempt) }
  }
  return null
}

/** The answer as a Response, with no body where HTTP allows none (a 204 carries none). Refuses one that does not arrive whole. */
export function toResponse(answer: StubAnswer): Response {
  if (answer.ending) throw new Error(`money gate: an answer that ends ${answer.ending} does not arrive whole, so it cannot be sent as a whole Response; answerFetch plays it out`)
  const empty = answer.status === 204 || answer.status === 205 || answer.status === 304
  return new Response(empty ? null : bodyText(answer), { status: answer.status, headers: answer.headers ?? { 'content-type': 'application/json' } })
}

function bodyText(answer: StubAnswer): string {
  return typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
}

const CONNECTION_LOST = 'money gate: network connection lost'

/** What the platform's fetch rejects with when a connection drops; the message says where it came from. */
const connectionLost = (): TypeError => new TypeError(CONNECTION_LOST)

/**
 * Whether an unhandled error vitest reports is a no answer the replay played out
 * (#3086): a dropped connection from answerFetch, or the abort a held answer
 * caused by moving the replay's time on to the engine's own timer. workerd
 * reports a rejected fetch as unhandled even when its caller awaits it (README,
 * the outage drill's known quirk), and postToPartner awaits these: the replay
 * records each as no answer. Matched on the error AND its origin in the gate's
 * own files, so any other unhandled error still fails the run.
 */
export function isReplayedNoAnswerRejection(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: unknown; message?: unknown; stack?: unknown }
  const stack = typeof e.stack === 'string' ? e.stack : ''
  if (!/money-gate\/lib\/stub-rules\.ts/.test(stack)) return false
  const dropped = e.name === 'TypeError' && e.message === CONNECTION_LOST
  const advancedAbort = e.name === 'AbortError' && /money-gate\/lib\/engine-timers\.ts/.test(stack)
  return dropped || advancedAbort
}

/** The signal's own reason, as the platform's fetch rejects an aborted request with. */
const abortReason = (signal: AbortSignal): unknown => signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')

/**
 * What the engine's fetch does with `answer` for a request sent with `signal`
 * (#3086): resolves with the Response, or rejects as the platform's fetch does
 * when no complete answer arrives. A held answer waits only on `wait`, the
 * replay's own time, so nothing here waits for real.
 */
export async function answerFetch(answer: StubAnswer, signal: AbortSignal | undefined, wait: WaitOnReplayTime): Promise<Response> {
  const how = answer.ending
  if (answer.arrivesAfterMs !== undefined) {
    if (how) throw new Error(`money gate: an answer cannot both arrive late (arrivesAfterMs) and end ${how}; give it one or the other`)
    // A request with no signal still waits: only the replay's time ends this wait.
    const held = signal ?? new AbortController().signal
    if ((await wait(held, answer.arrivesAfterMs)) === 'aborted') throw abortReason(held)
    return toResponse(answer)
  }
  if (!how) return toResponse(answer)
  if (how === 'connection_failed') throw connectionLost()
  if ((how === 'no_headers' || how === 'body_trickles') && !signal) {
    throw new Error(`money gate: an answer that ends ${how} was asked for by a request with no signal, so nothing could ever end its wait`)
  }
  if (how === 'no_headers') {
    await wait(signal!)
    throw abortReason(signal!)
  }
  const text = bodyText(answer)
  const size = Math.ceil(text.length / BODY_PIECES)
  const pieces = Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size))
  const encoder = new TextEncoder()
  let next = 0
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Errored with the signal's own reason, as the fetch standard's abort does to a body being read.
      if (signal) signal.addEventListener('abort', () => controller.error(abortReason(signal)), { once: true })
    },
    async pull(controller) {
      if (next > 0 && how === 'body_cut_off') {
        controller.error(connectionLost())
        return
      }
      if (next > 0 && (await wait(signal!, TRICKLE_EVERY_MS)) === 'aborted') return
      if (signal?.aborted) return
      controller.enqueue(encoder.encode(pieces[next]))
      next += 1
      if (next === pieces.length) controller.close()
    },
  }, { highWaterMark: 0 })
  return new Response(stream, { status: answer.status, headers: answer.headers ?? { 'content-type': 'application/json' } })
}

/**
 * Why a code bundle's request cannot be given this answer, or null when it can
 * (#3086). A bundle's requests reach the gate through its outbound service, where
 * a throw arrives as an HTTP 500 rather than as a failed fetch, and its timers are
 * out of the lift's reach, so an answer that does not arrive whole is refused by
 * name rather than played as something else. So is one that arrives whole but
 * late (#3128): its wait is on the replay's time, which a bundle cannot be held
 * on, so it would be answered at once and the clock would never move.
 */
export function codeBundleRefusal(hit: { rule: string; scenario: string; answer: StubAnswer }, fixture: string): string | null {
  if (hit.answer.arrivesAfterMs !== undefined) {
    return `money gate: ${fixture}: a code bundle asked for ${hit.rule}/${hit.scenario}, which arrives ${hit.answer.arrivesAfterMs} ms late; only the engine's own fetch can wait on the replay's time (#3128)`
  }
  if (!hit.answer.ending) return null
  return `money gate: ${fixture}: a code bundle asked for ${hit.rule}/${hit.scenario}, which ends ${hit.answer.ending}; only the engine's own fetch can be given an answer that does not arrive whole`
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
