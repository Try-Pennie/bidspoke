/**
 * What the execution archive actually holds (#1222).
 *
 * `stream-hour.ts` reads both tables with `.select('*')`, and it KEEPS doing
 * so on purpose: the archive is a backup, and an explicit column list would
 * silently omit a newly added column from it, which for a backup is worse than
 * the disclosure it would prevent (L657). What was missing was not the list in
 * the query, it was a stated list anywhere at all. Without one, "what is in the
 * 13 month archive" could only be answered by whatever the schema happened to
 * be at the last hourly run.
 *
 * So this is a manifest rather than a projection. Nothing reads it to build a
 * query. `archived-columns.test.ts` holds it against the generated types, which
 * CI already gates as regenerated alongside any migration, so adding a column
 * to either table turns this guard red until somebody answers whether the new
 * column belongs in 13 month storage and whether it carries personal data.
 *
 * `carriesPersonalData` is the field the erasure path (#823) and the data
 * classification map are the consumers of. It is set conservatively: true where
 * the column CAN carry consumer-supplied content, not only where it is known to
 * today. A false negative here becomes an erasure that misses data, which is
 * the failure that looks done.
 */
export interface ArchivedColumn {
  readonly name: string
  readonly carriesPersonalData: boolean
}

/** `workflow_executions`, as archived. */
export const ARCHIVED_EXECUTION_COLUMNS: readonly ArchivedColumn[] = [
  { name: 'completed_at', carriesPersonalData: false },
  { name: 'cost_usd', carriesPersonalData: false },
  { name: 'cpu_ms', carriesPersonalData: false },
  { name: 'duration_ms', carriesPersonalData: false },
  { name: 'email_dropped', carriesPersonalData: false },
  // Can quote an upstream response body, and one path logs a 200 character
  // snippet of a failed Salesforce response, which echoes field values.
  { name: 'error_message', carriesPersonalData: true },
  { name: 'failed_step_type', carriesPersonalData: false },
  // Field NAMES rather than values, by construction. Listed as not carrying
  // personal data on that basis, which is a claim worth re-checking if its
  // writer ever starts recording what a field contained.
  { name: 'field_presence', carriesPersonalData: false },
  { name: 'final_node_id', carriesPersonalData: false },
  { name: 'final_node_namespace', carriesPersonalData: false },
  { name: 'id', carriesPersonalData: false },
  { name: 'is_test', carriesPersonalData: false },
  { name: 'outcome', carriesPersonalData: false },
  { name: 'parent_execution_id', carriesPersonalData: false },
  // The response we sent, which for a bidding flow can restate lead fields.
  { name: 'response_body', carriesPersonalData: true },
  { name: 'response_status', carriesPersonalData: false },
  { name: 'resumed_from_execution_id', carriesPersonalData: false },
  // Summarises the lead sighting, so it can carry identity fields.
  { name: 'sighting_finalize', carriesPersonalData: true },
  { name: 'slack_alert_fired_at', carriesPersonalData: false },
  // Free-form reason payload that can quote the failure, and a failure quotes
  // its subject.
  { name: 'slack_alert_reason', carriesPersonalData: true },
  { name: 'slack_alert_type', carriesPersonalData: false },
  { name: 'source', carriesPersonalData: false },
  { name: 'started_at', carriesPersonalData: false },
  { name: 'status', carriesPersonalData: false },
  { name: 'trace_id', carriesPersonalData: false },
  // The lead as it arrived: name, address, date of birth, SSN.
  { name: 'trigger_payload', carriesPersonalData: true },
  { name: 'trigger_type', carriesPersonalData: false },
  { name: 'workflow_id', carriesPersonalData: false },
  { name: 'workflow_version_id', carriesPersonalData: false },
]

/** `execution_steps`, as archived. */
export const ARCHIVED_STEP_COLUMNS: readonly ArchivedColumn[] = [
  { name: 'completed_at', carriesPersonalData: false },
  { name: 'duration_ms', carriesPersonalData: false },
  { name: 'error_message', carriesPersonalData: true },
  { name: 'error_type', carriesPersonalData: false },
  { name: 'execution_id', carriesPersonalData: false },
  { name: 'execution_started_at', carriesPersonalData: false },
  { name: 'id', carriesPersonalData: false },
  // The step's input, which on a partner call is the applicant.
  { name: 'input', carriesPersonalData: true },
  { name: 'is_test', carriesPersonalData: false },
  // Found holding an applicant SSN in plain text (#1214). The redactor reaches
  // it as of that issue, but only when PII_REDACTION_FIELDS is set, which under
  // ADR 0006 it deliberately is not.
  { name: 'logs', carriesPersonalData: true },
  { name: 'output', carriesPersonalData: true },
  { name: 'parallel_group_id', carriesPersonalData: false },
  { name: 'retries_used', carriesPersonalData: false },
  { name: 'started_at', carriesPersonalData: false },
  { name: 'status', carriesPersonalData: false },
  { name: 'step_namespace', carriesPersonalData: false },
  { name: 'step_node_id', carriesPersonalData: false },
  { name: 'step_order', carriesPersonalData: false },
  { name: 'step_subtype', carriesPersonalData: false },
  { name: 'step_type', carriesPersonalData: false },
  { name: 'workflow_id', carriesPersonalData: false },
]
