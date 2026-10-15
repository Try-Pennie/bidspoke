const pt = steps.prospect_trades.output.body;
const engineBid = pt.engineBid;

// The sale, from whichever node decided it (#1414, Phase 7): tripoint_ping when it ran
// (every lead today; the not_applicable and deferred routes after the cutover), else the
// buyer_select node. It carries the winner's own facts (#1416): who bought, where the lead
// lands, the Salesforce routing code and the Success, Duplicate or Fail class, so nothing
// below holds a Tripoint literal. The sale is published on this step's output as `sale`,
// and patch_prospect_body reads it from there: one normalised shape, read in one place.
//
// TRANSITIONAL, removed with tripoint_ping at Stage C: an older tripoint_ping on the canvas
// carries either no `sale` (the script before 2026-09-22) or a `sale` without the winner
// facts (the Stage A script). Both are Tripoint, so they are completed with Tripoint's own
// values here, and Tripoint's result code classes are mapped here for them, the only copy
// of that mapping outside tripoint_ping itself.
// Its duplicate codes are TRIPOINT_DUPLICATE_RESULT_CODES in bid-resolver.ts (#1549).
const readSale = () => {
  const tp = steps.tripoint_ping?.output;
  let sale = tp?.sale ?? steps.buyer_select?.output?.sale ?? null;
  if (!sale && tp) {
    sale = {
      skipped: tp.skipped === true,
      accepted: tp.qualified === true,
      buyer_reference: tp.createLead?.id ?? null,
      result_code: tp.resultCode != null ? String(tp.resultCode) : null,
      partner_slug: tp.skipped === true ? null : 'tripoint',
    };
  }
  if (!sale) return null;
  if (sale.partner_slug === 'tripoint' && sale.response_class === undefined) {
    const rc = sale.result_code != null ? Number(sale.result_code) : null;
    let response_class = null;
    if (sale.accepted) response_class = 'Success';
    else if (rc != null) response_class = [1002, 1003, 1004, 1005, 1020].includes(rc) ? 'Duplicate' : 'Fail';
    sale = {
      ...sale,
      partner_name: 'Tripoint',
      click_url: sale.accepted ? (steps.constants.output.TripointClickUrl ?? null) : null,
      routing_code: sale.accepted ? 2 : null,
      response_class,
    };
  }
  return sale;
};
const sale = readSale();

// What patch_prospect_reject writes on a rejection (#1471): the two fields it wrote by
// template today, plus the class of a declined sale, so Salesforce can tell a duplicate the
// buyer already holds from a lead nobody wanted. The class is the sale's own (#1416).
// Tripoint_Response__c is Tripoint's field, so it is written only when Tripoint declined;
// Salesforce has no field for another buyer's class yet. A rejection with no class (a zero
// bid, a 502 fault, a buyer error) carries the two fields alone, which is why this is
// built here and not by the node's body template: a template cannot leave a field out.
// The node's body is {{steps.build_response_body.output.reject_patch}}.
const rejectPatch = (reason, s) => {
  const patch = { BidStatus__c: 'Rejected', RejectionReason__c: reason };
  if (s && s.partner_slug === 'tripoint' && s.response_class) patch.Tripoint_Response__c = s.response_class;
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
    sale,
  };
}

// A click sold buyer on a KNOWN no (#1544): when the known_no_gate node said the node
// that decided this lead gave a known no, and the buyer_click_check node routed eligible,
// the lead is offered to that buyer instead of rejected. The buyer is sold when the lead
// clicks, not now. Every fact about the buyer (its slug, name, landing page and
// Salesforce routing code) comes from the check's output, so no buyer is named here and
// a second click buyer needs no script change. The check's click URL carries the
// placeholder {prospect_id}, replaced by the created prospect's id.
//
// `click_offer` records the decision whenever the gate ran, offered or not, with the
// reason; without the gate node on the canvas nothing here runs. A lead the deciding node
// sold is never offered again, whatever the gate says.
const readClickOffer = () => {
  const gate = steps.known_no_gate?.output;
  if (!gate) return null;
  const check = steps.buyer_click_check?.output ?? null;
  const decision = { known_no: gate.known_no === true, check_route: check?._route ?? null, offered: false, reason: null };
  const refuse = (reason) => ({ decision: { ...decision, reason }, sale: null });
  if (!decision.known_no) return refuse('not_a_known_no');
  if (sale && sale.accepted === true) return refuse('sold_by_deciding_node');
  if (!check) return refuse('check_not_run');
  if (check._route !== 'eligible') return refuse(check.reason ?? 'not_eligible');
  if (typeof check.partner_slug !== 'string' || !check.partner_slug) return refuse('check_names_no_buyer');
  if (typeof check.click_url !== 'string' || !check.click_url) return refuse('no_click_url');
  if (!check.click_url.includes('{prospect_id}')) return refuse('click_url_has_no_prospect_id');
  const prospectId = steps.create_prospect?.output?.body?.id;
  if (!prospectId) return refuse('no_prospect_id');
  return {
    decision: { ...decision, offered: true, reason: 'offered' },
    sale: {
      skipped: false,
      accepted: true,
      buyer_reference: null,
      result_code: null,
      partner_slug: check.partner_slug,
      partner_name: check.partner_name ?? null,
      click_url: check.click_url.split('{prospect_id}').join(String(prospectId)),
      routing_code: check.external_routing_code ?? null,
      response_class: null,
      sold_on: 'click',
    },
  };
};
const clickOffer = readClickOffer();
const clickSale = clickOffer ? clickOffer.sale : null;
// The deciding node's own decline, kept beside the click sale so the prospect patch still
// records Tripoint's class (#1544).
const declinedSale = clickSale ? sale : null;
const offerSale = clickSale ?? sale;
const withClick = (out) => {
  if (clickOffer) out.click_offer = clickOffer.decision;
  if (declinedSale) out.declined_sale = declinedSale;
  return out;
};

