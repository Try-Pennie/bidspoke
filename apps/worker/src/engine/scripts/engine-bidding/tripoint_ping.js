// tripoint_ping: engine bidding workflow
// Updated 2026-05-08 to fail-fast on proxy timeouts/5xx and prevent duplicate /create sends.
//
// Changes from previous version:
//   1. Removed the try/catch that swallowed network errors and returned qualified:false silently
//   2. Throw on res.status >= 500 so proxy 504 (Tripoint upstream timeout) surfaces as a step failure
//   3. Removed unused `upstreamError` variable + return field (errors now propagate, engine logs error_message automatically)
//
// Also set in Step settings panel:
//   • Retries: 0   ← critical, prevents duplicate /create sends to Tripoint on transient errors
//
// Updated 2026-09-22 for the buyer_select cutover (#1414, Phase 7). Two fields ADDED,
// nothing removed or reordered, so every downstream reader of the old fields is unchanged:
//   • sale: the outcome in the shape the buyer_select node emits, so build_response_body
//     and patch_prospect_body read one shape whichever node decided the lead.
//   • sent_body_sha256: the hash of exactly what was sent, computed the way the node
//     computes would_send_body_sha256, so the Stage A parity report can compare them.
//     Null when nothing was sent or the sandbox has no Web Crypto (unmeasured, never a
//     wrong hash).
// The kept copy and its tests: apps/worker/src/engine/scripts/engine-bidding/.
// ─────────────────────────────────────────────────────────────────────────────

// The sale in the buyer_select node's shape (#1416): this script IS Tripoint, so the
// winner's facts are Tripoint's own, and build_response_body and patch_prospect_body
// read them from here exactly as they read them from the node for any other buyer.
// The class is the one the node computes from the buyer's rules: Success on an
// accept, Duplicate on a code in Tripoint's duplicate set, Fail on any other code,
// and none when Tripoint gave no code (the two 502 faults).
const tripointSale = (accepted, buyerReference, resultCode) => {
  let response_class = null;
  if (accepted) response_class = 'Success';
  else if (resultCode != null) response_class = [1003, 1004, 1020].includes(Number(resultCode)) ? 'Duplicate' : 'Fail';
  return {
    skipped: false,
    accepted,
    buyer_reference: buyerReference ?? null,
    result_code: resultCode != null ? String(resultCode) : null,
    partner_slug: 'tripoint',
    partner_name: 'Tripoint',
    click_url: accepted ? (steps.constants.output.TripointClickUrl ?? null) : null,
    routing_code: accepted ? 2 : null,
    response_class,
  };
};
const NO_SALE = tripointSale(false, null, null);

const pt = steps.prospect_trades.output.body;

// No-op when not a Tripoint sell-off: bail fast so the rest of the workflow
// behaves identically to the non-Tripoint path.
if (!pt.sellOff || pt.engineBid === 0) {
  return {
    skipped: true, qualified: null, createLead: null, resultCode: null,
    sale: {
      skipped: true, accepted: false, buyer_reference: null, result_code: null, partner_slug: null,
      partner_name: null, click_url: null, routing_code: null, response_class: null,
    },
    sent_body_sha256: null,
  };
}

const proxyPayload = {
  ...payload,
  personalInformation: {
    ...payload.personalInformation,
    ssn: String(payload.personalInformation?.ssn || '').replace(/\D/g, '').slice(0, 9),
  },
  unsecuredDebt: pt.tradeCalculations.engineDebt,
  maxUnsecuredDebt: pt.tradeCalculations.enrollableDebt,
  workflowId: 'engine-bidding',
  pennieLeadId: steps.create_prospect.output.body.id,
  executionId: execution.trace_id,
  leadType: 'prospect',
};

