// Which record a Liberty1 click is for (#1545). The portal posts both ids,
// {Prospect__c, Submission__c}; either alone is still accepted.
//
// - A valid Submission__c queries the submission itself, with its Lead and,
//   through Prospect__r, every field of the prospect it points at, so
//   pick_record sends from the prospect when there is one and from the
//   submission when there is not (Brian, 2026-09-29). With a valid Prospect__c
//   beside it, the submission must belong to that prospect: pick_record refuses
//   a pair that does not agree, so a Submission__c cannot attach this click to
//   someone else's records.
// - A valid Prospect__c alone (or with a Submission__c that is not an id, which
//   Brian's flow also skips) queries that prospect directly.
// - A Prospect__c that is present but not an id is refused, even beside a valid
//   Submission__c, as Brian's run() threw on it.
//
// An id is interpolated into SOQL, so anything that is not exactly 15 or 18
// letters and digits is refused here and never reaches a query. valid false
// sends the run to the refusal response, with the reason named.
const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

// Brian's PROSPECT_FIELDS, then the two fields the offer check reads, then the
// Engine Debt Liberty1 is sent as debtAmount (#2110).
const FIELDS = [
  "Id", "SubaccountName__c", "SubaccountUUID__c", "First_Name__c", "Last_Name__c", "Email__c",
  "Phone__c", "Street__c", "AptSuite__c", "City__c", "State__c", "Zip__c", "BirthDate__c",
  "SocialSecurityNumber__c", "LoanPurpose__c", "LoanAmount__c", "RentOrOwn__c",
  "ApproximateCreditRating__c", "EmploymentStatus__c", "IncomePmtFrequency__c",
  "AnnualIncomeBeforeTaxes__c", "EducationLevel__c", "FCRAConsentFlag__c", "TCPAConsentFlag__c",
  "User_IP__c", "ExternalRoutingCode__c", "ExternalExchangeStatus__c", "EngineDebt__c",
];

// Brian's SUBMISSION_FIELDS (the applicant lives in the *_SO__c fields, the
// phone on the Lead), then the submission's two offer fields and its Engine Debt
// (#2110).
const SUBMISSION_FIELDS = [
  "Id", "Prospect__c", "Lead__c", "Source__c", "FundedDemandSubAccountName__c", "SubaccountUUID__c",
  "Prospect_Subaccount_UUID__c", "FirstNameSO__c", "LastNameSO__c", "Email_SO__c", "Home_Phone__c",
  "StreetSO__c", "Apt_Suite_SO__c", "City_SO__c", "State_SO__c", "Zip_Code_SO__c",
  "Date_of_Birth_SO__c", "Social_Security_Number_SO__c", "Loan_Purpose_SO__c", "Loan_Amount_SO__c",
  "Rent_or_Own_SO__c", "Approximate_Credit_Rating_SO__c", "Employment_Status_SO__c",
  "Income_Pmt_Frequency_SO__c", "Annual_Income_Before_Taxes_SO__c", "Education_Level_SO__c",
  "ConsentFCRA__c", "Consent__c", "User_IP__c",
  "Lead__r.FirstName", "Lead__r.LastName", "Lead__r.Email", "Lead__r.Phone", "Lead__r.MobilePhone",
  "External_Routing_Code__c", "External_Exchange_Status__c", "EngineDebt__c",
];

const body = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};

const present = (v) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
const asId = (v) => (typeof v === "string" && SF_ID.test(v.trim()) ? v.trim() : null);

const prospectId = asId(body.Prospect__c);
const submissionId = asId(body.Submission__c);

// A Prospect__c that is present but not an id is refused outright, as Brian's
// run() threw on it, even beside a valid Submission__c: falling back to the
// submission would skip the check that the pair belongs together.
const refuse = (reason) => ({ valid: false, reason, source: null, prospect_id: null, submission_id: null, soql: null });
if (present(body.Prospect__c) && !prospectId) return refuse("invalid_id");

if (prospectId && !submissionId) {
  return {
    valid: true,
    reason: null,
    source: "prospect",
    prospect_id: prospectId,
    submission_id: null,
    soql: `SELECT ${FIELDS.join(", ")} FROM Prospect__c WHERE Id = '${prospectId}'`,
  };
}

if (submissionId) {
  const selected = [...SUBMISSION_FIELDS, ...FIELDS.map((f) => `Prospect__r.${f}`)];
  return {
    valid: true,
    reason: null,
    source: "submission",
    prospect_id: prospectId,
    submission_id: submissionId,
    soql: `SELECT ${selected.join(", ")} FROM Submission__c WHERE Id = '${submissionId}'`,
  };
}

return refuse(present(body.Submission__c) ? "invalid_id" : "no_id");
