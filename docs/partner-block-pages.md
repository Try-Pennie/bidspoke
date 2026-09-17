# Partner firewall block pages

What happens when a partner's firewall answers a call with a block page instead of data, how
the alert reads, and what has to be true for the detection to cover every call. Built for
#1265 after Achieve's Cloudflare firewall refused every call from the worker for five days
(2026-09-05 to 09-10) and nothing recognised it.

## What is recognised

A block is recognised only on the markers a block or challenge page carries: Cloudflare's
"Sorry, you have been blocked" and "Attention Required" pages, its access-denied error codes
(1006 to 1020), a `cf-mitigated` header, or a challenge interstitial. A 403 whose body is an
HTML page with none of those is reported as exactly that, an HTML page where data was
expected, with no firewall wording.

A Ray ID alone is never evidence: every response that passes through Cloudflare carries a
`cf-ray` header, and Cloudflare's own origin-error pages (502, 504, 520 to 526) carry a Ray
ID too while meaning the partner's server is down. Both live buyers' endpoints are proxy
workers on our own zone, so the header Ray ID on those responses is ours. The alert quotes
the Ray ID from the page body (the partner's) and labels the header one as the edge in front
of the host.

Detection changes nothing about classification, retries or partner overrides: the HTML page
rule (#694, #756) already makes such a response transient. The detector adds recognition and
an alert on top. The fixture the detector is tested against is the real page from the
incident, read out of the execution archive (`apps/worker/src/lib/__tests__/fixtures/`).

## Where it looks

Every worker-side reader of a partner body: partner bids (before any classification
override), the integration node, the Salesforce node (operation, token fetch and query
paging), the Achieve offers node and the partner dedup check. A guard on the web side
(`block-page-detector-everywhere.test.ts`) enumerates those readers from the source and
fails when one reads a body without the detector.

Code nodes are covered through their sandbox bundle: each script's `fetch` records every
non-2xx response it sees (host, status, content type, the Cloudflare headers and the first 8
KB of the body) and returns the records with its result. The sandbox holds no rule; the
worker's one detector decides. **A workflow's bundle is built at save time**, so after a
deploy that changes the capture, every workflow with code nodes that call partners has to be
saved once before its code nodes are covered. Until then the worker logs
`event=code_bundle_without_block_capture` once per bundle, which is the coverage measure:
that line reaching zero across active workflows is the evidence, not "no blocks were seen".

## The alert

One Slack message per blocked host on the first sighting, naming the partner or host, the
status, the Ray ID to quote, the workflow and step that saw it (or the probe, below), and
how to fix it (ask the partner for an allowlist keyed on our identifying request headers
rather than an address; our calls leave from Cloudflare's shared address and from several
locations). While the block stands, reminders follow the standing-condition backoff (6h,
12h, then daily), posted only on a new sighting. A lead sighting never posts an all-clear
itself: a block that lifts produces no sighting. Every sighting, posted or suppressed, arms
the all-clear the probe owns, so a block a lead saw first still gets one.

## The scheduled probe (#1274)

Detection from leads alone sees a block only when a lead happens to take that branch, and
sees a block LIFT never. So every five minutes (`*/5 * * * *`, `lib/partner-reachability.ts`)
the worker sends one GET to each of the three Achieve hosts, carrying the same identifying
headers the real calls send (a header-less GET from the shared Workers address is exactly
the request their firewall refuses), and to a control host on our own zone that is
deliberately blocked. Each host reads as one of three states, judged by the same detector
the lead path uses:

- `blocked`: a Cloudflare block page, HTML or the one line plain text form an API client
  is served (`error code: 1020`). Reported through the same reporter and key as a lead
  sighting, so whichever observer sees it first posts and the other is a suppressed repeat.
- `unreachable`: the fetch failed, a Cloudflare origin error (502, 504, 520 to 526, 530),
  or a Cloudflare edge error that is not a firewall code (`error code: 1014` and the like).
  Silence for 30 minutes on the clock posts its own "not answering" message; a single
  silent look is a log line. A network level block looks exactly like this.
- `reachable`: the application answered, whatever it said (401, 404, 405, a redirect, a
  branded 403 page with no firewall markers). A bare root is not a data endpoint, so a
  plain 403 page there is not the finding it would be on one.

Every threshold is judged on the clock from the moment a state began, never on a count of
runs. The all-clear posts after 30 minutes of clean looks with no lead sighting in that time,
one message for every host that recovered on the same run, and it clears both conditions so
the next block pages at once.

**The control.** `block-probe.trypennie.dev` is blocked by a WAF custom rule on trypennie.dev
(expression `http.host eq "block-probe.trypennie.dev"`, action Block) and must read
`blocked` on every run. A monitor that has never seen a block is indistinguishable from one
that cannot see one. Two failures, two messages: the control has never read blocked since
deploy (create the rule) and the control stopped reading blocked (the rule was removed or
the page markers changed). A run on which the control's own fetch fails holds every other
reading as unmeasured and, after ten minutes, posts one "the probe cannot fetch" line
instead of a partner outage per host.

**Observe mode.** `PARTNER_PROBE_ALERTS` in `wrangler.toml` ships `off`: the state machine
runs in full and every would-be post is a `would_post=` log line. #1396 flips it after a
clean day. `LOCAL_DEV` probes and logs and writes nothing.

The probe never enters the engine, so executions, sightings and the field presence check
never count it. Log lines: `event=partner_probe` per host per run (`control=true` on the
control's, exclude it from any count of `state=blocked`), and the shared
`event=partner_block_page` with `seen_in=probe`. Its heartbeat job is
`partner-reachability`; its alert keys are `partner-block:<host>` (shared),
`partner-unreachable:<host>` and `partner-probe-control`.

Test runs and local dev write the event line and post nothing, like every engine alert. The
log line to search for is `event=partner_block_page`.

## Verifying it end to end

A blocked path on our own zone gives a real Cloudflare block page to test against from the
worker's own address: a canvas test run of a code node fetching it should leave
`event=partner_block_page` in the logs and the sighting in the step's Results panel, with no
Slack post because test runs do not post.
