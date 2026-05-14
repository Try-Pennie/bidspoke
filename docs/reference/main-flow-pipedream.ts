// Pennie Main Flow — Pipedream custom action (parity source-of-truth).
//
// This is the inbound form-lead flow as it ran on Pipedream as of 2026-05-14.
// Captured here so the Bidspoke canvas migration (TODO 4.x) can be diffed
// against it byte-for-byte. New logic vs the pre-AmOne version:
//   - Parallel race between AmOne ping (returns bid + click URL) and
//     Tripoint createLead (eligibility-gated, comparison bid is formula-
//     derived from finalDebt × tripointMultiplier) with a 5s deadline.
//   - Engine fallback covers 4 reasons: no-debt, low-debt, state-not-allowed,
//     no-bids.
//   - SF webhook target eocv5xd49efymsn.m.pipedream.net (Pipedream-hosted
//     SF proxy) fires AFTER the HTTP response to the client.
//   - Submission UUID cached `submissionId → engineUUID` for 7 days in a
//     Pipedream data store.

// src/helpers.ts
function isStateAllowed(steps) {
  const { states } = steps.constants.$return_value;
  return !states.includes(steps.trigger.event.body.personalInformation.state);
}
function pickEngineEndpoint(steps) {
  return steps.constants.$return_value.epcThroughEngine ? "/epc/leads/rate-tables" : "/leads/rate-tables";
}
async function respondToClient(respond, steps, status, body) {
  await respond({
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Submission-Id": steps.trigger.event.body.Submission__c
    },
    body
  });
}
function buildSubmissionBase(steps) {
  const { traceId, submissionDate } = steps.constants.$return_value;
  return {
    submissionId: steps.trigger.event.body.Submission__c,
    PDFlow_1__c: `https://pipedream.com/@penniefinancial/projects/proj_YRsogdx/test-main-flow-refactor-p_6lCVwx9/inspect/${traceId}`,
    External_Timestamp__c: submissionDate,
    executionId: steps.trigger.context.id,
    PD_Completed_Timestamp__c: (/* @__PURE__ */ new Date()).toISOString().slice(0, 19)
  };
}
function buildBaseSfBody(steps, engineData) {
  return {
    ...buildSubmissionBase(steps),
    leadUUID: engineData.leadUuid,
    UUID: engineData.uuid
  };
}

