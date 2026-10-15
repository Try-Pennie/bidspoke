const gigfiData = steps.ping_gigfi.output.data.data;
const gigfiResult = gigfiData.status;
const gigfiBid = gigfiData.bid_amount;
const constants = steps.constants.output;
const subAccountUuid = payload.subAccountUuid;

const floor = constants.GigfiSubAccountMinBids?.[subAccountUuid];

// Shared values used by the patch_applicant_* Salesforce Update nodes.
// (Templates can't do math / ?? / || / dynamic keys, so we compute here.)
const patch = {
  externalPartnerBid: gigfiBid ?? null,
  minBidAmt: (gigfiData && gigfiData.min_bid_value != null) ? gigfiData.min_bid_value : floor,
  redirectUrl: gigfiData && gigfiData.redirect_url,
  rejectionReason: gigfiData && gigfiData.rejection_reason,
  ts: new Date().toISOString(),
};

// --- unqualified ---
if (!Number(gigfiBid) || Number(gigfiBid) <= 0 || gigfiResult !== "ACCEPTED") {
  const reason = "unqualified_lead";
  return {
    body: { lead_id: payload.leadUuid, status: "rejected", reason },
    ...patch,
    lsRejectionReason: patch.rejectionReason || reason,
  };
}

// --- below threshold ---
if (floor !== undefined && Number(gigfiBid) < floor) {
  const reason = "bid_below_threshold";
  return {
    body: { lead_id: payload.leadUuid, status: "rejected", reason },
    ...patch,
    lsRejectionReason: patch.rejectionReason || reason,
  };
}

// --- offer (BID) ---
const bidAmount = gigfiBid * constants.multiplier;

// The hosts that get the link token (#2092): the block below signs a link to these only.
const LINK_TOKEN_HOSTS = ['trypennie.com', 'www.trypennie.com', 'reservemyloan.com'];
// BEGIN link token (#2089)
// trypennie.com refuses a link to a Salesforce record created after its cutoff unless the
// link carries ?t=<token>: HMAC-SHA256 of the first 15 characters of the record id, keyed
// with LINK_TOKEN_SECRET, base64url with no padding, and reservemyloan.com is to check the
// same token. Salesforce's LinkToken class and the Pipedream helpers sign exactly the same
// way. Only a host in LINK_TOKEN_HOSTS, which each script sets just above this block, gets
// the token, never a partner's domain. With no secret the link goes out unsigned, an error
// is logged and `link_token` on this step's output says why; the run is never failed for
// it. This block is identical in every script that signs a link, and link-token.test.ts
// holds them all to one text (#2092).
const SALESFORCE_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const withLinkToken = async (url, recordId) => {
  let host = null;
  try { host = new URL(url).hostname; } catch {}
  if (!LINK_TOKEN_HOSTS.includes(host)) return { url, link_token: 'not_our_host' };
  if (typeof recordId !== 'string' || !SALESFORCE_ID.test(recordId)) return { url, link_token: 'no_record_id' };
  const secret = env.LINK_TOKEN_SECRET;
  if (typeof secret !== 'string' || !secret) {
    console.error('LINK_TOKEN_SECRET is not set, so the link went out without its token (#2089)');
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
    console.error(`signing the link failed, so it went out without its token (#2089): ${err && err.message}`);
    return { url, link_token: 'sign_failed' };
  }
};
// END link token (#2089)

const applicantId = steps.create_applicant.output.body.id;
const offerLink = await withLinkToken(constants.pennieClickUrl + `/${applicantId}`, applicantId);
return {
  body: {
    requestId: execution.trace_id,
    offers: [
      {
        name: constants.offerName,
        display_name: constants.offerName,
        rate: bidAmount,
        click_url: offerLink.url,
        product_type: constants.productType,
        logo_src: constants.logoSrc,
        offer_title: constants.offerTitle,
        offer_details: constants.offerDetails,
      },
    ],
  },
  ...patch,
  bidAmount,
  link_token: offerLink.link_token,
};