// Same canonical form as packages/buyer-profile payload.ts canonicalBodySha256: object
// keys sorted at every level, arrays kept in order, then JSON, then SHA-256 hex.
let sent_body_sha256 = null;
try {
  const canonicalise = (v) => {
    if (Array.isArray(v)) return v.map(canonicalise);
    if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = canonicalise(v[k]);
      return out;
    }
    return v;
  };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonicalise(proxyPayload))));
  sent_body_sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
} catch {
  sent_body_sha256 = null;
}

let body = {};
let httpStatus = null;
let rawText = null;

const res = await fetch('https://tripoint-proxy.trypennie.dev/leads/create', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${env.TRIPOINT_PROXY_SECRET}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(proxyPayload),
});
httpStatus = res.status;
rawText = await res.text();

// Fail the step on 5xx (proxy 504 = Tripoint upstream timeout) so the
// failure-alert pipeline fires instead of silently treating it as unqualified.
if (res.status >= 500) {
    // Brian's proxy returns 502 when Tripoint's upstream GraphQL has ok:false.
    // The known intermittent fault is `createLead` returning null for a
    // non-nullable id: Tripoint's own schema-contract violation, not anything
    // we sent. Route those leads to the engine fallback (qualified=false) so
    // Engine gets a proper response instead of a 5xx, but keep fail-fast for
    // all other 5xx (real proxy/network/timeout outages).
    let proxyBody = null;
    try { proxyBody = JSON.parse(rawText ?? ''); } catch {}
    const isTripointNullIdFault =
      proxyBody?.ok === false &&
      Array.isArray(proxyBody?.details) &&
      proxyBody.details.some((d) =>
        typeof d?.message === 'string' &&
        d.message.includes('Cannot return null for non-nullable field CreateLeadResponse.id')
      );

    if (isTripointNullIdFault) {
      console.warn('tripoint createLead null id: known transient Tripoint fault, routing to fallback');
      return {
        skipped: false,
        qualified: false,
        createLead: null,
        resultCode: null,
        tripointTransientFault: true,
        debug: { httpStatus, rawText, parsed: proxyBody },
        sale: NO_SALE,
        sent_body_sha256,
      };
    }

    // Tripoint rejects malformed lead data (bad email, phone, etc.) with the same
    // 502 wrapper the proxy uses for real outages. These are business rejections,
    // not infra faults: the lead data is bad and a retry won't help: so route
    // them to the engine fallback (qualified=false, → reject path in
    // build_response_body) instead of failing the whole execution. Keep fail-fast
    // for every other 5xx (genuine proxy/network/timeout outages).
    const rejectionDetail = Array.isArray(proxyBody?.details)
      ? proxyBody.details.find((d) =>
          typeof d?.message === 'string' && /^\s*invalid\b/i.test(d.message)
        )
      : null;
    const isTripointLeadRejection = proxyBody?.ok === false && !!rejectionDetail;

    if (isTripointLeadRejection) {
      const reason = rejectionDetail.message;
      console.warn(`tripoint lead rejected (${reason}): routing to reject path`);
      return {
        skipped: false,
        qualified: false,
        createLead: null,
        resultCode: null,
        tripointLeadRejected: true,
        rejectReason: reason,
        debug: { httpStatus, rawText, parsed: proxyBody },
        sale: NO_SALE,
        sent_body_sha256,
      };
    }

    throw new Error(`Tripoint proxy ${res.status}: ${rawText ?? ''}`);
  }

try {
  body = rawText ? JSON.parse(rawText) : {};
} catch {
  body = {};
}

const createLead = body?.data?.createLead ?? null;
const resultCode = createLead?.resultCode != null ? Number(createLead.resultCode) : null;
const qualified =
  body.ok === true &&
  (resultCode === 1000 || resultCode === 1001 ||
   (resultCode >= 1013 && resultCode <= 1017));

return {
  skipped: false,
  qualified,
  createLead,
  resultCode,
  debug: {
    httpStatus,
    rawText: rawText ?? null,
    parsed: body,
  },
  sale: tripointSale(qualified, createLead?.id ?? null, resultCode),
  sent_body_sha256,
};