// src/sf-webhook.ts
var SALESFORCE_WEBHOOK_URL = "https://eocv5xd49efymsn.m.pipedream.net";
async function postToSalesforceWebhook(body, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  console.log("[sf-webhook] request", JSON.stringify({ url: SALESFORCE_WEBHOOK_URL, body }));
  const res = await fetchImpl(SALESFORCE_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const responseBody = await res.json().catch(() => null);
  console.log(
    "[sf-webhook] response",
    JSON.stringify({ status: res.status, ok: res.ok, body: responseBody })
  );
  return { ok: res.ok, status: res.status, body: responseBody };
}

// src/am-one/am-one-winner.ts
async function runAmOneWinner(steps, deps, amOneBid, clickUrl, tripointResult) {
  const triggerBody = steps.trigger.event.body;
  const eligibilityResult = steps.pennie_or_eligibility?.$return_value ?? null;
  const eligibilityData = eligibilityResult?.eligibilityData ?? null;
  const eligibility = eligibilityResult?.eligibility ?? null;
  const equifaxSuccess = (eligibilityResult?.equifax ?? null) !== null;
  const estimatedDebt = eligibilityResult?.final ?? null;
  const adv = steps.mutate_adv.$return_value ?? null;
  const bes = steps.mutate_bes.$return_value ?? null;
  const leg = triggerBody.LEG;
  const vantageScore = steps.gen_vantage_score.$return_value ?? null;
  const creditPullResult = eligibilityData != null ? eligibility ? "Success" : "Fail" : void 0;
  const sfBody = {
    ...buildSubmissionBase(steps),
    External_Exchange_Status__c: "Pending",
    External_Partner_Name__c: "AmOne",
    External_Routing_Code__c: 3,
    Monthly_Creditor_Payment_ES__c: eligibilityData?.estimated_monthly_creditor_payment ?? null,
    Unsecured_Debt_Verified_ES__c: eligibilityData?.estimated_total_debt ?? null,
    ADV_SO__c: adv,
    XBC_SO__c: `${adv}${bes}${leg}`,
    EQXCreditPullStatus__c: equifaxSuccess ? "Success" : "Fail",
    LeadSaleType__c: "Form",
    VantageScore__c: vantageScore,
    AmOneBid__c: amOneBid,
    AmOneClickURL__c: clickUrl,
    Tripoint_Response__c: tripointResult,
    ...creditPullResult !== void 0 && { Credit_Pull_Result_ES__c: creditPullResult }
  };
  const clientBody = {
    unsecuredDebtVerified: false,
    ADV: adv,
    XBC: `${adv}${bes}${leg}`,
    routingPartner: 3,
    estimatedTotalDebt: estimatedDebt
  };
  await respondToClient(deps.respond, steps, 200, clientBody);
  const salesforceResponse = await postToSalesforceWebhook(sfBody, { fetchImpl: deps.fetchImpl });
  return { status: 200, body: clientBody, salesforceResponse };
}

// src/am-one/am-one-proxy.ts
var AM_ONE_PROXY_BASE_URL = "https://am-one-proxy.trypennie.dev";
function extractAmOneBid(body) {
  if (!body || body.ok !== true) return null;
  const data = body.data;
  if (!data || data.Status !== "Success") return null;
  const raw = typeof data.bid === "string" ? data.bid.trim() : data.bid;
  if (raw === "" || raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
async function callAmOneProxy(payload, opts) {
  const { baseUrl, sharedSecret, endpoint = "/leads/ping", fetchImpl = fetch, signal } = opts;
  const url = `${baseUrl.replace(/\/$/, "")}${endpoint}`;
  console.log("[am-one-proxy] request", JSON.stringify({ url, payload }));
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${sharedSecret}`
    },
    body: JSON.stringify(payload),
    signal
  });
  const body = await res.json().catch(() => null);
  console.log(
    "[am-one-proxy] response",
    JSON.stringify({ status: res.status, ok: res.ok, body })
  );
  return { ok: res.ok, status: res.status, body };
}

// src/tripoint/tripoint-proxy.ts
var TRIPOINT_PROXY_BASE_URL = "https://tripoint-proxy.trypennie.dev";
var ACCEPTED_TRIPOINT_RESULT_CODES = /* @__PURE__ */ new Set([
  1e3,
  1001,
  1013,
  1014,
  1015,
  1016,
  1017
]);
function isAcceptedTripointResultCode(code) {
  return typeof code === "number" && ACCEPTED_TRIPOINT_RESULT_CODES.has(code);
}
function isDuplicateTripointResultCode(code) {
  return typeof code === "number" && (code >= 1002 && code <= 1005 || code === 1020);
}
function classifyTripointResult(body) {
  if (!body || body.ok !== true) return "Fail";
  const lead = body.data.createLead;
  if (!lead) return "Fail";
  if (isDuplicateTripointResultCode(lead.resultCode)) return "Duplicate";
  if (isAcceptedTripointResultCode(lead.resultCode)) return "Success";
  return "Fail";
}
function extractTripointBid(body) {
  if (!body || body.ok !== true) return null;
  const lead = body.data.createLead;
  if (!lead || !isAcceptedTripointResultCode(lead.resultCode)) return null;
  const v = lead.bidValue;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
async function callTripointProxy(payload, opts) {
  const { baseUrl, sharedSecret, endpoint = "/leads/create", fetchImpl = fetch, signal } = opts;
  const url = `${baseUrl.replace(/\/$/, "")}${endpoint}`;
  console.log("[tripoint-proxy] request", JSON.stringify({ url, payload }));
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${sharedSecret}`
    },
    body: JSON.stringify(payload),
    signal
  });
  const body = await res.json().catch(() => null);
  console.log("[tripoint-proxy] response", JSON.stringify({ status: res.status, ok: res.ok, body }));
  return { ok: res.ok, status: res.status, body };
}

