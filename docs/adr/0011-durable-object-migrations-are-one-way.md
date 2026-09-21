# Durable Object migrations are one way, so a class ships in its own deploy

## Status

**Accepted** (#1410, 2026-09-21). Applies to every `[[migrations]]` entry in `apps/worker/wrangler.toml`.

## Context

A Durable Object class reaches production through a numbered migration in the Worker's configuration (`tag = "v5"`, `new_sqlite_classes = [...]`). Cloudflare applies the migration with the deploy that carries it and records the tag against the script. A later `wrangler rollback` to a version from BEFORE that migration is refused, because the rolled back script has no definition for classes the account now has state for.

Phase 3 of the buyer selection work (#1410) adds two SQLite backed classes, `BuyerLedgerObject` and `LeadSaleObject`, under migration `v5`. Unlike the four classes before them, these hold SALE state: which leads a buyer was offered, what it answered, what it was paid, and which lead is already sold. That state does not self heal. It is the record the caps are counted from and the claim that stops a lead being sold twice.

## Decision

1. **A migration that adds a Durable Object class ships in a deploy that adds NOTHING else a lead path depends on.** Phase 3 adds the classes, their clients, an admin health route and a drill, and no caller on a lead path. If the deploy is wrong, the fix is a deploy forward with an empty behaviour change, never a rollback across the migration. Phase 4, which puts the `buyer_select` node on a canvas, is a separate deploy for this reason.
2. **`wrangler rollback` is not a recovery tool for any version before the newest migration tag.** The disaster recovery runbook lists the tags and says so.
3. **The two SQLite classes are listed in `docs/disaster-recovery.md` as state that must be recovered, not as transient runtime state.** `buyer_sales` in Postgres is the mirror of the ledger (`record_buyer_sale`, #1409) and is how sale history survives a loss of the objects; the objects are how the caps and the claims survive a loss of Postgres for the length of an outage.
4. **A class is never renamed or deleted in the same release that stops using it.** The same expand and contract discipline as ADR 0007: stop calling it, deploy, then a later migration with `deleted_classes` or `renamed_classes`.

## Consequences

- Each phase of milestone 52 that touches `wrangler.toml` migrations is its own pull request and its own deploy.
- Rolling back Phase 3 means deploying the previous code WITH the `v5` migration still present in the configuration. That is what a forward fix looks like here.
- The pre existing classes (`DailyCapObject`, `CircuitBreakerObject`, `BulkheadObject`, `LatencyMarkObject`, `AlertClaimObject`) are transient by design and lose nothing that matters on eviction; the recovery runbook now says which classes are which.
