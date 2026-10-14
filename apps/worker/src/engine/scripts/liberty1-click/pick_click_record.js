// Which record a Liberty1 click sends, and whether it may be sent (#1547). Reads
// the one row query_record returned for resolve_input's query.
//
// A Prospect__c click, or a Submission__c whose Prospect__r came back, is judged
// on the PROSPECT: open only with Liberty1's routing code 4 and status Bid, which
// the Engine Bidding offer writes, and completed when that offer is already
// Completed. Anything else was never offered Liberty1.
//
// A Submission with NO Prospect is TRUSTED (Dan, 2026-09-29): nothing writes a
// Liberty1 offer onto a Submission before the click, so there is no mark to
// check, and it is sent from the submission itself with Brian's mapping below.
// A submission already Completed is never sent: for Liberty1 (code 4) it is
// answered already sent, and for any other buyer it is refused as no Liberty1
// offer (Dan, 2026-09-29), as a prospect sold elsewhere is, so one person is not
// sold twice. The claim in click_send keys it on the submission id, so a repeat
// click is never sent twice.
//
// A Submission that names a Prospect the query could not return is not found
// as a prospect, never sent from the submission instead. When a Prospect__c was
// posted with the Submission__c, the submission must belong to that prospect,
// or the click is refused as submission_not_for_prospect and nothing is sent.
const OFFER_CODE = "4";

// Map a Submission onto the Prospect field names so buildPayload() handles both
// (Brian's submissionAsProspect, verbatim but for EngineDebt__c, ours, #2110).
function submissionAsProspect(s) {
  const lead = s.Lead__r || {};
  return {
    Id: s.Id,
    SubaccountName__c: s.FundedDemandSubAccountName__c ?? s.Source__c,
    SubaccountUUID__c: s.SubaccountUUID__c ?? s.Prospect_Subaccount_UUID__c,
    First_Name__c: s.FirstNameSO__c ?? lead.FirstName,
    Last_Name__c: s.LastNameSO__c ?? lead.LastName,
    Email__c: s.Email_SO__c ?? lead.Email,
    Phone__c: lead.MobilePhone ?? lead.Phone ?? s.Home_Phone__c,
    Street__c: s.StreetSO__c,
    AptSuite__c: s.Apt_Suite_SO__c,
    City__c: s.City_SO__c,
    State__c: s.State_SO__c,
    Zip__c: s.Zip_Code_SO__c,
    BirthDate__c: s.Date_of_Birth_SO__c,
    SocialSecurityNumber__c: s.Social_Security_Number_SO__c,
    LoanPurpose__c: s.Loan_Purpose_SO__c,
    LoanAmount__c: s.Loan_Amount_SO__c,
    RentOrOwn__c: s.Rent_or_Own_SO__c,
    ApproximateCreditRating__c: s.Approximate_Credit_Rating_SO__c,
    EmploymentStatus__c: s.Employment_Status_SO__c,
    IncomePmtFrequency__c: s.Income_Pmt_Frequency_SO__c,
    AnnualIncomeBeforeTaxes__c: s.Annual_Income_Before_Taxes_SO__c,
    EducationLevel__c: s.Education_Level_SO__c,
    FCRAConsentFlag__c: s.ConsentFCRA__c,
    TCPAConsentFlag__c: s.Consent__c,
    User_IP__c: s.User_IP__c,
    EngineDebt__c: s.EngineDebt__c,
  };
}

const isOffer = (code) => code !== null && code !== undefined && String(code) === OFFER_CODE;
const prospectVerdict = (p) => {
  if (!isOffer(p.ExternalRoutingCode__c)) return "no_offer";
  if (p.ExternalExchangeStatus__c === "Completed") return "completed";
  if (p.ExternalExchangeStatus__c === "Bid") return "open";
  return "no_offer";
};
const idOf = (v) => (typeof v === "string" && v.trim() !== "" ? v : null);

const source = steps.resolve_input?.output?.source;
if (source !== "prospect" && source !== "submission") {
  throw new Error(`pick_record: resolve_input named no source (${JSON.stringify(source ?? null)}), so the row cannot be read as either object`);
}

const row = steps.query_record?.output?.body?.records?.[0] ?? null;
const notFound = (what) => ({
  verdict: "not_found",
  not_found_outcome: what,
  offer: null,
  record: null,
  prospect_id: null,
  submission_id: null,
  lead_id: null,
  sale_key: null,
});

if (!row || !idOf(row.Id)) return notFound(source === "prospect" ? "prospect_not_found" : "submission_not_found");

if (source === "prospect") {
  return {
    verdict: prospectVerdict(row),
    not_found_outcome: null,
    offer: "on_record",
    record: row,
    prospect_id: row.Id,
    submission_id: null,
    lead_id: null,
    sale_key: row.Id,
  };
}

const leadId = idOf(row.Lead__c);

// Salesforce ids compare on their first 15 characters (the 18 character form
// adds a case checksum), so a 15 and an 18 character id for one record agree.
const sameId = (a, b) => typeof a === "string" && typeof b === "string" && a.slice(0, 15) === b.slice(0, 15);
const postedProspect = idOf(steps.resolve_input?.output?.prospect_id);
if (postedProspect && !sameId(row.Prospect__c, postedProspect)) return notFound("submission_not_for_prospect");

if (idOf(row.Prospect__c)) {
  const prospect = row.Prospect__r;
  if (!prospect || !idOf(prospect.Id)) return notFound("prospect_not_found");
  return {
    verdict: prospectVerdict(prospect),
    not_found_outcome: null,
    offer: "on_record",
    record: prospect,
    prospect_id: prospect.Id,
    submission_id: row.Id,
    lead_id: leadId,
    sale_key: prospect.Id,
  };
}

const sold = row.External_Exchange_Status__c === "Completed";
const soldToLiberty1 = sold && isOffer(row.External_Routing_Code__c);
return {
  verdict: soldToLiberty1 ? "completed" : sold ? "no_offer" : "open",
  not_found_outcome: null,
  offer: "trusted",
  record: submissionAsProspect(row),
  prospect_id: null,
  submission_id: row.Id,
  lead_id: leadId,
  sale_key: row.Id,
};
