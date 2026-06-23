# PII stays readable in logs and the warehouse — we deliberately do not mask it

The readiness audit flagged that PII redaction ships disabled, so SSN, DOB, and credit data sit in cleartext in execution logs and are exported raw to Snowflake. We are **accepting this deliberately**: the ops team needs to read the actual SSN and credit data to do its job (debugging a lead, reconciling a bid, answering a partner). Masking it would break that workflow. We will keep `PII_REDACTION_FIELDS` empty and leave raw PII readable in the execution logs and the Snowflake export.

## Status

accepted (2026-06-23)

## Context

The audit's top-listed risk was "PII redaction ships disabled" (`apps/worker/wrangler.toml` `PII_REDACTION_FIELDS=""`; raw SSN in `lead_sightings` and the Snowflake export). The redaction mechanism is fully built and can be switched on per-field at any time. The single-org ops team (~2 engineers, ~2 non-technical ops) operates with focus time on a tool that moves real money and must routinely reference the underlying PII. Hiding it behind redaction or a reveal flow would add friction to the core job without a corresponding benefit at the current scale and trust boundary.

## Consequences

- `PII_REDACTION_FIELDS` stays empty; raw SSN/DOB/credit remain in `workflow_executions`/`execution_steps` JSONB and in the Snowflake `lead_sightings` export. This is a conscious tradeoff, not an oversight.
- The blast radius of a log/warehouse breach is correspondingly larger. The compensating controls are access scoping (single org, authenticated team) and the short execution-log retention window.
- Revisit if the trust boundary changes: a less-trusted role, an external auditor, a regulator requirement (FCRA/GLBA/CCPA), or multi-tenant expansion. The mechanism is already built, so re-enabling is a config change plus a decision about whether the Snowflake copy uses the peppered hash instead of raw SSN.
- This decision does **not** cover the two items that were filed under issue #281 (a versioned/envelope encryption-key scheme so `SECRET_ENCRYPTION_KEY` can rotate without data loss, and an audit of service-role routes for explicit org scoping). Those are about key durability and cross-customer isolation, not about hiding PII from the ops team; #281 is being closed alongside this decision as not-tracked-now, recoverable from the readiness report (`docs/production-readiness/2026-06-22-report.md`).
