# shellcheck shell=bash
#
# dr-drill-tables.sh: which tables the restore drill copies, sourced by
# scripts/dr-restore-drill.sh.
#
# Every table in the public schema must be in exactly ONE of the two lists.
# apps/web/src/lib/__tests__/dr-drill-table-coverage.test.ts fails in CI when a
# migration creates a table that is in neither, and the drill refuses to run when
# the live database holds one. Both exist because the June 2026 list went stale:
# by September buyer profiles had added its configuration tables, the drill would
# have restored them empty, and its row count check (which compares only the
# copied list) would still have printed PASS.
#
# Partition children (a parent name plus _YYYY_MM) are covered by their parent.

# Tables whose DATA the drill copies: what the engine needs to take and price a
# lead again. An explicit allow-list, never an exclude-glob, because a money and
# PII system must never silently widen what gets copied.
DRILL_COPY_TABLES=(
  # Workflows, org, access
  workflows workflow_versions organizations users user_allowlist folders
  # Sources and endpoints
  api_sources source_workflow_assignments webhook_endpoints
  # Partners and pricing
  partner_configs partner_bid_configs bid_matrix_rows bid_config_history
  partner_uuid_map partner_daily_counts sf_bid_matrix_audit
  # Buyer profiles: pricing, hours, blackouts, and the sales record that caps
  # are counted from and that stops a lead being sold twice
  buyer_profiles buyer_pricing_tiers buyer_operating_windows buyer_blackout_dates
  buyer_sales held_click_claims buyer_select_parity_days
  # Settings, secrets, connections. connection_tombstones goes with
  # service_connections: a restore without it could let a removed connection's
  # last good copy on ops be served again (#2332).
  environment_variables env_var_folders service_connections connection_tombstones service_presets
  app_config app_settings field_presence_silences
  # History small enough to keep
  audit_log workflow_stats_daily
)

# Tables restored as STRUCTURE only. Each is either rebuildable run history or
# holds raw personal data that must not be spread into a throwaway project.
DRILL_STRUCTURE_ONLY_TABLES=(
  # Raw personal data (SSNs and contact details)
  persons lead_sightings lead_sighting_bids achieve_evaluations
  # Failed Salesforce writes held for replay (#1993): encrypted lead fields, and
  # a restore has no use for another day's undelivered patches
  outcome_writeback_deadletters
  # Execution logs, tens of GB, rebuildable and not needed to bid
  workflow_executions execution_steps
  # Execution archive bookkeeping; the archive itself lives outside Supabase
  execution_archive_days execution_archive_hours execution_archive_ids
  execution_archive_progress execution_archive_erasures execution_archive_refusals
  # Monitor and job run history
  job_runs purge_run_log field_presence_daily
  # The incident record (#2100): alert history, not needed to bid
  alert_incidents
  # Partners page live misses (#2135): delivery measurements, not needed to bid
  partner_page_live_misses
  # The cron guard's fail-open record (#2166): seven days of monitor history
  cron_guard_fail_opens
  # The field presence rollup watermark (#1150): one timestamp. After a restore
  # the table is empty, the 15 minute incremental pass refuses loudly, and the
  # next reconcile (the hourly recent job, within the hour) upserts the row and
  # seeds it, so its data need not be restored.
  field_presence_rollup_state
)

# Reads live table names on stdin, one per line, and prints each one that is in
# neither list. Exits 1 when it printed any. A name that is a listed table plus
# _YYYY_MM is a partition of it and counts as classified.
dr_unclassified_tables() {
  local known=" ${DRILL_COPY_TABLES[*]} ${DRILL_STRUCTURE_ONLY_TABLES[*]} "
  local name parent found=0
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    [[ "$known" == *" $name "* ]] && continue
    if [[ "$name" =~ ^(.+)_[0-9]{4}_[0-9]{2}$ ]]; then
      parent="${BASH_REMATCH[1]}"
      [[ "$known" == *" $parent "* ]] && continue
    fi
    printf '%s\n' "$name"
    found=1
  done
  return "$found"
}
