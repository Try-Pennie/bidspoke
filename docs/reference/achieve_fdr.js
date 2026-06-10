// Achieve Partners API (FDR only) - data collection node.
// Sends the lead to Achieve with targeted_products ['fdr'] and wait_for_offers,
// returns the offers for logging, and NEVER throws or affects the flow outcome.
// The _achieve_evaluation marker tells the engine to persist this output to
// the achieve_evaluations table.
//
// Suggested node settings: namespace achieve_fdr, timeout 15000ms, retries 0
// (retrying a transport failure risks double-submitting the lead).
//
// Env vars (Env Variables page): ACHIEVE_USERNAME, ACHIEVE_PASSWORD (secret),
// ACHIEVE_API_URL (https://api-stg.freedomfinancialnet.com for sandbox,
// https://api.freedomfinancialnet.com for prod), optional ACHIEVE_UTM_SOURCE,
// optional ACHIEVE_TRUSTED_FORM_CERT.

const EMPLOYMENT_MAP = {
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
};

const CREDIT_RATINGS = [
  'excellent', 'very_good_plus', 'very_good', 'good_plus', 'good',
  'fair_plus', 'fair', 'poor', 'unknown_to_lead',
];

const LOAN_PURPOSES = [
  'credit_card_refinance', 'debt_consolidation', 'home_improvement',
  'major_purchase', 'home_purchase', 'home_green', 'wedding', 'vacation',
  'business', 'auto', 'medical', 'moving', 'other',
];

function toE164(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function buildRequest() {
  const pi = payload.personalInformation ?? {};
  const li = payload.loanInformation ?? {};
  const fi = payload.financialInformation ?? {};
  const si = payload.sessionInformation ?? {};
  const ci = payload.creditInformation ?? {};

  const elig = steps.pennie_or_eligibility?.output;
  const verifiedDebt = elig?.eligibilityData?.estimated_total_debt ?? elig?.final ?? null;
  const unsecuredDebt = verifiedDebt != null ? Math.round(Number(verifiedDebt)) : null;
  const loanAmount = li.loanAmount != null ? Math.round(Number(li.loanAmount)) : null;

  const body = {
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
      unique_identifier: payload.Submission__c ?? execution.trace_id,
      utm_medium: 'partner',
      utm_media: 'partner',
      utm_source: env.ACHIEVE_UTM_SOURCE || 'pennie',
      ip_address: si.ipAddress || undefined,
      user_agent: si.userAgent || undefined,
      trusted_form_cert: env.ACHIEVE_TRUSTED_FORM_CERT || undefined,
    },
    partner_config: {
      wait_for_offers: true,
      targeted_products: ['fdr'],
    },
    partner_lead_id: payload.Submission__c ?? execution.trace_id,
  };

  if (unsecuredDebt != null && unsecuredDebt >= 0) body.unsecured_debt = unsecuredDebt;
  if (loanAmount != null && loanAmount > 0) body.loan_amount = loanAmount;

  // Doc: omit annual_income when unknown, never send 0.
  const income = fi.annualIncome != null ? Math.round(Number(fi.annualIncome)) : null;
  if (income) body.annual_income = income;

  const employment = EMPLOYMENT_MAP[fi.employmentStatus];
  if (employment) body.employment_status = employment;

  const rating = String(ci.providedCreditRating || '').toLowerCase();
  if (CREDIT_RATINGS.includes(rating)) body.credit_rating = rating;

  if (LOAN_PURPOSES.includes(li.purpose)) body.loan_purpose = li.purpose;

  return body;
}

function result(ok, status, responseStatus, reason, request, response) {
  const offers = Array.isArray(response?.offers) ? response.offers : null;
  return {
    _achieve_evaluation: true,
    ok,
    status,
    response_status: responseStatus,
    response_reason: reason ?? null,
    offer_count: offers ? offers.length : 0,
    offers,
    request,
    response: response ?? null,
  };
}

const request = buildRequest();

if (!env.ACHIEVE_USERNAME || !env.ACHIEVE_PASSWORD) {
  return result(false, 0, 'error', 'Missing ACHIEVE_USERNAME/ACHIEVE_PASSWORD env vars', request, null);
}

const missing = [];
if (!request.email) missing.push('email');
if (!request.phone) missing.push('phone');
if (!request.first_name) missing.push('first_name');
if (!request.last_name) missing.push('last_name');
if (!request.mailing_address.state) missing.push('mailing_address.state');
if (request.unsecured_debt == null && request.loan_amount == null) missing.push('unsecured_debt/loan_amount');
if (missing.length > 0) {
  return result(false, 0, 'error', `Missing required fields: ${missing.join(', ')}`, request, null);
}

const baseUrl = env.ACHIEVE_API_URL || 'https://api-stg.freedomfinancialnet.com';

try {
  const res = await fetch(`${baseUrl}/evaluations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + btoa(`${env.ACHIEVE_USERNAME}:${env.ACHIEVE_PASSWORD}`),
    },
    body: JSON.stringify(request),
  });

  const responseBody = await res.json().catch(() => null);
  console.log('[achieve]', JSON.stringify({
    status: res.status,
    response: responseBody?.response,
    reason: responseBody?.response_reason,
    offers: Array.isArray(responseBody?.offers) ? responseBody.offers.length : 0,
  }));

  if (!res.ok) {
    const reason = responseBody?.response_reason
      ?? responseBody?.message
      ?? `Achieve API returned ${res.status}`;
    return result(false, res.status, 'error', reason, request, responseBody);
  }

  const responseStatus = responseBody?.response === 'accepted' || responseBody?.response === 'rejected'
    ? responseBody.response
    : 'error';
  return result(
    responseStatus === 'accepted',
    res.status,
    responseStatus,
    responseBody?.response_reason ?? null,
    request,
    responseBody,
  );
} catch (err) {
  console.error('[achieve] fetch threw', err);
  return result(false, 0, 'error', err.message, request, null);
}
