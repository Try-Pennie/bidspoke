/**
 * Brian's Pipedream Liberty1 click flow (eoltut7tgps3yat), kept as the ORACLE the
 * Bidspoke scripts are compared against (#1545), so a test proves the port
 * produces what his code produces rather than what somebody read his code as.
 *
 * `send_to_liberty_1` below is his code verbatim, with TypeScript parameter
 * types added and nothing else changed: the helpers, buildPayload, the state
 * set and the routes. His run() is not code here because it fetches; the one
 * line of it the port depends on, picking the route from the payload's state,
 * is `pickRoute(payload.state)` (the state after `upper`), which is how the
 * route is read from his result object's `state` and `route` pair.
 *
 * `update_salesforce` reached us as a summary of the three bodies (field names,
 * their order, the constants, the status rule), not as verbatim code, so its
 * oracle is built from that summary: this half proves the port matches the
 * summary, and says so.
 */

type Rec = Record<string, unknown>

// ---- send_to_liberty_1, verbatim -------------------------------------------

const LIBERTY1_BASE =
  "https://liberty1financial.my.salesforce-sites.com/L1F/services/apexrest/inbound/webhooks";

const DV1_STATES = new Set(["DE", "HI", "IA", "MN", "OR", "RI", "VT", "WA", "WI", "WY"]);

export const ROUTES = {
  DV1: `${LIBERTY1_BASE}/DV1`,
  DI4: `${LIBERTY1_BASE}/DI4`, // all other states
};

