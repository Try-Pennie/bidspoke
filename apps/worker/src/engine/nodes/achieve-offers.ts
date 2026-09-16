/**
 * Achieve Offers node — sends the lead to Achieve's Partners API and collects
 * the offers it returns, without feeding them into routing.
 *
 * Built for the FDR data-collection effort: log lead-in / offers-out so the
 * team can analyze potential volume and lead types. The node is a pass-through
 * with a single output and it NEVER fails the flow — every outcome (accepted,
 * rejected, auth failure, network error, missing fields) returns a structured
 * output. The `_achieve_evaluation: true` marker on that output tells the
 * engine's achieve-log hook to persist it to the achieve_evaluations table.
 *
 * Config:
 *   wait_for_offers:    boolean (default true) - Achieve holds the request up
 *                       to 10s and returns offers inline
 *
 * We do NOT send targeted_products: Achieve drives product selection on their side
 * ("we evaluate your leads for APL", Olivier Pariselle 2026-07-13) and asked us to
 * drop the field. Their `fplus` responses are Personal Loan + Pagaya, which is what
 * Pennie wants; FDR (debt resolution) is explicitly not wanted.
 *   utm_source:         tracking.utm_source (default env ACHIEVE_UTM_SOURCE,
 *                       then 'pennie')
 *   unsecured_debt_ref: optional {{...}} template overriding the built-in
 *                       debt extraction (for flows without the Main Flow shape)
 *
 * Env vars (Env Variables page, not Worker secrets):
 *   ACHIEVE_ENV                          'production' or 'staging'. Picks the host AND the
 *                                        credential pair together (see achieve-endpoint.ts).
 *                                        Unset means staging; an unrecognised value REFUSES to
 *                                        send rather than guessing.
 *   ACHIEVE_USERNAME / ACHIEVE_PASSWORD  Basic auth (assigned by Achieve)
 *   ACHIEVE_STAGING_USERNAME / _PASSWORD Optional staging pair; each falls back to the main one
 *   ACHIEVE_API_URL                      Legacy explicit host, still honoured. ACHIEVE_ENV wins
 *   ACHIEVE_UTM_SOURCE                   optional utm_source fallback
 *   ACHIEVE_UTM_CAMPAIGN                 optional utm_campaign fallback (default '_achieve_pl')
 *
 * The fetch is aborted internally at 12s so a hung Achieve API can never trip
 * the engine-level node timeout (which WOULD fail the step). Recommended node
 * settings: timeout 15000ms, retries 0 (a retry on a transport failure risks
 * double-submitting the lead).
 */

import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'
import { formatErr } from '../../lib/format-error'
import { resolveValue } from '../context'
import { linkAbort } from '../retry'
import { isShadowDryRun, shadowAchieveStub } from '../shadow'
import { parseJsonSafe } from '../../lib/json'
import { screenLead } from './achieve-screen'
import { resolveAchieveEndpoint } from './achieve-endpoint'
import { achieveIdentityHeaders } from './achieve-identity'
import { findEquifaxReport } from './achieve-credit-report'
import { deriveCreditMetrics, type CreditMetrics } from './achieve-credit-metrics'

export interface AchieveOffersConfig {
  wait_for_offers?: boolean
  utm_source?: string
  utm_campaign?: string
  unsecured_debt_ref?: string
  // Optional per-node override for where the pulled Vantage score lives. Defaults to the
  // Main Flow's `gen_vantage_score` step. Only consulted when ACHIEVE_MIN_VANTAGE_SCORE > 0.
  vantage_score_ref?: string
}

const FETCH_TIMEOUT_MS = 12_000

// Achieve's sandbox only returns offers for its own seeded showroom profiles; it declines
// every real lead (28/28 on 2026-07-13, including two at ~$18k with poor credit). Achieve
// gave us exactly ONE seeded profile to use off production: this name, address and SSN.
//
// We substitute ONLY the fields Achieve handed us. Everything else on the request stays the
// real lead's, unchanged. Do NOT drop or synthesize other fields: Achieve told us to use
// this profile, not to reshape the payload. The SSN must go in their NNN-NN-NNNN format.
const SHOWROOM_PROFILE = {
  first_name: 'Mark',
  last_name: 'Mayerberger',
  social_security_number: '666-16-4094',
  mailing_address: {
    street: '19538 CREEKSIDE CT',
    city: 'Salinas',
    state: 'CA',
    zip: '93908',
  },
} as const

