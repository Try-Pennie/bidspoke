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
 *   targeted_products:  array of 'fdr' | 'fplus' | 'lendage' (default ['fdr'])
 *   wait_for_offers:    boolean (default true) — Achieve holds the request up
 *                       to 10s and returns offers inline
 *   utm_source:         tracking.utm_source (default env ACHIEVE_UTM_SOURCE,
 *                       then 'pennie')
 *   unsecured_debt_ref: optional {{...}} template overriding the built-in
 *                       debt extraction (for flows without the Main Flow shape)
 *
 * Env vars (Env Variables page, not Worker secrets):
 *   ACHIEVE_USERNAME / ACHIEVE_PASSWORD  Basic auth (assigned by Achieve)
 *   ACHIEVE_API_URL                      https://api-stg.freedomfinancialnet.com
 *                                        (sandbox) or https://api.freedomfinancialnet.com
 *   ACHIEVE_UTM_SOURCE                   optional utm_source fallback
 *   ACHIEVE_TRUSTED_FORM_CERT            optional tracking.trusted_form_cert
 *
 * The fetch is aborted internally at 12s so a hung Achieve API can never trip
 * the engine-level node timeout (which WOULD fail the step). Recommended node
 * settings: timeout 15000ms, retries 0 (a retry on a transport failure risks
 * double-submitting the lead).
 */

import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'
import { resolveValue } from '../context'
import { linkAbort } from '../retry'
import { isShadowDryRun, shadowAchieveStub } from '../shadow'
import { parseJsonSafe } from '../../lib/json'

export interface AchieveOffersConfig {
  targeted_products?: string[]
  wait_for_offers?: boolean
  utm_source?: string
  unsecured_debt_ref?: string
}

const FETCH_TIMEOUT_MS = 12_000
const DEFAULT_BASE_URL = 'https://api-stg.freedomfinancialnet.com'
const PROD_BASE_URL = 'https://api.freedomfinancialnet.com'
const VALID_PRODUCTS = new Set(['fdr', 'fplus', 'lendage'])

// Achieve's sandbox only returns offers for its own seeded showroom profiles. It declines
// every real lead no matter the debt (28/28 on 2026-07-13, including two at ~$18k with poor
// credit). Achieve told us directly: "if you want to see a response with offers, please use
// this profile (a new valid email every time)".
//
// So a real consumer sent to the sandbox leaks their SSN, DOB, name and address to a system
// that discards them and tells us nothing. Off production we substitute the showroom
// identity and OMIT the SSN and DOB (their spec marks both optional; only email, phone,
// name and address are Required). The lead's financial profile is kept: it carries no
// identity and it is what FDR actually evaluates.
const SHOWROOM_PROFILE = {
  first_name: 'Mark',
  last_name: 'Mayerberger',
  mailing_address: {
    street: '19538 CREEKSIDE CT',
    city: 'Salinas',
    state: 'CA',
    zip: '93908',
  },
  phone: '+18005551212', // E.164 placeholder; the real lead's number is never sent off prod
} as const

// Achieve requires a NEW email on every sandbox submission or it will not re-evaluate the
// profile. trace_id is unique per execution. Domain is overridable without a deploy in case
// Achieve rejects it.
function sandboxEmail(ctx: ExecutionContext): string {
  const domain = ctx.env.ACHIEVE_SANDBOX_EMAIL_DOMAIN || 'trypennie.com'
  const unique = String(ctx.trigger.trace_id || Date.now()).toLowerCase().replace(/[^a-z0-9]/g, '')
  return `achieve.sandbox.${unique}@${domain}`
}

// Fails safe: anything that is not explicitly production counts as sandbox, so a blank or
// misconfigured ACHIEVE_API_URL sends the fake profile rather than a real person.
function isProduction(baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, '') === PROD_BASE_URL
}

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
  const products = (config.targeted_products ?? ['fdr']).filter((p) => VALID_PRODUCTS.has(p))
  const waitForOffers = config.wait_for_offers !== false

  // Needed BEFORE the request is built: off production we swap the lead's identity for
  // Achieve's showroom profile rather than leaking it to a sandbox that discards it.
  const baseUrl = ctx.env.ACHIEVE_API_URL || DEFAULT_BASE_URL
  const production = isProduction(baseUrl)

  const request = buildRequest(
    ctx,
    config,
    products.length > 0 ? products : ['fdr'],
    waitForOffers,
    production
  )
  const resolvedInput = {
    template: { ...config },
    resolved: {
      targeted_products: products,
      wait_for_offers: waitForOffers,
      sandbox_profile: !production,
    },
  }

  if (!ctx.env.ACHIEVE_USERNAME || !ctx.env.ACHIEVE_PASSWORD) {
    return {
      output: result(false, 0, 'error', 'Missing ACHIEVE_USERNAME/ACHIEVE_PASSWORD env vars', request, null),
      resolvedInput,
    }
  }

  const missing = missingRequiredFields(request)
  if (missing.length > 0) {
    return {
      output: result(false, 0, 'error', `Missing required fields: ${missing.join(', ')}`, request, null),
      resolvedInput,
    }
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
        Authorization: 'Basic ' + btoa(`${ctx.env.ACHIEVE_USERNAME}:${ctx.env.ACHIEVE_PASSWORD}`),
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
      return { output: result(false, res.status, 'error', reason, request, responseBody), resolvedInput }
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
        responseBody
      ),
      resolvedInput,
    }
  } catch (err) {
    const name = (err as { name?: string })?.name
    const message = err instanceof Error ? err.message : String(err)
    const reason = message.includes('timed out') || name === 'TimeoutError' || name === 'AbortError'
      ? `Achieve API timed out after ${FETCH_TIMEOUT_MS}ms`
      : message
    return { output: result(false, 0, 'error', reason, request, null), resolvedInput }
  } finally {
    clearTimeout(timer)
  }
}

