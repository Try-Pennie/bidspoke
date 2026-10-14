// The Liberty1 request for one click (#1545): Brian's buildPayload, unchanged
// but for consentsToTcpa and debtAmount (see below), over the record pick_record chose (a
// prospect, or a submission mapped onto prospect field names). Pure:
// buyer_click_send posts it, this only builds it.
//
// Where it is posted is not decided here (#1671): buyer_click_send picks the
// route from the Liberty1 buyer profile's Click delivery by the state returned
// below, so an endpoint Liberty1 moves is a profile edit, not a script paste.

const clean = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const digits = (v) => { const s = clean(v); return s === null ? null : s.replace(/\D/g, ""); };
const phone10 = (v) => { const d = digits(v); if (d === null) return null; return d.length === 11 && d.startsWith("1") ? d.slice(1) : d; };
const zip5 = (v) => { const d = digits(v); return d === null ? null : d.slice(0, 5); };
const titleCase = (v) => { const s = clean(v); return s === null ? null : s.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, (_, sep, c) => sep + c.toUpperCase()); };
const upper = (v) => { const s = clean(v); return s === null ? null : s.toUpperCase(); };
const lower = (v) => { const s = clean(v); return s === null ? null : s.toLowerCase(); };
// Picklist value -> API enum: "Poor (<600)" -> "poor", "Own with Mortgage" -> "own_with_mortgage"
const toEnum = (v) => { const s = clean(v); if (s === null) return null; return s.replace(/\s*\(.*?\)\s*/g, " ").trim().toLowerCase().replace(/\s+/g, "_"); };
const num = (v) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const address1 = (street, apt) => {
  const s = clean(street); const a = clean(apt);
  if (s === null) return a; if (a === null) return s;
  return /^(apt|unit|ste|suite|#)/i.test(a) ? `${s} ${a}` : `${s} Apt ${a}`;
};

function buildPayload(p) {
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
    // True on every click, not the earlier form's TCPAConsentFlag__c: the person
    // reaches this workflow only by pressing a button that sits under Liberty1's
    // own TCPA disclosure, so the press is the consent (Dan, 2026-09-29).
    consentsToTcpa: true,
    ipAddress: clean(p.User_IP__c),
    // Not in his flow: Liberty1 asked for the debt amount to route the client to
    // the right agents (#2110). Engine Debt, the figure the buyer profile's debt
    // minimum judged (Dan, 2026-10-14); null when the record has none, never 0.
    debtAmount: num(p.EngineDebt__c),
  };
}

// The offer check before this node routes only an open click here, so an
// absent record is a wiring fault: refuse by name rather than post a body of nulls.
const record = steps.pick_record?.output?.record;
if (!record || !record.Id) {
  throw new Error("build_liberty1_request: no record picked in steps.pick_record, so nothing to send");
}

const body = buildPayload(record);

return {
  body,
  // Upper cased by buildPayload; click_send's state template reads it to pick the route.
  state: body.state,
};