// src/bids/bid-race.ts
async function raceBids(factories, opts) {
  const setT = opts.setTimeoutImpl ?? setTimeout;
  const controllers = factories.map(() => new AbortController());
  const results = [];
  const tasks = factories.map(
    (f, i) => f(controllers[i].signal).then((value) => {
      results.push(value);
    }).catch(() => {
    })
  );
  const allDone = Promise.all(tasks).then(() => "all");
  let deadlineHandle;
  const deadline = new Promise((r) => {
    deadlineHandle = setT(() => r("deadline"), opts.deadlineMs);
  });
  const winner = await Promise.race([allDone, deadline]);
  if (winner === "deadline") {
    console.log("[bid-race] deadline hit; aborting pending bids", {
      deadlineMs: opts.deadlineMs,
      resultsAtDeadline: results.length,
      totalFactories: factories.length
    });
    controllers.forEach((c) => c.abort());
    return { results, timedOut: true };
  }
  if (deadlineHandle !== void 0) clearTimeout(deadlineHandle);
  return { results, timedOut: false };
}

// src/bids/collect.ts
var BID_DEADLINE_MS = 5e3;
async function collectBids(steps, deps) {
  const triggerBody = steps.trigger.event.body;
  const { skipAmOne } = steps.constants.$return_value;
  const { results } = await raceBids(
    [
      async (signal) => {
        if (skipAmOne) {
          console.log("[bids] skipping AmOne (skipAmOne=true)");
          return { label: "amOne", bid: null, clickUrl: null };
        }
        try {
          const r = await callAmOneProxy(triggerBody, {
            baseUrl: AM_ONE_PROXY_BASE_URL,
            sharedSecret: deps.amOneProxySharedSecret,
            fetchImpl: deps.fetchImpl,
            signal
          });
          const body = r.body;
          const bid = extractAmOneBid(body);
          const successData = body && body.ok === true ? body.data : null;
          const clickUrl = bid !== null && typeof successData?.ClickThrough_url === "string" ? successData.ClickThrough_url : null;
          return { label: "amOne", bid, clickUrl };
        } catch (err) {
          console.error("[bids] amOne factory threw; treating as no-bid", err);
          return { label: "amOne", bid: null, clickUrl: null };
        }
      },
      async (signal) => {
        try {
          const r = await callTripointProxy(triggerBody, {
            baseUrl: TRIPOINT_PROXY_BASE_URL,
            sharedSecret: deps.tripointProxySharedSecret,
            fetchImpl: deps.fetchImpl,
            signal
          });
          const body = r.body;
          const bid = extractTripointBid(body);
          const result = classifyTripointResult(body);
          const leadId = (result === "Success" || result === "Duplicate") && body && body.ok === true ? body.data?.createLead?.id ?? null : null;
          return { label: "tripoint", bid, leadId, result };
        } catch (err) {
          console.error("[bids] tripoint factory threw; treating as no-bid", err);
          return { label: "tripoint", bid: null, leadId: null, result: "Fail" };
        }
      }
    ],
    { deadlineMs: BID_DEADLINE_MS }
  );
  const bids = {
    amOne: null,
    amOneClickUrl: null,
    tripoint: null,
    tripointLeadId: null,
    tripointResult: "Fail"
  };
  for (const r of results) {
    if (r.label === "amOne") {
      bids.amOne = r.bid;
      bids.amOneClickUrl = r.clickUrl;
    } else {
      bids.tripoint = r.bid;
      bids.tripointLeadId = r.leadId;
      bids.tripointResult = r.result;
    }
  }
  console.log("[bids] collected", JSON.stringify({ bids }));
  return bids;
}