// A sale that was made and not accepted rejects the lead exactly as `qualified === false`
// did before the node existed.
const declined = offerSale ? (!offerSale.skipped && offerSale.accepted === false) : false;
  if (declined) {
    return withClick({
      isRejected: true,
      body: {
        lead_id: payload.leadUuid,
        status: 'rejected',
        reason: 'unqualified_lead',
      },
      reject_patch: rejectPatch('unqualified_lead', sale),
      sale,
    });
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

// A sold lead lands where the winner says (#1416); before this a sell off lead was sent to
// Tripoint's constant whether or not Tripoint had taken it. A sell off lead nobody bought
// now takes the Pennie pages below, which is where a lead with no sale belongs.
const getRedirectUrl = () => {
  if (offerSale && offerSale.accepted && offerSale.click_url) return offerSale.click_url;
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

// BEGIN link token (#2089)
// trypennie.com refuses a link to a Salesforce record created after its cutoff unless the
// link carries ?t=<token>: HMAC-SHA256 of the first 15 characters of the record id, keyed
// with LINK_TOKEN_SECRET, base64url with no padding. Salesforce's LinkToken class and the
// Pipedream helper sign exactly the same way. Only our own site gets the token, never a
// partner's domain. With no secret the link goes out unsigned and `link_token` on this
// step's output says why; the bid is never failed for it. This block is identical in
// Engine Bidding's build_response_body and Lead Economy's return_response, and
// link-token.test.ts holds the two to one text.
const LINK_TOKEN_HOSTS = ['trypennie.com', 'www.trypennie.com'];
const SALESFORCE_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const withLinkToken = async (url, recordId) => {
  let host = null;
  try { host = new URL(url).hostname; } catch {}
  if (!LINK_TOKEN_HOSTS.includes(host)) return { url, link_token: 'not_our_host' };
  if (typeof recordId !== 'string' || !SALESFORCE_ID.test(recordId)) return { url, link_token: 'no_record_id' };
  const secret = env.LINK_TOKEN_SECRET;
  if (typeof secret !== 'string' || !secret) {
    console.warn('LINK_TOKEN_SECRET is not set, so the offer link went out without its token (#2089)');
    return { url, link_token: 'missing_secret' };
  }
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(recordId.slice(0, 15))));
    let binary = '';
    for (const byte of signature) binary += String.fromCharCode(byte);
    const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { url: `${url}${url.includes('?') ? '&' : '?'}t=${token}`, link_token: 'signed' };
  } catch (err) {
    console.error(`signing the offer link failed, so it went out without its token (#2089): ${err && err.message}`);
    return { url, link_token: 'sign_failed' };
  }
};
// END link token (#2089)

const prospectId = steps.create_prospect.output.body.id;
// A click sale's landing page already carries the prospect id (#1544).
const offerLink = await withLinkToken(clickSale ? redirectUrl : redirectUrl + `/${prospectId}`, prospectId);

return withClick({
  isRejected: false,
  body: {
    requestId: execution.trace_id,
    offers: [
      {
        name:         constants.offerName,
        display_name: constants.offerName,
        rate:         engineBid,
        click_url:    offerLink.url,
        product_type: constants.productType,
        logo_src:     constants.logoSrc,
        ...offer,
      },
    ],
  },
  sale: offerSale,
  link_token: offerLink.link_token,
});