function buildRequest(
  ctx: ExecutionContext,
  config: AchieveOffersConfig,
  products: string[],
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

  // Identity: the real consumer ONLY on production. Off production, Achieve's showroom
  // profile with a fresh email, and no SSN or DOB at all.
  const identity: Record<string, unknown> = production
    ? {
        email: pi.email,
        phone: toE164(pi.primaryPhone),
        first_name: pi.firstName,
        last_name: pi.lastName,
        date_of_birth: pi.dateOfBirth || undefined,
        social_security_number: pi.ssn || undefined,
        mailing_address: {
          street: pi.address1,
          street2: pi.address2 || undefined,
          city: pi.city,
          state: pi.state,
          zip: pi.zipcode,
        },
      }
    : {
        email: sandboxEmail(ctx),
        phone: SHOWROOM_PROFILE.phone,
        first_name: SHOWROOM_PROFILE.first_name,
        last_name: SHOWROOM_PROFILE.last_name,
        mailing_address: { ...SHOWROOM_PROFILE.mailing_address },
      }

  const body: Record<string, unknown> = {
    ...identity,
    tracking: {
      unique_identifier: leadId,
      utm_medium: 'partner',
      utm_media: 'partner',
      utm_source: config.utm_source || ctx.env.ACHIEVE_UTM_SOURCE || 'pennie',
      ip_address: si.ipAddress || undefined,
      user_agent: si.userAgent || undefined,
      trusted_form_cert: ctx.env.ACHIEVE_TRUSTED_FORM_CERT || undefined,
    },
    partner_config: {
      wait_for_offers: waitForOffers,
      targeted_products: products,
    },
    partner_lead_id: leadId,
  }

  const consents = buildConsents(ctx, payload)
  if (consents) body.consents = consents

  const unsecuredDebt = extractUnsecuredDebt(ctx, config)
  if (unsecuredDebt != null && unsecuredDebt >= 0) body.unsecured_debt = unsecuredDebt

  const loanAmount = li.loanAmount != null ? Math.round(Number(li.loanAmount)) : null
  if (loanAmount != null && loanAmount > 0) body.loan_amount = loanAmount

  // Achieve: omit annual_income when unknown, never send 0.
  const income = fi.annualIncome != null ? Math.round(Number(fi.annualIncome)) : null
  if (income) body.annual_income = income

  const employment = fi.employmentStatus ? EMPLOYMENT_MAP[fi.employmentStatus] : undefined
  if (employment) body.employment_status = employment

  const rating = String(ci.providedCreditRating ?? '').toLowerCase()
  if (CREDIT_RATINGS.has(rating)) body.credit_rating = rating

  if (li.purpose && LOAN_PURPOSES.has(li.purpose)) body.loan_purpose = li.purpose

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
    const resolved = resolveValue(config.unsecured_debt_ref, ctx)
    const n = Number(resolved)
    return Number.isFinite(n) ? Math.round(n) : null
  }
  const elig = ctx.steps.pennie_or_eligibility?.output as
    | { eligibilityData?: { estimated_total_debt?: number | null }; final?: number | null }
    | undefined
  const debt = elig?.eligibilityData?.estimated_total_debt ?? elig?.final ?? null
  return debt != null && Number.isFinite(Number(debt)) ? Math.round(Number(debt)) : null
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
  response: unknown
) {
  const offers = (response as { offers?: unknown[] } | null)?.offers
  const offersArray = Array.isArray(offers) ? offers : null
  return {
    _achieve_evaluation: true as const,
    ok,
    status,
    response_status: responseStatus,
    response_reason: reason,
    offer_count: offersArray ? offersArray.length : 0,
    offers: offersArray,
    request,
    response: response ?? null,
  }
}
