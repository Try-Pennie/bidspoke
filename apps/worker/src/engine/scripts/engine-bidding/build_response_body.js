const pt = steps.prospect_trades.output.body;
const engineBid = pt.engineBid;

// Early rejection: no bid
if (engineBid === 0) {
  return {
    isRejected: true,
    body: {
      lead_id: payload.leadUuid,
      status: 'rejected',
      reason: 'unqualified_lead',
    },
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