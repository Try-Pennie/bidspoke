# Bidspoke becomes the canonical home for bid matrices

Bid matrices are money-critical pricing data. Today Salesforce is canonical (`sync_source: 'salesforce'`), edited in SF and pulled into `bid_matrix_rows` on an hourly cron, read-only in Bidspoke. We will make **Bidspoke canonical**: a validating, versioned editor that rejects credit-score-band gaps and overlaps *before* save, with preview and rollback, so pricing lives behind the same guarantees as the rest of the platform. Salesforce becomes a downstream mirror or is dropped. SF-canonical was judged v1 inertia, not a real org/ownership constraint.

## Status

accepted (not yet implemented)

## Context

The SF-canonical model has three structural problems for money-critical data: a stale-pricing window of up to ~60 min between an SF edit and the next sync; no validation gate, so band gaps/overlaps ship silently (the 2026-05-07 incident broke bidding for three hours); and edits bypass Bidspoke's own audit/version/rollback. The shipped mitigation (4.10 matrix-change Slack alerts) is detection after bidding already broke, not prevention. The schema is already editable-ready — `sync_source` can flip from `salesforce` to `manual`.

## Considered options

- **Keep SF canonical, add a validation gate at sync** (reject bad matrices before they go live). The right answer *if* ops/finance own pricing in SF as their system of record — but that ownership constraint was judged not to exist here.
- **Make Bidspoke canonical with a validating editor.** Chosen: removes the stale window, prevents gaps/overlaps at the source, and brings pricing under Bidspoke versioning/audit.

## Consequences

- Build a validating bid-matrix editor (no gaps/overlaps, preview, versioned) and flip `sync_source` to `manual`.
- Retire or invert the hourly SF→`bid_matrix_rows` sync (SF becomes a mirror if still needed downstream); the 4.10 change-alert logic may be repurposed.
- Validation rules (full credit-band coverage, no overlaps) must be specified.
- Not yet implemented as of 2026-06-22.
