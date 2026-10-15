# RML - Bidding Workflow (GigFi) scripts

The `build_response` code node script of the live RML - Bidding Workflow (GigFi) workflow (`6624acd0-bf61-4d21-85fc-4371ca7ed77d`),
kept in the repo for #2092. As with `../engine-bidding/`, **the canvas is the source of
truth**: the file is exactly what is pasted into the node's script box, byte for byte,
and the hourly `engine-script-drift` check compares it with the canvas mirror in
`Try-Pennie/bidspoke-workflows`.

| File | Node | Why it is kept |
| --- | --- | --- |
| `build_response.js` | Build Response | Builds the offer link the bid response carries, `https://reservemyloan.com/portal/gf/<Applicant id>`. Copied from the mirror on 2026-10-15 and changed for #2092 only: the link gets the signed link token (`?t=`), HMAC-SHA256 of the first 15 characters of the Applicant id keyed with `LINK_TOKEN_SECRET`, the same token Pipedream's RML workflows send. The step output carries `link_token` saying whether it was signed and, if not, why. A missing secret logs an error and sends the link unsigned; the bid is never failed for it. |

The link goes back only in the bid response. `Redirect_URL__c` and
`OfferLandingPage__c` on the Applicant get the lender's own `redirect_url`, not this
link, so nothing else needs signing.

The helper block between the `BEGIN`/`END link token (#2089)` markers is the one text
`../__tests__/link-token.test.ts` holds every signing script to. `LINK_TOKEN_HOSTS`, set
just above it, adds `reservemyloan.com` to `trypennie.com` and `www.trypennie.com` for
the RML flows only. reservemyloan.com does not read `?t=` yet (Dan, 2026-10-15), so
signing cannot break a link.

The file carries the canvas script it was derived from as its drift baseline, so the
check reads it as awaiting a paste rather than a drift. Clear the baseline once the
paste reads as agree.
