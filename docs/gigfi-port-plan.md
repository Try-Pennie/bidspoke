# GigFi Bidding Workflow — Pipedream → Bidspoke Port Plan

> Source of truth: the **live LendSwift Bidspoke workflow** (`e1b810da-16c0-49eb-bf12-ba1c9b67c914`, "RML - Bidding Workflow (LendSwift)") is the structural template. The GigFi **Pipedream JSON** supplies the GigFi-specific values. Where they disagree, LendSwift's Bidspoke shape wins (it's tested in prod).

## Why we're not porting straight from the JSON

The GigFi Pipedream JSON is missing the entire tail (the BID/NO_BID split + the two `patch_applicant` SF writes) and contains shape mismatches that would silently break bidding:

1. **Decision path nesting.** Taktile returns `{ data: { status, bid_amount, ... } }`. LendSwift's working `build_response` reads `steps.ping_lendswift.output.data.data.status`. The GigFi JSON's `return_response` reads `steps.ping_gigfi.$return_value.data.status` (one `.data` short) — even though the same file's ping `$summary` uses `result.data?.data?.status`. Porting the JSON verbatim → every bid reads `undefined` → 100% rejected.
2. **Sub-account min bids live in the partner DB, not in constants.** LendSwift reads `steps.constants.output.LendswiftSubAccountMinBids` (surfaced by the Constants node from `partner_configs.sub_account_min_bids`). The Constants node `data` has no `subAccountBids` key.
3. **`constants` is a Constants node, not a code node.**
4. **Response is two nodes:** `build_response` (code, computes everything) → `return_response` (Response node, `continue_after_response: true` so SF patch runs after the caller is answered).
5. **Credentials fold into the ping node from `env`**; the disabled `fetch_*_credentials` node is dropped.
6. **Endpoint URL** in the JSON points at `/sandbox/`. Production must not.
7. **Slack error webhooks dropped** — Bidspoke's native failure alerting replaces the Pipedream `$.http.post` calls.

## Bidspoke conventions for code nodes (observed in LendSwift)

- No `defineComponent` wrapper — the script is the function body, ending in `return`.
- Globals: `payload` (the request body), `steps`, `env`, `execution`, `console`. (LendSwift uses bare `payload`, not `trigger.payload`.)
- `steps.X.output` (never `$return_value`). `execution.trace_id`, `execution.bidspoke_link`.
- `$.flow.exit()` → `return { exit: true }`.
- `$.respond({status,headers,body})` → `return { response: { status, headers, body } }`.
- No imports; use native `fetch`.

---

## Node-by-node mapping (final target = 12 nodes)

| # | Namespace | Bidspoke type | Source |
|---|-----------|---------------|--------|
| 1 | `constants` | **constants** | GigFi values, sub-bids → partner DB |
| 2 | `parsed_name` | code | GigFi JSON (+ folded guard) |
| 3 | `validate_bidding_and_state` | code | GigFi JSON (keeps `self_employed` gate) |
| 4 | `applicant_body` | code | GigFi JSON (trace link → `execution.bidspoke_link`) |
| 5 | `create_applicant` | **salesforce** (create) | LendSwift config verbatim |
| 6 | `ping_gigfi` | code | GigFi transform + LendSwift ping mechanics |
| 7 | `build_response` | code | reshaped from GigFi `return_response` to LendSwift contract |
| 8 | `return_response` | **response** | LendSwift config |
| 9 | `patch_applicant` | **branch** (Bid / No Bid) | LendSwift config |
| 10 | `patch_applicant_bid` | **salesforce** (update) | LendSwift body, GigFi partner name/code |
| 11 | `patch_applicant_no_bid` | **salesforce** (update) | LendSwift body, GigFi partner name/code |
| 12 | `branch_end_1` | branch_end | auto |

Edge chain: trigger → constants → parsed_name → validate → applicant_body → create_applicant → ping_gigfi → build_response → return_response → patch_applicant ──Bid──▶ patch_applicant_bid ─▶ branch_end_1; patch_applicant ──No Bid──▶ patch_applicant_no_bid ─▶ branch_end_1.

Trigger: POST, api_key, **success nodes = `patch_applicant_bid`, `patch_applicant_no_bid`**, idempotency OFF.

---

## Open values needed before build (GigFi-specific, not derivable)

- **A. Sub-account min bids storage** — ✅ DECIDED (2026-06-09): **Partner DB**, mirroring LendSwift. GigFi `partner_configs` row (slug `gigfi`, `partner_type=buyer`, `sub_account_min_bids` = the 8-UUID map from the JSON). Code reads `steps.constants.output.GigfiSubAccountMinBids`.
- **B. GigFi production endpoint URL** — JSON default is `https://risk.bf9baa41.decide.taktile.com/run/api/v1/flows/training/sandbox/decide` (sandbox). LendSwift prod uses `.../flows/training/decide`. NEED GigFi's real production URL.
- **C. `GIGFI_API_KEY`** — set on the Env Variables UI page (is_secret). The `X-Api-Key` value from GigFi.
- **D. `ExternalRoutingCode__c` for GigFi** — LendSwift uses `4`. GigFi needs its own routing code. NEED value.
- **E. `LEAD_PROVIDER`** — LendSwift hardcodes `"Pennie"`. Confirm for GigFi.
- **F. GigFi SF rejection field** — LendSwift's no-bid patch writes `LS_Rejection_Reason__c` (LendSwift-specific). NEED the GigFi equivalent field name, or drop it.

---

## Build order

1. **Env var** `GIGFI_API_KEY` (Env Variables page).
2. *(If option A)* **GigFi partner row** with `sub_account_min_bids`.
3. **Create workflow** + trigger (POST, api_key; success nodes set after the patch nodes exist).
4. Nodes 1–8 top to bottom (constants → build_response).
5. Node 9 branch + nodes 10/11 SF updates + branch_end.
6. Set trigger success nodes; assign API key / source; (optional) custom endpoint `hook.trypennie.dev/gigfi`.
7. Save → Test Runner with a sample lead → one live shadow lead → point GigFi's source at the URL.

(Node scripts/configs are specified in the follow-up steps, each derived from the LendSwift node of the same name with GigFi values substituted.)
