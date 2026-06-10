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

export interface AchieveOffersConfig {
  targeted_products?: string[]
  wait_for_offers?: boolean
  utm_source?: string
  unsecured_debt_ref?: string
}

const FETCH_TIMEOUT_MS = 12_000
const DEFAULT_BASE_URL = 'https://api-stg.freedomfinancialnet.com'
const VALID_PRODUCTS = new Set(['fdr', 'fplus', 'lendage'])

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

interface LeadPayload {
  Submission__c?: string
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
  ctx: ExecutionContext
): Promise<StepExecutionResult> {
  const config = node.config as unknown as AchieveOffersConfig
  const products = (config.targeted_products ?? ['fdr']).filter((p) => VALID_PRODUCTS.has(p))
  const waitForOffers = config.wait_for_offers !== false

  const request = buildRequest(ctx, config, products.length > 0 ? products : ['fdr'], waitForOffers)
  const resolvedInput = {
    template: { ...config },
    resolved: { targeted_products: products, wait_for_offers: waitForOffers },
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

  const baseUrl = ctx.env.ACHIEVE_API_URL || DEFAULT_BASE_URL

  try {
    const res = await fetch(`${baseUrl}/evaluations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + btoa(`${ctx.env.ACHIEVE_USERNAME}:${ctx.env.ACHIEVE_PASSWORD}`),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    const responseBody = (await res.json().catch(() => null)) as
      | { response?: string; response_reason?: string; message?: string }
      | null

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
    const message = err instanceof Error ? err.message : String(err)
    const reason = message.includes('timed out') || (err as { name?: string })?.name === 'TimeoutError'
      ? `Achieve API timed out after ${FETCH_TIMEOUT_MS}ms`
      : message
    return { output: result(false, 0, 'error', reason, request, null), resolvedInput }
  }
}

function buildRequest(
  ctx: ExecutionContext,
  config: AchieveOffersConfig,
  products: string[],
  waitForOffers: boolean
): Record<string, unknown> {
  const payload = (ctx.trigger.payload ?? {}) as LeadPayload
  const pi = payload.personalInformation ?? {}
  const li = payload.loanInformation ?? {}
  const fi = payload.financialInformation ?? {}
  const si = payload.sessionInformation ?? {}
  const ci = payload.creditInformation ?? {}

  const submissionId = typeof payload.Submission__c === 'string' ? payload.Submission__c : undefined
  const leadId = submissionId ?? ctx.trigger.trace_id

  const body: Record<string, unknown> = {
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
