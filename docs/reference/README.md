# Reference artifacts

Source materials for the engine bidding cutover (see `docs/engine-cutover-scope.md`). These are snapshots from 2026-04-16. Source systems (Pipedream, Salesforce) are authoritative; these copies are for offline reference during the Bidspoke rebuild.

## Files

- `engine-bidding-pipedream.json` — full export of the current Pipedream "engine bidding" workflow. Top-level keys: `triggers`, `steps`. Step order and response-shape contract documented in `engine-cutover-scope.md` §3.1.
- `bid-matrix-controller.apex.cls` — Salesforce Apex source for `BidMatrixController`. Defines `BidRangeRow__c` fields, per-partner boolean flags, `BidConfiguration__mdt` shape, and the 5 sell-off filter fields. Drives the schema in `engine-cutover-scope.md` §3.2.

## When these become stale

Update (or re-export) if either source changes materially. Neither file is consumed by code — they exist so the migration can be completed even if the session that captured them is long gone. If the Bidspoke replacements ship and are proven at parity, these can be removed.
