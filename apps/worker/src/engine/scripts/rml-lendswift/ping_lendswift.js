async function transformToLendSwift(body, refId, leadAffiliate, leadProvider, leadCampaign, subAccountBids) {
  const personal = body.personalInformation || {};
  const loan = body.loanInformation || {};
  const financial = body.financialInformation || {};
  const mortgage = body.mortgageInformation || {};
  const session = body.sessionInformation || {};

  const mapIncomeType = (status) => {
    const map = {
      'employed': '1', 'employed_full_time': '1', 'employed_part_time': '1',
      'military': '6', 'not_employed': '6', 'self_employed': '5',
      'retired': '4', 'other': '6'
    };
    return map[(status || '').toLowerCase()] || '6';
  };

  const mapPayFrequency = (freq) => {
    const map = { 'weekly': '1', 'biweekly': '2', 'twice_monthly': '3', 'monthly': '4' };
    return map[(freq || '').toLowerCase()] || '4';
  };

  const formatSSN = (ssn) => (ssn || '').replace(/\D/g, '');

  const formatPhone = (phone) => {
    const digits = (phone || '').replace(/\D/g, '');
    if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    return phone || '';
  };

  const monthlyIncome = financial.annualIncome ? +(financial.annualIncome / 12).toFixed(2) : 0;

  // Next pay date: 7 days from today as a sensible default
  const nextPayDay = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}/${dd}/${d.getFullYear()}`;
  })();

  const minBidValue = subAccountBids?.[body.subAccountUuid] ?? null;

  return {
    data: {
      Username: body.lendSwiftUsername,
      Password: body.lendSwiftPassword,
      RefID: refId || body.leadUuid || '',
      LeadAffiliate: leadAffiliate || body.subAccountUuid || '',
      LeadCost: 0,
      min_bid_value: minBidValue ?? 0.00,
      Firstname: personal.firstName || '',
      Lastname: personal.lastName || '',
      SSN: formatSSN(personal.ssn),
      Email: personal.email || '',
      DOB: personal.dateOfBirth || '',
      Language: 'e',
      Military: 'n',
      HomeAddress: personal.address1 || '',
      HomeCity: personal.city || '',
      HomeState: personal.state || '',
      HomeZip: personal.zipcode || '',
      HomePhone: formatPhone(personal.primaryPhone),
      CellPhone: formatPhone(personal.primaryPhone),
      HomeOwner: ['own_outright', 'own_with_mortgage'].includes(mortgage.propertyStatus) ? 'y' : 'n',
      BankInfo: { AccountToUse: 'C' },
      EmploymentInfo: {
        MonthlyIncome: monthlyIncome,
        PayFrequency: mapPayFrequency(financial.employmentPayFrequency),
        IncomeType: mapIncomeType(financial.employmentStatus),
        PayrollType: '2',
        NextPayDay: nextPayDay,
      },
      LoanInfo: { Amount: loan.loanAmount || 0 },
      LeadProvider: leadProvider || '',
      LeadCampaign: leadCampaign || loan.purpose || '',
      ClientIPAddress: session.ipAddress || ''
    },
    control: { execution_mode: 'sync' },
    mock_data: {},
    metadata: {},
  };
}

// The lead is sent to LendSwift ONCE, and its answer is waited for up to 60 seconds
// (#2582, Dan 2026-10-21). There is no resend: a failed or slow call may already
// have reached LendSwift, and a second send can come back as their duplicate_lead.
// The node runs with retries 0 and a 65 second timeout, so the engine does not
// resend it either.
const LENDSWIFT_DEADLINE_MS = 60000;

async function makeLendSwiftRequest(reqPayload, url, apiKey) {
  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, LENDSWIFT_DEADLINE_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify(reqPayload),
      signal: controller.signal,
    });
    const respData = await response.json().catch(() => null);
    if (timedOut) return lendswiftTimeout();
    if (!response.ok) {
      return { error: true, kind: 'http_error', statusCode: response.status, body: respData };
    }
    // build_response reads data.data, so an answer without it is an error too (#2582).
    if (!respData || typeof respData.data !== 'object' || respData.data === null) {
      return { error: true, kind: 'unreadable_answer', statusCode: response.status, body: respData };
    }
    return { error: false, statusCode: 200, data: respData };
  } catch (error) {
    if (timedOut) return lendswiftTimeout();
    return { error: true, kind: 'network_error', statusCode: null, message: error && error.message };
  } finally {
    clearTimeout(deadline);
  }
}

function lendswiftTimeout() {
  return { error: true, kind: 'timeout', statusCode: null, message: `no answer from LendSwift within ${LENDSWIFT_DEADLINE_MS / 1000} seconds` };
}

// LendSwift's own reason for an error, small enough to keep on the step output (#2582).
// Their error body echoes what they sent their providers, and a provider URL can carry
// the applicant's SSN, so only the message, type and decision id are kept, every run of
// five or more digits is masked and the text is capped.
const maskDigits = (text) => String(text == null ? '' : text).replace(/\d{3}-\d{2}-\d{4}/g, '[redacted]').replace(/\d{5,}/g, '[redacted]').slice(0, 500);

function describeLendSwiftError(result) {
  const body = result.body && typeof result.body === 'object' ? result.body : {};
  const detail = body.detail && typeof body.detail === 'object' ? body.detail : {};
  // The first of these that is text; anything else is left out rather than stringified.
  let message = [detail.msg, body.message, body.status, result.message].find((m) => typeof m === 'string' && m) || '';
  let providerType = null;
  // A provider failure arrives as "<summary> Details: <json>"; keep the summary and the
  // first inner message, and drop the provider's raw response and headers.
  const cut = typeof message === 'string' ? message.indexOf(' Details: ') : -1;
  if (cut >= 0) {
    let inner = null;
    try { inner = JSON.parse(message.slice(cut + ' Details: '.length)); } catch {}
    const first = inner && Array.isArray(inner.detail) ? inner.detail[0] : null;
    providerType = first && typeof first.type === 'string' ? first.type : null;
    message = message.slice(0, cut) + (first && first.msg ? ' ' + first.msg : '');
  }
  return {
    kind: result.kind,
    http_status: typeof result.statusCode === 'number' ? result.statusCode : null,
    status: typeof body.status === 'string' ? body.status : null,
    exc_type: typeof detail.exc_type === 'string' ? detail.exc_type : null,
    provider_error: providerType,
    message: maskDigits(message),
    decision_id: body.metadata && typeof body.metadata.decision_id === 'string' ? maskDigits(body.metadata.decision_id) : null,
  };
}

// --- Credential lookup (folded in) ---
const state = payload.personalInformation.state;
const apiKey = env.LENDSWIFT_API_KEY;
const username = env[`LENDSWIFT_${state}_USERNAME`];
const password = env[`LENDSWIFT_${state}_PASSWORD`];

if (!username || !password) {
  throw new Error(`No credentials found for state: ${state}`);
}

// --- Config ---
const ENDPOINT_URL = "https://risk.bf9baa41.decide.taktile.com/run/api/v1/flows/training/decide";
const LEAD_PROVIDER = "Pennie";

const applicantId = steps.create_applicant.output.body.id;
const subAccountBids = steps.constants.output.LendswiftSubAccountMinBids || {};

const formattedBody = await transformToLendSwift(
  { ...payload, lendSwiftUsername: username, lendSwiftPassword: password },
  applicantId,
  payload.subAccountUuid,
  LEAD_PROVIDER,
  payload.loanInformation && payload.loanInformation.purpose,
  subAccountBids
);

const result = await makeLendSwiftRequest(formattedBody, ENDPOINT_URL, apiKey);

if (result.error) {
  // A LendSwift failure ends the lead as no bid (#2582, Dan 2026-10-21). This answer
  // carries lendswift_error, which build_response answers as partner_error, and it
  // also has the shape of a rejection (no bid amount, rejection_reason set), so an
  // older build_response still takes the no bid path. Either way the flow patches
  // the Applicant through patch_applicant_no_bid and answers the source normally.
  // LendSwift's own reason stays on this step's output as lendswift_error.
  const lendswiftError = describeLendSwiftError(result);
  console.error('LendSwift failed, so the lead is answered as no bid (#2582):', JSON.stringify(lendswiftError));
  return {
    error: true,
    statusCode: result.statusCode,
    lendswift_error: lendswiftError,
    data: { data: { status: 'ERROR', bid_amount: null, min_bid_value: null, redirect_url: null, rejection_reason: 'lendswift_error' } },
  };
}

return result;
