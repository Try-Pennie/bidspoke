# PII stays readable in logs and the warehouse — we deliberately do not mask it

The readiness audit flagged that PII redaction ships disabled, so SSN, DOB, and credit data sit in cleartext in execution logs and are exported raw to Snowflake. We are **accepting this deliberately**: the ops team needs to read the actual SSN and credit data to do its job (debugging a lead, reconciling a bid, answering a partner). Masking it would break that workflow. We will keep `PII_REDACTION_FIELDS` empty and leave raw PII readable in the execution logs and the Snowflake export.

## Status

accepted (2026-06-23), **reaffirmed with a corrected basis (2026-09-09)**

The decision below is unchanged: PII stays readable and `PII_REDACTION_FIELDS`
stays empty. What changed is that one of the reasons originally given for it
being safe stopped being true, and the ADR went on stating it. See "Correction"
below.

## Context

The audit's top-listed risk was "PII redaction ships disabled" (`apps/worker/wrangler.toml` `PII_REDACTION_FIELDS=""`; raw SSN in `lead_sightings` and the Snowflake export). The redaction mechanism is fully built and can be switched on per-field at any time. The single-org ops team (~2 engineers, ~2 non-technical ops) operates with focus time on a tool that moves real money and must routinely reference the underlying PII. Hiding it behind redaction or a reveal flow would add friction to the core job without a corresponding benefit at the current scale and trust boundary.

## Consequences

- `PII_REDACTION_FIELDS` stays empty; raw SSN/DOB/credit remain in `workflow_executions`/`execution_steps` JSONB and in the Snowflake `lead_sightings` export. This is a conscious tradeoff, not an oversight.
- The blast radius of a log/warehouse breach is correspondingly larger. The compensating control is access scoping (single org, authenticated team). **The short execution-log retention window is no longer one of them: see the correction below.**
- Revisit if the trust boundary changes: a less-trusted role, an external auditor, a regulator requirement (FCRA/GLBA/CCPA), or multi-tenant expansion. The mechanism is already built, so re-enabling is a config change plus a decision about whether the Snowflake copy uses the peppered hash instead of raw SSN.
- This decision does **not** cover the two items that were filed under issue #281 (a versioned/envelope encryption-key scheme so `SECRET_ENCRYPTION_KEY` can rotate without data loss, and an audit of service-role routes for explicit org scoping). Those are about key durability and cross-customer isolation, not about hiding PII from the ops team; #281 is being closed alongside this decision as not-tracked-now, recoverable from the readiness report (`docs/production-readiness/2026-06-22-report.md`).

## Correction (2026-09-09): the retention window is not a compensating control any more

This ADR originally named two compensating controls, and one of them has expired.

**What it said.** "The compensating controls are access scoping (single org,
authenticated team) and the short execution-log retention window." At the time
that was accurate: `workflow_executions` and `execution_steps` were dropped by
partition at 7 days, so unredacted PII in an execution log had a short life.

**What is true now.** [ADR 0009](./0009-never-delete-without-a-backup.md) built
an execution archive that copies both tables into Snowflake and keeps them for
**13 months**. That ADR's own text describes what it protects as "13 months of
unredacted identity data". The archive reads every column
(`apps/worker/src/archive/stream-hour.ts`), so it carries the same cleartext
this ADR chose to allow, for 56 times as long. Neither ADR cited the other, so
this one has read as a current assurance while its stated basis was gone.

**What was decided.** On 2026-09-09 Dan reaffirmed the decision itself, with the
corrected picture in front of him: the ops team still needs to read real SSN and
credit data, so `PII_REDACTION_FIELDS` stays empty. The decision is unchanged;
only the justification is corrected.

**What follows from the correction.**

- Access scoping is now the ONLY compensating control. It carries the weight the
  retention window used to share, which raises what is at stake in
  [#28 Roles and allowlist access control](https://github.com/Try-Pennie/bidspoke/milestone/28)
  and in the erasure path (#823), because there is no longer a date by which the
  data goes away on its own.
- The archive is a PII destination and is enumerated as one. `archived-columns.ts`
  states which archived columns carry personal data and a guard holds that list
  to the schema (#1222).
- The redaction mechanism now reaches step **log lines** as well as `input` and
  `output` (#1214). It stays inert while the field list is empty, which is this
  decision; the point is that enabling it is still only a config change, as this
  ADR promised, rather than a config change plus a gap nobody had noticed.
- "Revisit if the trust boundary changes" above should be read with the archive
  in mind: an external auditor or a regulator request now reaches 13 months of
  cleartext rather than 7 days of it.