// src/engine/engine-proxy.ts
var ENGINE_PROXY_BASE_URL = "https://engine-proxy.trypennie.dev";
async function callEngineProxy(payload, opts) {
  const { baseUrl, sharedSecret, endpoint = "/leads/rate-tables", fetchImpl = fetch } = opts;
  const url = `${baseUrl.replace(/\/$/, "")}${endpoint}`;
  console.log("[engine-proxy] request", JSON.stringify({ url, payload }));
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${sharedSecret}`
    },
    body: JSON.stringify(payload)
  });
  const body = await res.json().catch(() => null);
  console.log(
    "[engine-proxy] response",
    JSON.stringify({ status: res.status, ok: res.ok, body })
  );
  return { ok: res.ok, status: res.status, body };
}

// src/engine/engine-fallback.ts
var SUBMISSION_TTL_SECONDS = 60 * 60 * 24 * 7;
async function runEngineFallback(steps, deps, reason, tripointResult = null, tripointLeadId = null) {
  const triggerBody = steps.trigger.event.body;
  const proxyResult = await callEngineProxy(triggerBody, {
    baseUrl: ENGINE_PROXY_BASE_URL,
    sharedSecret: deps.engineProxySharedSecret,
    endpoint: pickEngineEndpoint(steps),
    fetchImpl: deps.fetchImpl
  });
  const proxyBody = proxyResult.body;
  if (!proxyResult.ok || !proxyBody || proxyBody.ok !== true) {
    console.error(
      "[engine-fallback] engine proxy failed",
      JSON.stringify({ reason, status: proxyResult.status, body: proxyBody })
    );
    const failure = proxyBody && proxyBody.ok === false ? proxyBody : null;
    const failureBody = {
      message: failure?.error ?? "Engine proxy request failed",
      data: failure?.details ?? proxyBody ?? null
    };
    await respondToClient(deps.respond, steps, proxyResult.status, failureBody);
    return {
      ok: false,
      reason,
      status: proxyResult.status,
      body: failureBody
    };
  }
  const data = proxyBody.data;
  console.log("[engine-fallback] caching submission uuid", {
    submissionId: triggerBody.Submission__c,
    uuid: data.uuid,
    ttlSeconds: SUBMISSION_TTL_SECONDS
  });
  await deps.dataStore.set(triggerBody.Submission__c, data.uuid, { ttl: SUBMISSION_TTL_SECONDS });
  const vantageScore = steps.gen_vantage_score.$return_value ?? null;
  const base = buildBaseSfBody(steps, data);
  const eligibilityResult = steps.pennie_or_eligibility?.$return_value ?? null;
  const eligibilityData = eligibilityResult?.eligibilityData ?? null;
  const eligibility = eligibilityResult?.eligibility ?? null;
  const equifaxSuccess = (eligibilityResult?.equifax ?? null) !== null;
  const estimatedDebt = eligibilityResult?.final ?? null;
  const adv = steps.mutate_adv.$return_value ?? null;
  const bes = steps.mutate_bes.$return_value ?? null;
  const leg = triggerBody.LEG;
  let creditPullResult;
  if (reason === "no-debt") {
    creditPullResult = "Fail";
  } else if (reason === "state-not-allowed") {
    creditPullResult = eligibilityData != null && !eligibility ? "Fail" : "Success";
  } else {
    creditPullResult = eligibilityData != null ? eligibility ? "Success" : "Fail" : void 0;
  }
  let sfBody;
  let clientBody;
  if (reason === "no-debt") {
    sfBody = {
      ...base,
      Credit_Pull_Result_ES__c: creditPullResult,
      External_Exchange_Status__c: "Completed",
      External_Partner_Name__c: "Engine",
      External_Routing_Code__c: 1,
      EQXCreditPullStatus__c: "Fail",
      LeadSaleType__c: "Offer Wall",
      VantageScore__c: vantageScore
    };
    clientBody = { ...data };
  } else if (reason === "no-bids") {
    sfBody = {
      ...base,
      Monthly_Creditor_Payment_ES__c: eligibilityData?.estimated_monthly_creditor_payment ?? null,
      Unsecured_Debt_Verified_ES__c: eligibilityData?.estimated_total_debt ?? null,
      ...creditPullResult !== void 0 && { Credit_Pull_Result_ES__c: creditPullResult },
      External_Exchange_Status__c: "Completed",
      External_Partner_Name__c: "Engine",
      External_Routing_Code__c: 1,
      ADV_SO__c: adv,
      XBC_SO__c: `${adv}${bes}${leg}`,
      EQXCreditPullStatus__c: equifaxSuccess ? "Success" : "Fail",
      LeadSaleType__c: "Offer Wall",
      VantageScore__c: vantageScore,
      Tripoint_Response__c: tripointResult,
      TripointLeadID__c: tripointLeadId
    };
    clientBody = {
      unsecuredDebtVerified: false,
      ADV: adv,
      XBC: `${adv}${bes}${leg}`,
      routingPartner: 1,
      estimatedTotalDebt: estimatedDebt,
      ...data
    };
  } else {
    sfBody = {
      ...base,
      Monthly_Creditor_Payment_ES__c: eligibilityData?.estimated_monthly_creditor_payment ?? null,
      Unsecured_Debt_Verified_ES__c: eligibilityData?.estimated_total_debt ?? null,
      ...creditPullResult !== void 0 && { Credit_Pull_Result_ES__c: creditPullResult },
      External_Exchange_Status__c: "Completed",
      External_Partner_Name__c: "Engine",
      External_Routing_Code__c: 1,
      ADV_SO__c: adv,
      XBC_SO__c: `${adv}${bes}${leg}`,
      EQXCreditPullStatus__c: equifaxSuccess ? "Success" : "Fail",
      LeadSaleType__c: "Offer Wall",
      VantageScore__c: vantageScore
    };
    clientBody = {
      unsecuredDebtVerified: false,
      ADV: adv,
      XBC: `${adv}${bes}${leg}`,
      routingPartner: 1,
      estimatedTotalDebt: estimatedDebt,
      ...data
    };
  }
  await respondToClient(deps.respond, steps, proxyResult.status, clientBody);
  const salesforceResponse = await postToSalesforceWebhook(sfBody, { fetchImpl: deps.fetchImpl });
  return { ok: true, reason, status: proxyResult.status, body: clientBody, salesforceResponse };
}

// src/tripoint/tripoint-winner.ts
async function runTripointWinner(steps, deps, tripointLeadId, tripointBid, tripointResult) {
  const triggerBody = steps.trigger.event.body;
  const eligibilityResult = steps.pennie_or_eligibility?.$return_value ?? null;
  const eligibilityData = eligibilityResult?.eligibilityData ?? null;
  const eligibility = eligibilityResult?.eligibility ?? null;
  const equifaxSuccess = (eligibilityResult?.equifax ?? null) !== null;
  const estimatedDebt = eligibilityResult?.final ?? null;
  const adv = steps.mutate_adv.$return_value ?? null;
  const bes = steps.mutate_bes.$return_value ?? null;
  const leg = triggerBody.LEG;
  const vantageScore = steps.gen_vantage_score.$return_value ?? null;
  const creditPullResult = eligibilityData != null ? eligibility ? "Success" : "Fail" : void 0;
  const sfBody = {
    ...buildSubmissionBase(steps),
    External_Exchange_Status__c: "Pending",
    External_Partner_Name__c: "Tripoint",
    External_Routing_Code__c: 2,
    Monthly_Creditor_Payment_ES__c: eligibilityData?.estimated_monthly_creditor_payment ?? null,
    Unsecured_Debt_Verified_ES__c: eligibilityData?.estimated_total_debt ?? null,
    ADV_SO__c: adv,
    XBC_SO__c: `${adv}${bes}${leg}`,
    EQXCreditPullStatus__c: equifaxSuccess ? "Success" : "Fail",
    LeadSaleType__c: "Form",
    VantageScore__c: vantageScore,
    TripointLeadID__c: tripointLeadId,
    Tripoint_Response__c: tripointResult,
    ...creditPullResult !== void 0 && { Credit_Pull_Result_ES__c: creditPullResult }
  };
  const clientBody = {
    unsecuredDebtVerified: false,
    ADV: adv,
    XBC: `${adv}${bes}${leg}`,
    routingPartner: 2,
    estimatedTotalDebt: estimatedDebt,
    tripointLeadId
  };
  await respondToClient(deps.respond, steps, 200, clientBody);
  const salesforceResponse = await postToSalesforceWebhook(sfBody, { fetchImpl: deps.fetchImpl });
  return { status: 200, body: clientBody, salesforceResponse };
}

// src/winning-bid.ts
var TRIPOINT_HIGH_DEBT_THRESHOLD = 12499;
function calculateWinningBid(input) {
  const { amOneBid, finalDebt, tripointMultiplierLow, tripointMultiplierHigh } = input;
  const multiplier = finalDebt > TRIPOINT_HIGH_DEBT_THRESHOLD ? tripointMultiplierHigh : tripointMultiplierLow;
  const tripointBid = finalDebt * multiplier;
  const winner = amOneBid === null || tripointBid >= amOneBid ? "tripoint" : "am_one";
  console.log("[winning-bid] comparison", {
    amOneBid,
    finalDebt,
    multiplier,
    multiplierTier: finalDebt > TRIPOINT_HIGH_DEBT_THRESHOLD ? "high" : "low",
    calculatedTripointBid: tripointBid,
    winner
  });
  return { amOneBid, tripointBid, winner };
}
function decideBidWinner(input) {
  const { bids, finalDebt, tripointMultiplierLow, tripointMultiplierHigh } = input;
  const tripointInRace = bids.tripointLeadId !== null && bids.tripointResult === "Success";
  const amOneInRace = bids.amOne !== null;
  console.log(
    "[winning-bid] decide",
    JSON.stringify({ bids, tripointInRace, amOneInRace })
  );
  if (!tripointInRace && !amOneInRace) return null;
  if (!amOneInRace) return "tripoint";
  if (!tripointInRace) return "am_one";
  return calculateWinningBid({
    amOneBid: bids.amOne,
    finalDebt,
    tripointMultiplierLow,
    tripointMultiplierHigh
  }).winner;
}

// src/main-flow.ts
var ESTIMATED_DEBT_THRESHOLD = 1e4;
async function runMainFlow(steps, deps) {
  const estimatedDebt = steps.pennie_or_eligibility?.$return_value?.final ?? null;
  const stateAllowed = isStateAllowed(steps);
  const state = steps.trigger.event.body.personalInformation.state;
  console.log("[main-flow] start", {
    estimatedDebt,
    state,
    stateAllowed,
    threshold: ESTIMATED_DEBT_THRESHOLD,
    meetsThreshold: estimatedDebt !== null && estimatedDebt >= ESTIMATED_DEBT_THRESHOLD
  });
  if (estimatedDebt !== null && estimatedDebt >= ESTIMATED_DEBT_THRESHOLD && stateAllowed) {
    console.log("[main-flow] entering bid path");
    let bids;
    let winner = null;
    try {
      bids = await collectBids(steps, deps);
      const { tripointMultiplierLow, tripointMultiplierHigh } = steps.constants.$return_value;
      winner = decideBidWinner({
        bids,
        finalDebt: estimatedDebt,
        tripointMultiplierLow,
        tripointMultiplierHigh
      });
    } catch (err) {
      console.error("[main-flow] bid collection/decision failed; falling back to engine", err);
    }
    console.log("[main-flow] bid winner", JSON.stringify({ winner, bids }));
    if (winner === "tripoint") {
      const tripointResult = await runTripointWinner(
        steps,
        deps,
        bids.tripointLeadId,
        bids.tripoint,
        bids.tripointResult
      );
      return { estimatedDebt, bids, tripointResult };
    }
    if (winner === "am_one") {
      const amOneResult = await runAmOneWinner(
        steps,
        deps,
        bids.amOne,
        bids.amOneClickUrl ?? void 0,
        bids.tripointResult
      );
      return { estimatedDebt, bids, amOneResult };
    }
    console.log("[main-flow] engine fallback", { reason: "no-bids" });
    const engineResult2 = await runEngineFallback(steps, deps, "no-bids", bids.tripointResult, bids.tripointLeadId);
    return { estimatedDebt, engineResult: engineResult2, bids };
  }
  let reason;
  if (estimatedDebt === null) {
    reason = "no-debt";
  } else if (estimatedDebt < ESTIMATED_DEBT_THRESHOLD) {
    reason = "low-debt";
  } else {
    reason = "state-not-allowed";
  }
  console.log("[main-flow] engine fallback", { reason });
  const engineResult = await runEngineFallback(steps, deps, reason);
  return { estimatedDebt, engineResult };
}
var main_flow_default = {
  key: "pennie-main-flow",
  name: "Pennie Main Flow",
  description: "Replaces the multi-step main flow as a single custom action.",
  version: "0.0.2",
  type: "action",
  props: {
    engineProxySharedSecret: {
      type: "string",
      label: "Engine Proxy Shared Secret",
      secret: true
    },
    amOneProxySharedSecret: {
      type: "string",
      label: "AM One Proxy Shared Secret",
      secret: true
    },
    tripointProxySharedSecret: {
      type: "string",
      label: "Tripoint Proxy Shared Secret",
      secret: true
    },
    dataStore: {
      type: "data_store",
      label: "Submission UUID Data Store"
    },
    pennieOrEligibilityReturn: {
      type: "object",
      label: "Pennie/Eligibility return value",
      description: "Wire to {{steps.pennie_or_eligibility.$return_value}}",
      optional: true
    },
    constantsReturn: {
      type: "object",
      label: "Constants return value",
      description: "Wire to {{steps.constants.$return_value}}"
    },
    vantageScore: {
      type: "integer",
      label: "Vantage score",
      description: "Wire to {{steps.gen_vantage_score.$return_value}}",
      optional: true
    },
    adv: {
      type: "integer",
      label: "ADV (mutated)",
      description: "Wire to {{steps.mutate_adv.$return_value}}",
      optional: true
    },
    bes: {
      type: "integer",
      label: "BES (mutated)",
      description: "Wire to {{steps.mutate_bes.$return_value}}",
      optional: true
    },
    triggerBody: {
      type: "object",
      label: "Trigger body",
      description: "Wire to {{steps.trigger.event.body}}"
    },
    executionId: {
      type: "string",
      label: "Execution ID",
      description: "Wire to {{steps.trigger.context.id}}"
    }
  },
  async run({ $ }) {
    const steps = {
      pennie_or_eligibility: this.pennieOrEligibilityReturn ? { $return_value: this.pennieOrEligibilityReturn } : void 0,
      constants: { $return_value: this.constantsReturn },
      gen_vantage_score: { $return_value: this.vantageScore ?? null },
      mutate_adv: { $return_value: this.adv ?? null },
      mutate_bes: { $return_value: this.bes ?? null },
      trigger: {
        event: { body: this.triggerBody },
        context: { id: this.executionId }
      }
    };
    return runMainFlow(steps, {
      engineProxySharedSecret: this.engineProxySharedSecret,
      amOneProxySharedSecret: this.amOneProxySharedSecret,
      tripointProxySharedSecret: this.tripointProxySharedSecret,
      dataStore: this.dataStore,
      respond: $.respond.bind($)
    });
  }
};
export {
  main_flow_default as default,
  runMainFlow
};
