const pt = steps.prospect_trades.output.body;
const engineBid = pt.engineBid;

// What patch_prospect_reject writes on a rejection (#1471): the two fields it wrote by
// template today, plus Tripoint's response class when a sale was declined with a result
// code, so Salesforce can tell a duplicate Tripoint already holds from a lead nobody
// wanted. The mapping is the one patch_prospect_body uses on the offer path; a test holds
// the two copies equal. A rejection with no code (a zero bid, a 502 fault) carries the
// two fields alone, which is why this is built here and not by the node's body template:
// a template cannot leave a field out. The node's body is
// {{steps.build_response_body.output.reject_patch}}.
const rejectPatch = (reason, resultCode) => {
  const patch = { BidStatus__c: 'Rejected', RejectionReason__c: reason };
  const rc = resultCode != null ? Number(resultCode) : null;
  if (rc != null) {
    const success   = new Set([1000, 1001, 1013, 1014, 1015, 1016, 1017]);
    const duplicate = new Set([1003, 1004, 1020]);
    if (success.has(rc))         patch.Tripoint_Response__c = 'Success';
    else if (duplicate.has(rc))  patch.Tripoint_Response__c = 'Duplicate';
    else                         patch.Tripoint_Response__c = 'Fail';
  }
  return patch;
};

// Early rejection: no bid
if (engineBid === 0) {
  return {
    isRejected: true,
    body: {
      lead_id: payload.leadUuid,
      status: 'rejected',
      reason: 'unqualified_lead',
    },
    reject_patch: rejectPatch('unqualified_lead', null),
  };
}

// The sale, from whichever node decided it (#1414, Phase 7): tripoint_ping when it ran
// (every lead today; the not_applicable and deferred routes after the cutover), else the
// buyer_select node. A sale that was made and not accepted rejects the lead exactly as
// `qualified === false` does today. While the older tripoint_ping script, which carries no
// `sale`, is still on the canvas, its legacy fields decide, so the two versions can be
// pasted in either order.
const tp = steps.tripoint_ping?.output;
const sale = tp?.sale ?? steps.buyer_select?.output?.sale;
const declined = sale
  ? (!sale.skipped && sale.accepted === false)
  : (tp ? (!tp.skipped && tp.qualified === false) : false);
  if (declined) {
    return {
      isRejected: true,
      body: {
        lead_id: payload.leadUuid,
        status: 'rejected',
        reason: 'unqualified_lead',
      },
      reject_patch: rejectPatch('unqualified_lead', sale ? sale.result_code : (tp?.resultCode ?? null)),
    };
  }

const sellOff           = pt.sellOff;
const altLandingPage    = pt.altLandingPage;
const testOfferLanguage = pt.testOfferLanguage;
const expLandingPage    = pt.expLandingPage;

const formatter    = new Intl.NumberFormat('en-US');
const maxLoanPmt   = formatter.format(pt.maxLoanPmt);
const maxLoanAmt   = formatter.format(pt.maxLoanAmt);
const firstName    = payload.personalInformation.firstName;
const formatedName = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
const annualIncome = formatter.format(payload.financialInformation.annualIncome);

const constants = steps.constants.output;

const getRedirectUrl = () => {
  if (sellOff)         return constants.TripointClickUrl;
  if (expLandingPage)  return constants.pennieExpLandingPage;
  if (altLandingPage)  return constants.pennieAlternateClickUrl;
  return constants.pennieClickUrl;
};
const redirectUrl = getRedirectUrl();

const subAccountIdsMap  = constants.subAccountIdsMap ?? {};
const filteredAccountId = Object.keys(subAccountIdsMap).includes(payload.subAccountUuid);

const defaultOffer = {
  offer_title:   constants.mainOfferTitle,
  offer_details: constants.mainOfferDetails,
};
const sofiSellOffOffer = {
  offer_title:   constants.SofiSellOffOfferTitle,
  offer_details: constants.SofiSellOffOfferDetails,
};
const dynamicSofiOffer = {
  offer_title:   `Good news, ${formatedName}! Based on your income of $${annualIncome}, you may be eligible for income-based financing. Get $${maxLoanAmt} starting at $${maxLoanPmt} - based on income, not just credit.`,
  offer_details: '<ul><li>Terms and rates based on your income</li><li>Approval in minutes, not weeks</li><li>Funding as soon as the next business day</li></ul>',
};
const testOffer = {
  offer_title:   `Good news, ${formatedName}! Based on your income of $${annualIncome}, you may be eligible for income-based financing. Get $${maxLoanAmt} starting at $${maxLoanPmt} - based on income, not just credit.`,
  offer_details: '<ul><li>Terms and rates based on your income</li><li>Approval in minutes, not weeks</li><li>Funding as soon as the next business day</li></ul>',
};

let offer;
if (!filteredAccountId && sellOff === false && testOfferLanguage === true) {
  offer = testOffer;
} else if (filteredAccountId && sellOff === false) {
  offer = dynamicSofiOffer;
} else if (filteredAccountId && sellOff === true) {
  offer = sofiSellOffOffer;
} else {
  offer = defaultOffer;
}

return {
  isRejected: false,
  body: {
    requestId: execution.trace_id,
    offers: [
      {
        name:         constants.offerName,
        display_name: constants.offerName,
        rate:         engineBid,
        click_url:    redirectUrl + `/${steps.create_prospect.output.body.id}`,
        product_type: constants.productType,
        logo_src:     constants.logoSrc,
        ...offer,
      },
    ],
  },
};