const clean = (v: unknown) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const digits = (v: unknown) => { const s = clean(v); return s === null ? null : s.replace(/\D/g, ""); };
const phone10 = (v: unknown) => { const d = digits(v); if (d === null) return null; return d.length === 11 && d.startsWith("1") ? d.slice(1) : d; };
const zip5 = (v: unknown) => { const d = digits(v); return d === null ? null : d.slice(0, 5); };
const titleCase = (v: unknown) => { const s = clean(v); return s === null ? null : s.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, (_: string, sep: string, c: string) => sep + c.toUpperCase()); };
const upper = (v: unknown) => { const s = clean(v); return s === null ? null : s.toUpperCase(); };
const lower = (v: unknown) => { const s = clean(v); return s === null ? null : s.toLowerCase(); };
// Picklist value -> API enum: "Poor (<600)" -> "poor", "Own with Mortgage" -> "own_with_mortgage"
const toEnum = (v: unknown) => { const s = clean(v); if (s === null) return null; return s.replace(/\s*\(.*?\)\s*/g, " ").trim().toLowerCase().replace(/\s+/g, "_"); };
const num = (v: unknown) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const address1 = (street: unknown, apt: unknown) => {
  const s = clean(street); const a = clean(apt);
  if (s === null) return a; if (a === null) return s;
  return /^(apt|unit|ste|suite|#)/i.test(a) ? `${s} ${a}` : `${s} Apt ${a}`;
};

export function buildPayload(p: Rec) {
  return {
    leadId1: p.Id,
    leadId2: clean(p.SubaccountName__c),
    leadId3: clean(p.SubaccountUUID__c),
    firstName: clean(p.First_Name__c),
    lastName: clean(p.Last_Name__c),
    email: lower(p.Email__c),
    primaryPhone: phone10(p.Phone__c),
    address1: address1(p.Street__c, p.AptSuite__c),
    city: titleCase(p.City__c),
    state: upper(p.State__c),
    zipcode: zip5(p.Zip__c),
    dateOfBirth: clean(p.BirthDate__c),
    ssn: digits(p.SocialSecurityNumber__c),
    purpose: toEnum(p.LoanPurpose__c),
    loanAmount: num(p.LoanAmount__c),
    propertyStatus: toEnum(p.RentOrOwn__c),
    providedCreditRating: toEnum(p.ApproximateCreditRating__c),
    employmentStatus: toEnum(p.EmploymentStatus__c),
    employmentPayFrequency: toEnum(p.IncomePmtFrequency__c),
    annualIncome: num(p.AnnualIncomeBeforeTaxes__c),
    educationLevel: toEnum(p.EducationLevel__c),
    consentsToFcra: p.FCRAConsentFlag__c === true,
    consentsToTcpa: p.TCPAConsentFlag__c === true,
    ipAddress: clean(p.User_IP__c),
  };
}

export const pickRoute = (state: string | null) => (state && DV1_STATES.has(state) ? "DV1" : "DI4");

// ---- update_salesforce, from the summary -----------------------------------

const PARTNER_NAME = "Liberty1";
const ROUTING_CODE = 4; // Number on Prospect, Text on Submission/Lead
const LEAD_SALE_TYPE = "Form";
export const LIBERTY1_TCPA = `By clicking "Connect with Liberty1 Financial": I expressly agree to Liberty1 Financial's TCPA consent below, Terms & Conditions, Privacy Policy, and Consent for Electronic Communications.

I expressly provide my consent to receive marketing calls and texts/SMS regarding personal loan and debt consolidation products from Clear Vision Financial LLC, doing business as Liberty1 Financial, at the phone number I provided, including via an automatic telephone dialing system or an artificial, prerecorded, or AI-generated voice, even if my number is on a federal, state, or company Do-Not-Call list. I understand that my consent is not a condition of purchasing any goods or services and that my consent may be revoked at any time, such as by replying "STOP" to opt out of SMS or by telling Liberty1 Financial to stop on any call. I also acknowledge that Liberty1 Financial's Terms & Conditions include a Jury Trial Waiver, Class Action Waiver, and Arbitration Agreement, and, if I am a California resident, that the California Privacy Notice describes my privacy rights. Message and data rates may apply, and message frequency varies.

Text HELP for help or text STOP to cancel.`;

/** Undefined values dropped so nothing is blanked, as his composite PATCH did. */
const dropUndefined = (o: Rec): Rec => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

/**
 * His three bodies from what Liberty1 answered. `ok` is the HTTP ok flag and
 * `text` the raw answer; `inspectUrl` is what he wrote to PDFlow_3__c.
 */
export function updateBodies(l1: { ok: boolean; text: string }, now: string, inspectUrl: string | undefined) {
  const created = /created successfully/i.test(l1.text);
  const exchangeStatus = l1.ok && created ? "Completed" : "Fail";
  const partnerLeadId = created ? l1.text.match(/:\s*([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)\s*$/)?.[1] : undefined;
  return {
    submission: dropUndefined({
      External_Exchange_Status__c: exchangeStatus,
      External_Partner_Lead_Id__c: partnerLeadId,
      External_Partner_Name__c: PARTNER_NAME,
      External_Routing_Code__c: String(ROUTING_CODE),
      External_TCPA_Consent__c: LIBERTY1_TCPA,
      External_Timestamp__c: now,
      PDFlow_3__c: inspectUrl,
      LeadSaleType__c: LEAD_SALE_TYPE,
    }),
    prospect: dropUndefined({
      ExternalExchangeStatus__c: exchangeStatus,
      ExternalPartnerLeadId__c: partnerLeadId,
      ExternalPartnerName__c: PARTNER_NAME,
      ExternalRoutingCode__c: ROUTING_CODE,
      TCPA_Consent__c: LIBERTY1_TCPA,
      ExternalTimestamp__c: now,
      PDFlow_3__c: inspectUrl,
      LeadSaleType__c: LEAD_SALE_TYPE,
    }),
    lead: dropUndefined({
      External_Exchange_Status__c: exchangeStatus,
      ExternalPartnerLeadId__c: partnerLeadId,
      ExternalPartnerName__c: PARTNER_NAME,
      External_Routing_Code__c: String(ROUTING_CODE),
      TCPAConsent__c: LIBERTY1_TCPA,
      External_Timestamp__c: now,
      LeadSaleType__c: LEAD_SALE_TYPE,
    }),
  };
}
