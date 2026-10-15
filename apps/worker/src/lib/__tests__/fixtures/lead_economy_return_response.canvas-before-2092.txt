const pt = steps.prospect_trades.output.body;
const engineBid = pt.engineBid;

const rejectBody = {
  lead_id: payload.leadId1,
  status: "rejected",
  reason: "unqualified_lead",
};

if (engineBid === 0) {
  return { response: { status: 200, body: rejectBody }, continueExecution: true, isRejected: true };
}

let tripointResult = null;
if (pt.sellOff) {
  const proxyPayload = {
    ...payload,
    unsecuredDebt: pt.tradeCalculations.engineDebt,
    maxUnsecuredDebt: pt.tradeCalculations.enrollableDebt,
    workflowId: 'am-one-bidding',
    pennieLeadId: steps.create_prospect.output.body.id,
    executionId: execution.trace_id,
    leadType: 'prospect',
  };

  const res = await fetch('https://tripoint-proxy.trypennie.dev/leads/create', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.TRIPOINT_PROXY_SECRET}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(proxyPayload),
  });
  const rawText = await res.text();
  let body = {};
  try { body = rawText ? JSON.parse(rawText) : {}; } catch {}
  const createLead = body?.data?.createLead ?? null;
  const resultCode = Number(createLead?.resultCode);
  const qualified =
    body.ok === true &&
    (resultCode === 1000 || resultCode === 1001 || (resultCode >= 1013 && resultCode <= 1017));

  console.log(`createLead resultCode=${resultCode} qualified=${qualified}`);
  tripointResult = { qualified, createLead, resultCode };

  if (!tripointResult.qualified) {
    return { response: { status: 200, body: rejectBody }, continueExecution: true, isRejected: true, tripointResult };
  }
}

const constants = steps.constants.output;

let redirectUrl;
if (pt.sellOff)              redirectUrl = constants.tripointClickUrl;
else if (pt.expLandingPage)  redirectUrl = constants.pennieExpLandingPage;
else if (pt.altLandingPage)  redirectUrl = constants.pennieAlternateClickUrl;
else                         redirectUrl = constants.pennieClickUrl;

const fmt = new Intl.NumberFormat('en-US');
const firstName = payload.personalInformation.firstName;
const formattedName = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
const annualIncome = fmt.format(payload.financialInformation.annualIncome);
const maxLoanPmt = fmt.format(pt.maxLoanPmt);
const maxLoanAmt = fmt.format(pt.maxLoanAmt);

const dynamicOfferContent = {
  offer_title: `${formattedName}, you may qualify for up to $${maxLoanAmt} starting at $${maxLoanPmt}/mo.`,
  offer_details: "<ul><li>Terms and rates based on your income</li><li>Approval in minutes, not weeks</li><li>Funding as soon as the next business day</li></ul>",
};

let offer;
if (pt.sellOff) {
  offer = { offer_title: constants.sellOffOfferTitle, offer_details: constants.sellOffOfferDetails };
} else if (pt.testOfferLanguage) {
  offer = dynamicOfferContent;
} else {
  offer = { offer_title: constants.mainOfferTitle, offer_details: constants.mainOfferDetails };
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
const offerLink = await withLinkToken(`${redirectUrl}/${prospectId}`, prospectId);

const responseBody = {
  requestId: execution.trace_id,
  offers: [{
    name: constants.offerName,
    display_name: constants.offerName,
    rate: engineBid,
    click_url: offerLink.url,
    product_type: constants.productType,
    logo_src: constants.logoSrc,
    ...offer,
  }],
};

const respondedAt = new Date().toISOString();
return { response: { status: 200, body: responseBody }, continueExecution: true, isRejected: false, tripointResult, respondedAt, link_token: offerLink.link_token };
