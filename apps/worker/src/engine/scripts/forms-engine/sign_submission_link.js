// Builds the submit link the agent's Slack message carries (#2092). trypennie.com refuses
// it for a submission created after its cutoff unless it carries the link token, and a
// webhook node cannot sign, so this node signs it and send_to_slack_agent sends
// steps.sign_submission_link.output.url.
// The hosts that get the link token (#2092): the block below signs a link to these only.
const LINK_TOKEN_HOSTS = ['trypennie.com', 'www.trypennie.com'];
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

const submissionId = trigger.payload.Submission__c ?? '';
const submissionLink = await withLinkToken(`https://trypennie.com/submit?submission_id=${submissionId}`, submissionId);
return { url: submissionLink.url, link_token: submissionLink.link_token };
