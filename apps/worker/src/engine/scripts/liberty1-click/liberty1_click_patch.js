// What the Liberty1 click writes to Salesforce, from buyer_click_send's route
// (#1545): Brian's three update bodies (Submission, Prospect, Lead), unchanged
// in fields and order.
//
// Completed only on `sent` (Liberty1 confirmed it created the record) and Fail
// only on `refused` (Liberty1 turned it down with its own error). Every other
// route writes NOTHING: `unknown` means nobody knows whether Liberty1 created the record, and the rest never sent. write false is what the check_write
// branch reads to skip every update node.
//
// Undefined values are dropped so nothing is blanked. PDFlow_3__c, where his
// flow wrote the Pipedream inspect URL, carries this run's Bidspoke link.
//
// The answer for the portal is `reply`, never `response`: the engine reads a
// code node's returned `response` object as $.respond() and ends the walk there,
// which on 2026-09-29 stopped the first live click before its Salesforce writes.
const PARTNER_NAME = "Liberty1";
const ROUTING_CODE = 4; // Number on Prospect, Text on Submission/Lead
const LEAD_SALE_TYPE = "Form";
const LIBERTY1_TCPA = `By clicking "Connect with Liberty1 Financial": I expressly agree to Liberty1 Financial's TCPA consent below, Terms & Conditions, Privacy Policy, and Consent for Electronic Communications.

I expressly provide my consent to receive marketing calls and texts/SMS regarding personal loan and debt consolidation products from Clear Vision Financial LLC, doing business as Liberty1 Financial, at the phone number I provided, including via an automatic telephone dialing system or an artificial, prerecorded, or AI-generated voice, even if my number is on a federal, state, or company Do-Not-Call list. I understand that my consent is not a condition of purchasing any goods or services and that my consent may be revoked at any time, such as by replying "STOP" to opt out of SMS or by telling Liberty1 Financial to stop on any call. I also acknowledge that Liberty1 Financial's Terms & Conditions include a Jury Trial Waiver, Class Action Waiver, and Arbitration Agreement, and, if I am a California resident, that the California Privacy Notice describes my privacy rights. Message and data rates may apply, and message frequency varies.

Text HELP for help or text STOP to cancel.`;

const EXCHANGE_STATUS_BY_ROUTE = { sent: "Completed", refused: "Fail" };

const click = steps.click_send?.output ?? {};
const route = typeof click._route === "string" ? click._route : "not_run";
const exchangeStatus = EXCHANGE_STATUS_BY_ROUTE[route] ?? null;

if (exchangeStatus === null) {
  return {
    write: false,
    exchange_status: null,
    prospect: null,
    submission: null,
    lead: null,
    reply: { success: false, outcome: route },
  };
}

const dropUndefined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const partnerLeadId = route === "sent" && click.partner_lead_id ? click.partner_lead_id : undefined;
const now = new Date().toISOString();
const link = execution?.bidspoke_link || undefined;

return {
  write: true,
  exchange_status: exchangeStatus,
  prospect: dropUndefined({
    ExternalExchangeStatus__c: exchangeStatus,
    ExternalPartnerLeadId__c: partnerLeadId,
    ExternalPartnerName__c: PARTNER_NAME,
    ExternalRoutingCode__c: ROUTING_CODE,
    TCPA_Consent__c: LIBERTY1_TCPA,
    ExternalTimestamp__c: now,
    PDFlow_3__c: link,
    LeadSaleType__c: LEAD_SALE_TYPE,
  }),
  submission: dropUndefined({
    External_Exchange_Status__c: exchangeStatus,
    External_Partner_Lead_Id__c: partnerLeadId,
    External_Partner_Name__c: PARTNER_NAME,
    External_Routing_Code__c: String(ROUTING_CODE),
    External_TCPA_Consent__c: LIBERTY1_TCPA,
    External_Timestamp__c: now,
    PDFlow_3__c: link,
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
  reply: { success: route === "sent", outcome: route },
};