const EMPLOYMENT_MAP: Record<string, string> = {
  employed_full_time: 'full_time',
  employed_part_time: 'part_time',
  full_time: 'full_time',
  part_time: 'part_time',
  self_employed: 'self_employed',
  unemployed: 'not_employed',
  not_employed: 'not_employed',
  retired: 'retired',
  student: 'student',
  homemaker: 'homemaker',
}

const CREDIT_RATINGS = new Set([
  'excellent', 'very_good_plus', 'very_good', 'good_plus', 'good',
  'fair_plus', 'fair', 'poor', 'unknown_to_lead',
])

const LOAN_PURPOSES = new Set([
  'credit_card_refinance', 'debt_consolidation', 'home_improvement',
  'major_purchase', 'home_purchase', 'home_green', 'wedding', 'vacation',
  'business', 'auto', 'medical', 'moving', 'other',
])

// The Pennie form emits `credit_card_refi`, but Achieve's API only accepts the full word
// `credit_card_refinance` and 422s on the short form. Normalize inbound values Achieve does
// not recognize before the whitelist check, so the purpose is translated rather than dropped.
const LOAN_PURPOSE_ALIASES: Record<string, string> = {
  credit_card_refi: 'credit_card_refinance',
}

// Achieve requires a `consents` object and rejects the lead outright without it
// ("Missing consents"), despite their doc marking it optional. Each field holds the
// VERBATIM legal text shown to the user, not a boolean.
//
// The text is identical for every lead (it is whatever the Pennie form displays), so it
// lives in env vars rather than the payload. The payload's booleans say only WHICH
// consents this lead granted, and we send a consent's text only when its boolean is true
// so we never assert to a lender that a consumer agreed to something they did not.
//
// e_sign / policy / term have no boolean of their own: the form grants all three on the
// same "Agree & View Offers" click that sets consentsToFcra, so they ride on that flag.
const CONSENT_ENV: Record<string, string> = {
  tcpa: 'ACHIEVE_CONSENT_TCPA',
  fcra: 'ACHIEVE_CONSENT_FCRA',
  e_sign: 'ACHIEVE_CONSENT_ESIGN',
  policy: 'ACHIEVE_CONSENT_POLICY',
  term: 'ACHIEVE_CONSENT_TERM',
}
const FCRA_CLICK_CONSENTS = ['fcra', 'e_sign', 'policy', 'term']

interface LeadPayload {
  Submission__c?: string
  legalInformation?: {
    consentsToFcra?: boolean
    consentsToTcpa?: boolean
  }
  personalInformation?: {
    ssn?: string
    email?: string
    primaryPhone?: string
    firstName?: string
    lastName?: string
    dateOfBirth?: string
    address1?: string
    address2?: string
    city?: string
    state?: string
    zipcode?: string
  }
  loanInformation?: { purpose?: string; loanAmount?: number }
  financialInformation?: { annualIncome?: number; employmentStatus?: string }
  creditInformation?: { providedCreditRating?: string }
  sessionInformation?: { ipAddress?: string; userAgent?: string }
  /** Traffic source for tracking.utm_adgroup, when the lead carries one. */
  traffic_source?: string
}

/** A non-empty string or nothing: tracking fields are omitted rather than sent blank. */
function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

