// Which record a Liberty1 click is for (#1545). The portal posts {Prospect__c}
// or {Submission__c}, whichever it has. A Prospect__c that is a Salesforce id is
// queried directly. Otherwise a Submission__c that is one queries the
// submission itself, with its Lead and, through Prospect__r, every field of the
// prospect it points at, so pick_record can send from the prospect when there
// is one and from the submission when there is not (Brian, 2026-09-29).
//
// The portal posts both ids. A Prospect__c posted with a Submission__c queries
// the submission too, so its Lead is written, and names the prospect it must
// belong to: pick_record refuses a pair that does not agree, so a posted
// Submission__c can never attach this click to someone else's records.
//
// An id is interpolated into SOQL, so anything that is not exactly 15 or 18
// letters and digits is refused here and never reaches a query. valid false
// sends the run to the refusal response, with the reason named.
const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

// Brian's PROSPECT_FIELDS, then the two fields the offer check reads.
const FIELDS = [
  "Id", "SubaccountName__c", "SubaccountUUID__c", "First_Name__c", "Last_Name__c", "Email__c",
  "Phone__c", "Street__c", "AptSuite__c", "City__c", "State__c", "Zip__c", "BirthDate__c",
  "SocialSecurityNumber__c", "LoanPurpose__c", "LoanAmount__c", "RentOrOwn__c",
  "ApproximateCreditRating__c", "EmploymentStatus__c", "IncomePmtFrequency__c",
  "AnnualIncomeBeforeTaxes__c", "EducationLevel__c", "FCRAConsentFlag__c", "TCPAConsentFlag__c",
  "User_IP__c", "ExternalRoutingCode__c", "ExternalExchangeStatus__c",
];

// Brian's SUBMISSION_FIELDS (the applicant lives in the *_SO__c fields, the
// phone on the Lead), then the submission's two offer fields.
const SUBMISSION_FIELDS = [
  "Id", "Prospect__c", "Lead__c", "Source__c", "FundedDemandSubAccountName__c", "SubaccountUUID__c",
  "Prospect_Subaccount_UUID__c", "FirstNameSO__c", "LastNameSO__c", "Email_SO__c", "Home_Phone__c",
  "StreetSO__c", "Apt_Suite_SO__c", "City_SO__c", "State_SO__c", "Zip_Code_SO__c",
  "Date_of_Birth_SO__c", "Social_Security_Number_SO__c", "Loan_Purpose_SO__c", "Loan_Amount_SO__c",
  "Rent_or_Own_SO__c", "Approximate_Credit_Rating_SO__c", "Employment_Status_SO__c",
  "Income_Pmt_Frequency_SO__c", "Annual_Income_Before_Taxes_SO__c", "Education_Level_SO__c",
  "ConsentFCRA__c", "Consent__c", "User_IP__c",
  "Lead__r.FirstName", "Lead__r.LastName", "Lead__r.Email", "Lead__r.Phone", "Lead__r.MobilePhone",
  "External_Routing_Code__c", "External_Exchange_Status__c",
];

const body = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};

const present = (v) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
const asId = (v) => (typeof v === "string" && SF_ID.test(v.trim()) ? v.trim() : null);

const prospectId = asId(body.Prospect__c);
const submissionId = asId(body.Submission__c);

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

return {
  valid: false,
  reason: present(body.Prospect__c) || present(body.Submission__c) ? "invalid_id" : "no_id",
  source: null,
  prospect_id: null,
  submission_id: null,
  soql: null,
};
