# Bidding - LendSwift scripts

The `build_response` code node script of the live Bidding - LendSwift workflow (`0f4df7a7-2405-4fc7-9af4-5d5e05ce96c5`),
kept in the repo for #2092. As with `../engine-bidding/`, **the canvas is the source of
truth**: the file is exactly what is pasted into the node's script box, byte for byte,
and the hourly `engine-script-drift` check compares it with the canvas mirror in
`Try-Pennie/bidspoke-workflows`.

| File | Node | Why it is kept |
| --- | --- | --- |
| `build_response.js` | Build Response | Builds the offer link the bid response carries, `https://reservemyloan.com/portal/ls/<Applicant id>`. Copied from the mirror on 2026-10-15 and changed for #2092 only: the link gets the signed link token (`?t=`), HMAC-SHA256 of the first 15 characters of the Applicant id keyed with `LINK_TOKEN_SECRET`, the same token Pipedream's RML workflows send. The step output carries `link_token` saying whether it was signed and, if not, why. A missing secret logs an error and sends the link unsigned; the bid is never failed for it. |

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
