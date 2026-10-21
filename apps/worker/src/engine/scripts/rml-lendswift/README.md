# RML - Bidding Workflow (LendSwift) scripts

The `build_response` (#2092) and `ping_lendswift` (#2582) code node scripts of the live RML - Bidding Workflow (LendSwift) workflow (`e1b810da-16c0-49eb-bf12-ba1c9b67c914`),
kept in the repo. As with `../engine-bidding/`, **the canvas is the source of
truth**: each file is exactly what is pasted into the node's script box, byte for byte,
and the hourly `engine-script-drift` check compares it with the canvas mirror in
`Try-Pennie/bidspoke-workflows`.

| File | Node | Why it is kept |
| --- | --- | --- |
| `build_response.js` | Build Response | Builds the offer link the bid response carries, `https://reservemyloan.com/portal/ls/<Applicant id>`. Copied from the mirror on 2026-10-15 and changed for #2092 only: the link gets the signed link token (`?t=`), HMAC-SHA256 of the first 15 characters of the Applicant id keyed with `LINK_TOKEN_SECRET`, the same token Pipedream's RML workflows send. The step output carries `link_token` saying whether it was signed and, if not, why. A missing secret logs an error and sends the link unsigned; the bid is never failed for it. |

| `ping_lendswift.js` | Ping Lendswift | Sends the lead to LendSwift's decide service. Copied from version 22 on 2026-10-21 and changed for #2582 only: when LendSwift fails (an error answer after the one retry on a 5xx, a fetch that rejects, or a 200 with no decision in it) the script no longer answers the source HTTP 500. It returns a decision `build_response` reads as a rejection, with `rejection_reason: 'lendswift_error'`, so the flow takes its normal no bid path: the source gets `{ status: 'rejected', reason: 'unqualified_lead' }` and `patch_applicant_no_bid` writes `LS_Rejection_Reason__c = lendswift_error`. LendSwift's own reason is on the step output as `lendswift_error` (kind, HTTP status, status, exception type, provider error type, message, decision id). Their error body echoes what they sent their providers and a provider URL can end in the applicant's SSN, so only those fields are kept, every run of five or more digits is masked and the message is capped at 500 characters. |

It carries a drift baseline (version 22's script) until the paste lands and the
hourly check reads it as agree; then the baseline is cleared.

The link goes back only in the bid response. `Redirect_URL__c` and
`OfferLandingPage__c` on the Applicant get the lender's own `redirect_url`, not this
link, so nothing else needs signing.

The helper block between the `BEGIN`/`END link token (#2089)` markers is the one text
`../__tests__/link-token.test.ts` holds every signing script to. `LINK_TOKEN_HOSTS`, set
just above it, adds `reservemyloan.com` to `trypennie.com` and `www.trypennie.com` for
the RML flows only. reservemyloan.com does not read `?t=` yet (Dan, 2026-10-15), so
signing cannot break a link.

It was saved to the canvas on 2026-10-15 (between 10:14 and 10:16 AM ET) and the
hourly check read it as agree, so it carries no drift baseline: a canvas put back to
the unsigned script pages as a drift.