export async function executeAchieveOffersNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  signal?: AbortSignal
): Promise<StepExecutionResult> {
  // Shadow dry-run: don't hit the Achieve API; return a stub that the achieve-log
  // hook ignores (no _achieve_evaluation marker means no DB write).
  if (isShadowDryRun(ctx)) return shadowAchieveStub()

  const config = node.config as unknown as AchieveOffersConfig
  const waitForOffers = config.wait_for_offers !== false

  // Pre-send screening against Achieve's own recommended criteria. Ships entirely OFF: every
  // threshold is an env var that is inert when unset, so a deploy changes nothing until values
  // are configured. A held-back lead is a pass-through carrying its OWN reason and no
  // _achieve_evaluation marker, so it writes no DB row and never fails the flow (same contract
  // as the shadow stub). The reason is per-criterion on purpose: a rejected lead never reaches
  // Achieve, so counting rejections by cause is the only measurement left.
  // Test runs bypass the screen (Dan, 2026-08-31): the score floor doubles as the live
  // pipe's pause switch, and a canvas test send is a deliberate, person-initiated single
  // lead, so it goes out regardless. Real webhook traffic stays fully screened.
  const verdict = ctx.isTest ? undefined : screenLead(ctx, config)
  if (verdict && !verdict.pass) {
    return {
      output: {
        _achieve_skipped: true as const,
        reason: verdict.reason,
        screen: verdict.detail ?? {},
        ok: false,
        response_status: 'skipped',
        offer_count: 0,
        offers: [],
      },
    }
  }

  // Needed BEFORE the request is built: off production we swap the lead's identity for
  // Achieve's showroom profile rather than leaking it to a sandbox that discards it. One setting
  // (ACHIEVE_ENV) picks the host AND the matching credentials, and anything that cannot be proven
  // to be production resolves to staging.
  const { baseUrl, production, username, password, invalidEnv } = resolveAchieveEndpoint(ctx.env)

  const request = buildRequest(ctx, config, waitForOffers, production)
  const resolvedInput = {
    template: { ...config },
    resolved: {
      wait_for_offers: waitForOffers,
      sandbox_profile: !production,
      endpoint: baseUrl,
    },
  }

  // Names the environment, because a staging test with no staging credential stored and a
  // production run with none are the same message otherwise, and they need different fixes.
  // A misspelled environment stops the send and names the value. Quietly using staging would look
  // identical to Achieve declining every lead, sending whoever reads it after the partner rather
  // than the one setting that is wrong.
  if (invalidEnv != null) {
    return {
      output: result(
        false, 0, 'error',
        `Unknown ACHIEVE_ENV '${invalidEnv}'. Expected 'production' or 'staging'.`,
        request, null, !production
      ),
      resolvedInput,
    }
  }

  if (!username || !password) {
    const which = production ? 'production' : 'staging'
    return {
      output: result(
        false, 0, 'error',
        `Missing Achieve ${which} username/password env vars`,
        request, null, !production
      ),
      resolvedInput,
    }
  }

  const missing = missingRequiredFields(request)
  if (missing.length > 0) {
    return {
      output: result(false, 0, 'error', `Missing required fields: ${missing.join(', ')}`, request, null, !production),
      resolvedInput,
    }
  }

  // Derived once, before the call, so every outcome carries the same figures: an accept, a
  // decline and a timeout are all comparable afterwards. Null when no report could be read,
  // which is a different thing from a report showing nothing.
  //
  // Wrapped because this runs OUTSIDE the try below, and the node's whole contract is that it
  // never fails the flow: it is a pass-through bolted to the tail of Main Flow, after the lead
  // has already been answered. Nothing in the derivation throws on today's data, which is luck
  // rather than design, and a diagnostic must never cost the thing it is diagnosing. Null on
  // failure, which is the same value used when there is no report, because both mean the same
  // thing to a reader: nothing was measured.
  let metrics: CreditMetrics | null = null
  try {
    const report = findEquifaxReport(ctx)
    metrics = report ? deriveCreditMetrics(report, new Date()) : null
  } catch (err) {
    // Logged rather than swallowed silently: a derivation that throws on real reports is a
    // defect worth seeing, even though it must not stop the send.
    console.error(`[achieve-offers] credit metrics derivation failed: ${formatErr(err)}`)
  }

  // Own controller so the internal 12s timeout AND the step-level timeout (#66)
  // can both cancel the call.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  linkAbort(controller, signal)
  try {
    const res = await fetch(`${baseUrl}/evaluations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + btoa(`${username}:${password}`),
        // Without these the call is refused by Achieve's firewall before it reaches
        // their API, for what another Workers tenant did with the shared egress
        // address we all leave from. See achieve-identity.ts.
        ...achieveIdentityHeaders(ctx.env),
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    })

    const responseBody = await parseJsonSafe<{
      response?: string
      response_reason?: string
      message?: string
    }>(res)

    if (!res.ok) {
      const reason =
        responseBody?.response_reason ?? responseBody?.message ?? `Achieve API returned ${res.status}`
      return {
        output: result(false, res.status, 'error', reason, request, responseBody, !production, responseIds(res), metrics),
        resolvedInput,
      }
    }

    const responseStatus =
      responseBody?.response === 'accepted' || responseBody?.response === 'rejected'
        ? responseBody.response
        : 'error'
    return {
      output: result(
        responseStatus === 'accepted',
        res.status,
        responseStatus,
        responseBody?.response_reason ?? null,
        request,
        responseBody,
        !production,
        responseIds(res),
        metrics
      ),
      resolvedInput,
    }
  } catch (err) {
    const name = (err as { name?: string })?.name
    const message = formatErr(err)
    const reason = message.includes('timed out') || name === 'TimeoutError' || name === 'AbortError'
      ? `Achieve API timed out after ${FETCH_TIMEOUT_MS}ms`
      : message
    return { output: result(false, 0, 'error', reason, request, null, !production, NO_RESPONSE_IDS, metrics), resolvedInput }
  } finally {
    clearTimeout(timer)
  }
}

function buildRequest(
  ctx: ExecutionContext,
  config: AchieveOffersConfig,
  waitForOffers: boolean,
  production: boolean
): Record<string, unknown> {
  const payload = (ctx.trigger.payload ?? {}) as LeadPayload
  const pi = payload.personalInformation ?? {}
  const li = payload.loanInformation ?? {}
  const fi = payload.financialInformation ?? {}
  const si = payload.sessionInformation ?? {}
  const ci = payload.creditInformation ?? {}

  const submissionId = typeof payload.Submission__c === 'string' ? payload.Submission__c : undefined
  const leadId = submissionId ?? ctx.trigger.trace_id

  // The real lead's identity is always the base. Off production we overlay ONLY the two
  // fields Achieve seeded (name + address); everything else stays the real lead's. Achieve
  // gave us a profile to use, not a payload to reshape.
  const identity: Record<string, unknown> = production
    ? {
        first_name: pi.firstName,
        last_name: pi.lastName,
        mailing_address: {
          street: pi.address1,
          street2: pi.address2 || undefined,
          city: pi.city,
          state: pi.state,
          zip: pi.zipcode,
        },
      }
    : {
        first_name: SHOWROOM_PROFILE.first_name,
        last_name: SHOWROOM_PROFILE.last_name,
        social_security_number: SHOWROOM_PROFILE.social_security_number,
        mailing_address: { ...SHOWROOM_PROFILE.mailing_address },
      }

  const body: Record<string, unknown> = {
    email: pi.email,
    phone: toE164(pi.primaryPhone),
    date_of_birth: pi.dateOfBirth || undefined,
    social_security_number: pi.ssn || undefined,
    ...identity,
    tracking: {
      unique_identifier: leadId,
      utm_medium: 'partner',
      utm_media: 'partner',
      utm_source: config.utm_source || ctx.env.ACHIEVE_UTM_SOURCE || 'pennie',
      utm_campaign: config.utm_campaign || ctx.env.ACHIEVE_UTM_CAMPAIGN || '_achieve_pl',
      utm_adgroup: nonEmpty(payload.traffic_source),
      ip_address: si.ipAddress || undefined,
      user_agent: si.userAgent || undefined,
      // No trusted_form_cert. #1081 was closed NOT PLANNED on 2026-09-04: the TrustedForm
      // script is not going on the site, so no certificate can ever be minted for a Pennie
      // lead, and Achieve confirmed on 2026-09-10 that it is not required while consent is
      // captured and attested, which the consents block below does.
    },
    // No targeted_products: Achieve drives product selection server-side and asked us to
    // drop the field. Sending it is ignored at best, and misleading at worst.
    partner_config: {
      wait_for_offers: waitForOffers,
    },
    partner_lead_id: leadId,
  }

  const consents = buildConsents(ctx, payload)
  if (consents) body.consents = consents

  const unsecuredDebt = extractUnsecuredDebt(ctx, config)
  if (unsecuredDebt != null) body.unsecured_debt = unsecuredDebt

  const loanAmount = li.loanAmount != null ? Math.round(Number(li.loanAmount)) : null
  if (loanAmount != null && loanAmount > 0) body.loan_amount = loanAmount

  // Achieve: omit annual_income when unknown, never send 0.
  const income = fi.annualIncome != null ? Math.round(Number(fi.annualIncome)) : null
  if (income) body.annual_income = income

  const employment = fi.employmentStatus ? EMPLOYMENT_MAP[fi.employmentStatus] : undefined
  if (employment) body.employment_status = employment

  const rating = String(ci.providedCreditRating ?? '').toLowerCase()
  if (CREDIT_RATINGS.has(rating)) body.credit_rating = rating

  const purpose = li.purpose ? (LOAN_PURPOSE_ALIASES[li.purpose] ?? li.purpose) : undefined
  if (purpose && LOAN_PURPOSES.has(purpose)) body.loan_purpose = purpose

  return body
}

// Returns the consents Achieve requires, or undefined when the lead granted none (or no
// text is configured) so the key is omitted rather than sent empty.
function buildConsents(
  ctx: ExecutionContext,
  payload: LeadPayload
): Record<string, string> | undefined {
  const legal = payload.legalInformation
  if (!legal) return undefined

  const granted = (key: string): boolean =>
    key === 'tcpa' ? legal.consentsToTcpa === true : FCRA_CLICK_CONSENTS.includes(key) && legal.consentsToFcra === true

  const consents: Record<string, string> = {}
  for (const [key, envVar] of Object.entries(CONSENT_ENV)) {
    const text = ctx.env[envVar]
    if (granted(key) && text) consents[key] = text
  }
  return Object.keys(consents).length > 0 ? consents : undefined
}

// Verified debt from the Main Flow eligibility step, overridable via template
// for workflows with a different payload shape.
function extractUnsecuredDebt(ctx: ExecutionContext, config: AchieveOffersConfig): number | null {
  if (config.unsecured_debt_ref) {
    return toSendableDebt(resolveValue(config.unsecured_debt_ref, ctx))
  }
  const elig = ctx.steps.pennie_or_eligibility?.output as
    | { eligibilityData?: { estimated_total_debt?: number | null }; final?: number | null }
    | undefined
  return (
    toSendableDebt(elig?.eligibilityData?.estimated_total_debt) ?? toSendableDebt(elig?.final)
  )
}

// A zero or negative figure means we have no usable one, never that the lead owes nothing:
// Salesforce zeroes Engine Debt when every creditor on the lead is excluded, and Eligibility
// Scout answers 0 for a lead it judges debt-too-low. Sending it would have Achieve screen on
// a debt figure nobody measured, so the field is omitted instead.
function toSendableDebt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const rounded = Math.round(n)
  return rounded > 0 ? rounded : null
}



function toE164(phone: string | undefined): string | undefined {
  if (!phone) return undefined
  const digits = String(phone).replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return undefined
}

function missingRequiredFields(request: Record<string, unknown>): string[] {
  const missing: string[] = []
  const address = request.mailing_address as { state?: string }
  if (!request.email) missing.push('email')
  if (!request.phone) missing.push('phone')
  if (!request.first_name) missing.push('first_name')
  if (!request.last_name) missing.push('last_name')
  if (!address?.state) missing.push('mailing_address.state')
  if (request.unsecured_debt == null && request.loan_amount == null) {
    missing.push('unsecured_debt/loan_amount')
  }
  return missing
}

function result(
  ok: boolean,
  status: number,
  responseStatus: string,
  reason: string | null,
  request: Record<string, unknown>,
  response: unknown,
  // Off production the request carried Achieve's seeded showroom identity, so the offers and
  // the accept/decline describe a FAKE person. The achieve-log hook persists this as
  // achieve_evaluations.is_sandbox so the analysis can exclude the fake offer signal while
  // keeping the real volume signal.
  sandbox: boolean,
  // Both ids are always emitted, as null where no call was made or the headers were
  // absent. An undefined would be dropped from the stored JSON entirely, leaving a header
  // we failed to read indistinguishable from one Achieve never sent.
  ids: ResponseIds = NO_RESPONSE_IDS,
  // Null where no report could be read, so a send with nothing to measure stays
  // distinguishable from one measured on a consumer who genuinely had nothing.
  metrics: CreditMetrics | null = null
) {
  const offers = (response as { offers?: unknown[] } | null)?.offers
  const offersArray = Array.isArray(offers) ? offers : null
  return {
    _achieve_evaluation: true as const,
    sandbox,
    ok,
    status,
    response_status: responseStatus,
    response_reason: reason,
    offer_count: offersArray ? offersArray.length : 0,
    offers: offersArray,
    request,
    response: response ?? null,
    achieve_request_id: ids.achieve_request_id,
    cf_ray: ids.cf_ray,
    credit_metrics: metrics,
  }
}

/**
 * The two identifiers Achieve's edge stamps on every response: their own application
 * request id, and Cloudflare's ray id from the proxy in front of them. Measured
 * 2026-09-11 against an unauthenticated call, where both were present on the 401, so
 * they do not depend on the request being accepted.
 *
 * They are captured because Achieve's decline responses carry nothing but one sentence
 * ("Lead N didn't qualify for offers"), so their own request id is the only way to have
 * support look up a specific call without describing it by timestamp and reference.
 */
interface ResponseIds {
  achieve_request_id: string | null
  cf_ray: string | null
}

const NO_RESPONSE_IDS: ResponseIds = { achieve_request_id: null, cf_ray: null }

function responseIds(res: { headers?: { get(name: string): string | null } }): ResponseIds {
  // Optional chaining rather than a direct read: a test double or a runtime that hands
  // back a response without headers would otherwise throw here, turning a missing
  // diagnostic into a failed lead.
  return {
    achieve_request_id: res.headers?.get('x-request-id') ?? null,
    cf_ray: res.headers?.get('cf-ray') ?? null,
  }
}
