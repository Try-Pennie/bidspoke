# RML - Bidding Workflow (LendSwift) scripts

The `build_response` (#2092, #2582) and `ping_lendswift` (#2582) code node scripts of the live RML - Bidding Workflow (LendSwift) workflow (`e1b810da-16c0-49eb-bf12-ba1c9b67c914`),
kept in the repo. As with `../engine-bidding/`, **the canvas is the source of
truth**: each file is exactly what is pasted into the node's script box, byte for byte,
and the hourly `engine-script-drift` check compares it with the canvas mirror in
`Try-Pennie/bidspoke-workflows`.

| File | Node | Why it is kept |
| --- | --- | --- |
| `build_response.js` | Build Response | Builds the offer link the bid response carries, `https://reservemyloan.com/portal/ls/<Applicant id>`. Copied from the mirror on 2026-10-15 and changed for #2092: the link gets the signed link token (`?t=`), HMAC-SHA256 of the first 15 characters of the Applicant id keyed with `LINK_TOKEN_SECRET`, the same token Pipedream's RML workflows send. The step output carries `link_token` saying whether it was signed and, if not, why. A missing secret logs an error and sends the link unsigned; the bid is never failed for it. Changed again for #2582: when `ping_lendswift` reports `lendswift_error`, the lead is answered `{ status: 'rejected', reason: 'partner_error' }` and `patch_applicant_no_bid` writes `RejectionReason__c = partner_error` and `LS_Rejection_Reason__c = lendswift_error`. A LendSwift REJECTED still answers `unqualified_lead` exactly as before. |
| `ping_lendswift.js` | Ping Lendswift | Sends the lead to LendSwift's decide service. Copied from version 22 on 2026-10-21 and changed for #2582 only. The lead is sent ONCE and waited for up to 60 seconds (an AbortController on the call); there is no resend, because a call that failed or was slow may already have reached LendSwift. When LendSwift fails (an error answer, no answer within 60 seconds, a call that fails, or a 200 with no decision in it) the script no longer answers the source HTTP 500: it returns `lendswift_error` (kind, HTTP status, status, exception type, provider error type, message, decision id), which `build_response` answers as `partner_error`. The same answer also reads as a rejection to the build_response before #2582, so the two pastes can land in either order. LendSwift's error body echoes what they sent their providers and a provider URL can end in the applicant's SSN, so only those fields are kept, every run of five or more digits is masked and the message is capped at 500 characters. |

**Node settings for Ping Lendswift (#2582):** `timeout_ms` 65000 and `retries` 0.
The script ends a slow call at 60 seconds itself; the node's own timeout sits above
that so it never fires first, and no engine retry runs the script, and so sends the
lead, a second time. A single dispatched code node already runs this long in
production: Main Flow's `fallback_engine_under_10000` (`timeout_ms` 50000) completed
single calls of up to 47.7 seconds in the 7 days to 2026-10-21.

Both scripts were pasted on 2026-10-21 (version 24, saved 2:10 PM ET) and the hourly
check read them as agree, so neither carries a drift baseline: a canvas put back to
version 22's scripts pages as a drift. Roll back by pasting the version 22 scripts
and settings, never by version history Restore (#2598), and put the kept copies here
back in a PR, or the hourly check pages until they match.

A LendSwift failure is a completed no bid, so the failure saturation page cannot see
a LendSwift outage. `lib/partner-error-rate.ts` pages on the share of pings carrying
`lendswift_error` instead.

The link goes back only in the bid response. `Redirect_URL__c` and
`OfferLandingPage__c` on the Applicant get the lender's own `redirect_url`, not this
link, so nothing else needs signing.

The helper block between the `BEGIN`/`END link token (#2089)` markers is the one text
`../__tests__/link-token.test.ts` holds every signing script to. `LINK_TOKEN_HOSTS`, set
just above it, adds `reservemyloan.com` to `trypennie.com` and `www.trypennie.com` for
the RML flows only. reservemyloan.com does not read `?t=` yet (Dan, 2026-10-15), so
signing cannot break a link.

The signing was saved to the canvas on 2026-10-15 (between 10:14 and 10:16 AM ET) and
the hourly check read it as agree; a canvas put back to the unsigned script pages as a
drift.
