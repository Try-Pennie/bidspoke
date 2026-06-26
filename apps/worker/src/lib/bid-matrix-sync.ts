/**
 * Sync a partner_bid_config's matrix from Salesforce.
 *
 * The Salesforce side of this is the BidRangeRow__c custom object, partitioned
 * per partner via a boolean flag (Is{Partner}__c — see
 * docs/reference/bid-matrix-controller.apex.cls). We mirror those rows into
 * bid_matrix_rows, keyed on the SF record Id (source_id) for delta upserts.
 *
 * sf_filters JSONB on partner_bid_configs scopes the SOQL query. Shape:
 *   { partner_flag: 'IsSoFi__c', extra: 'OtherFlag__c = TRUE' }
 *
 * We always pull both is_sell_off=true and false rows in one query, so the
 * resolver can pick which set to use per lead.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import { getSalesforceToken } from '../engine/nodes/salesforce'
import { parseJson } from './json'
import { sendMatrixChangeAlert, sendMatrixValidationAlert } from './slack'
import type { MatrixConfigChange, MatrixRowEdit, MatrixRowSummary, MatrixConfigProblems } from './slack'
import { fetchAllPaged } from './paginate'
import { validateMatrix } from './bid-matrix-validate'
import type { MatrixProblem } from './bid-matrix-validate'

export interface SyncResult {
  config_id: string
  config_slug: string
  config_name: string
  rows_fetched: number
  rows_upserted: number
  rows_deleted: number
  last_synced_at: string
  diff: MatrixConfigChange | null
  problems: MatrixProblem[]
  organization_id: string
  /** True when this sync skipped the stale-row delete because Salesforce returned
   * an empty result while rows still existed — the matrix was preserved, not
   * applied, and should be confirmed by a human (#407). */
  skipped_empty_delete?: boolean
  error?: string
}

const TRACKED_FIELDS: ReadonlyArray<keyof MatrixRowSnapshot> = [
  'is_sell_off',
  'row_low',
  'row_high',
  'range_low',
  'range_high',
  'bid_amount',
]

interface MatrixRowSnapshot {
  source_id: string | null
  is_sell_off: boolean
  row_id: string | null
  row_low: number | null
  row_high: number | null
  range_low: number | null
  range_high: number | null
  bid_amount: number
}

interface BidConfigForSync {
  id: string
  slug: string
  name: string
  organization_id: string
  sf_object: string | null
  sf_filters: { partner_flag?: string; extra?: string } | null
  sync_source: 'salesforce' | 'manual'
  is_active: boolean
  dimensions: { column: 'row' | 'range'; payload_field?: string }[] | null
}

interface SalesforceBidRow {
  Id: string
  RowId__c: string | null
  RowLow__c: number | null
  RowHigh__c: number | null
  RangeLow__c: number | null
  RangeHigh__c: number | null
  RangeValue__c: number
  IsSellOff__c: boolean
}

export async function syncBidConfig(
  configId: string,
  env: Env,
  supabase: SupabaseClient
): Promise<SyncResult> {
  const { data: rawConfig, error: configErr } = await supabase
    .from('partner_bid_configs')
    .select('id, slug, name, organization_id, sf_object, sf_filters, sync_source, is_active, dimensions')
    .eq('id', configId)
    .single()

  if (configErr || !rawConfig) {
    throw new Error(`partner_bid_config not found: ${configId}`)
  }

  const config = rawConfig as unknown as BidConfigForSync

  if (config.sync_source !== 'salesforce') {
    throw new Error(`Config ${config.slug} sync_source is '${config.sync_source}', not 'salesforce'`)
  }
  if (!config.sf_object) {
    throw new Error(`Config ${config.slug} has no sf_object configured`)
  }

  const startedAt = new Date().toISOString()

  try {
    const rows = await querySalesforceMatrixRows(config, env)
    const { upserted, deleted, diff, skippedEmptyDelete } = await applyToDb(config, rows, startedAt, supabase)
    const problems = validateSyncedRows(config, rows)

    await supabase
      .from('partner_bid_configs')
      .update({ last_synced_at: startedAt, last_sync_error: null })
      .eq('id', configId)

    if (diff) {
      await writeHistory(configId, supabase, {
        rows_fetched: rows.length,
        rows_upserted: upserted,
        rows_deleted: deleted,
        added: diff.added,
        removed: diff.removed,
        edited: diff.edited,
      })
    }

    return {
      config_id: configId,
      config_slug: config.slug,
      config_name: config.name,
      organization_id: config.organization_id,
      rows_fetched: rows.length,
      rows_upserted: upserted,
      rows_deleted: deleted,
      last_synced_at: startedAt,
      diff,
      problems,
      skipped_empty_delete: skippedEmptyDelete,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabase
      .from('partner_bid_configs')
      .update({ last_synced_at: startedAt, last_sync_error: message })
      .eq('id', configId)
    throw err
  }
}

async function querySalesforceMatrixRows(
  config: BidConfigForSync,
  env: Env
): Promise<SalesforceBidRow[]> {
  // SF creds are CF secrets; pull them off the env loosely (they aren't typed on Env).
  const rawEnv = env as unknown as Record<string, string | undefined>
  const instanceUrl = (rawEnv.SALESFORCE_INSTANCE_URL ?? '').replace(/\/$/, '')
  const clientId = rawEnv.SALESFORCE_CLIENT_ID ?? ''
  const clientSecret = rawEnv.SALESFORCE_CLIENT_SECRET ?? ''

  if (!instanceUrl || !clientId || !clientSecret) {
    throw new Error('Salesforce env vars (SALESFORCE_INSTANCE_URL, SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET) are required for matrix sync')
  }

  const token = await getSalesforceToken(env, config.organization_id, instanceUrl, clientId, clientSecret)

  // Build a SOQL where clause that scopes to this partner's slice.
  // partner_flag is the Is{Partner}__c boolean. extra is an arbitrary clause appended with AND.
  const whereParts: string[] = []
  const filters = config.sf_filters ?? {}
  if (filters.partner_flag) {
    whereParts.push(`${filters.partner_flag} = TRUE`)
  } else {
    // Default config: all partner flags FALSE (matches Apex getBidRangeRows())
    whereParts.push('IsSoFi__c = FALSE AND IsEPCVIP__c = FALSE AND IsDot818__c = FALSE AND IsNerdWallet__c = FALSE AND IsBrainsome__c = FALSE AND IsTLG__c = FALSE AND IsAmOne__c = FALSE AND IsAmOneDirect__c = FALSE')
  }
  if (filters.extra) whereParts.push(filters.extra)

  const soql =
    `SELECT Id, RowId__c, RowLow__c, RowHigh__c, RangeLow__c, RangeHigh__c, RangeValue__c, IsSellOff__c ` +
    `FROM ${config.sf_object} ` +
    `WHERE ${whereParts.join(' AND ')} ` +
    `ORDER BY RowId__c, RangeLow__c`

  const url = `${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`

  const all: SalesforceBidRow[] = []
  let next: string | undefined = url
  while (next) {
    const res: Response = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Salesforce query failed (${res.status}): ${text.slice(0, 500)}`)
    }
    const body = await parseJson<{ records: SalesforceBidRow[]; done: boolean; nextRecordsUrl?: string }>(res)
    all.push(...body.records)
    next = body.done ? undefined : body.nextRecordsUrl ? `${instanceUrl}${body.nextRecordsUrl}` : undefined
  }
  return all
}

async function applyToDb(
  config: BidConfigForSync,
  rows: SalesforceBidRow[],
  syncedAt: string,
  supabase: SupabaseClient
): Promise<{ upserted: number; deleted: number; diff: MatrixConfigChange | null; skippedEmptyDelete: boolean }> {
  // Snapshot existing rows BEFORE the upsert so we can diff against the new state.
  const existing = await fetchAllPaged<MatrixRowSnapshot>(
    (from, to) => supabase
      .from('bid_matrix_rows')
      .select('id, source_id, is_sell_off, row_id, row_low, row_high, range_low, range_high, bid_amount')
      .eq('config_id', config.id)
      .order('id', { ascending: true })
      .range(from, to),
    'existing-row query',
  )

  // Upsert all rows keyed on (config_id, source_id).
  if (rows.length > 0) {
    const records = rows.map((r) => ({
      config_id: config.id,
      source_id: r.Id,
      source_synced_at: syncedAt,
      is_sell_off: r.IsSellOff__c === true,
      row_id: r.RowId__c,
      row_low: r.RowLow__c,
      row_high: r.RowHigh__c,
      range_low: r.RangeLow__c,
      range_high: r.RangeHigh__c,
      bid_amount: r.RangeValue__c,
      updated_at: syncedAt,
    }))
    const { error } = await supabase
      .from('bid_matrix_rows')
      .upsert(records, { onConflict: 'config_id,source_id' })
    if (error) throw new Error(`bid_matrix_rows upsert failed: ${error.message}`)
  }

  // A successful-but-empty Salesforce fetch must NOT delete the whole matrix.
  // With no rows upserted this run, EVERY existing row looks stale below, so an
  // unguarded delete wipes the matrix and the partner stops bidding until the next
  // good sync. A 200 with records:[] (SF glitch, a renamed Is{Partner}__c flag,
  // filter/schema drift) is far likelier than every range being legitimately
  // removed at once, so we skip the delete, keep the last-known matrix, and signal
  // it for a human to confirm (#407). A genuine full-clear is done manually.
  const skippedEmptyDelete = shouldSkipStaleDelete(rows.length, existing.length)
  let deleteIds: string[] = []
  let removedSourceIds = new Set<string>()

  if (skippedEmptyDelete) {
    console.error(
      `[bid-matrix-sync] empty Salesforce fetch for config ${config.id} (${config.slug}) ` +
        `but ${existing.length} rows exist — skipping delete to avoid wiping the matrix`,
    )
  } else {
    // Delete rows that weren't part of this sync (no longer present in SF).
    const staleRows = await fetchAllPaged<{ id: string; source_id: string | null }>(
      (from, to) => supabase
        .from('bid_matrix_rows')
        .select('id, source_id')
        .eq('config_id', config.id)
        .or(`source_synced_at.lt.${syncedAt},source_synced_at.is.null`)
        .order('id', { ascending: true })
        .range(from, to),
      'stale-row query',
    )
    deleteIds = staleRows.map((r) => r.id)
    removedSourceIds = new Set(staleRows.map((r) => r.source_id).filter((s): s is string => !!s))

    if (deleteIds.length > 0) {
      const { error: delErr } = await supabase
        .from('bid_matrix_rows')
        .delete()
        .in('id', deleteIds)
      if (delErr) throw new Error(`bid_matrix_rows delete failed: ${delErr.message}`)
    }
  }

  const diff = computeDiff(config, existing, rows, removedSourceIds)
  return { upserted: rows.length, deleted: deleteIds.length, diff, skippedEmptyDelete }
}

/**
 * Guard against an empty Salesforce fetch wiping the entire matrix (#407): skip the
 * stale-row delete only when the fetch returned nothing AND rows currently exist.
 * A partial fetch (some rows, fewer than existing) is a legitimate removal and must
 * still delete; a first-time populate (rows fetched, none existed) is not a wipe.
 */
export function shouldSkipStaleDelete(fetchedCount: number, existingCount: number): boolean {
  return fetchedCount === 0 && existingCount > 0
}

export function computeDiff(
  config: { slug: string; name: string },
  existing: MatrixRowSnapshot[],
  fetched: SalesforceBidRow[],
  removedSourceIds: Set<string>
): MatrixConfigChange | null {
  const before = new Map<string, MatrixRowSnapshot>()
  for (const r of existing) {
    if (r.source_id) before.set(r.source_id, r)
  }

  const added: MatrixRowSummary[] = []
  const edited: MatrixRowEdit[] = []
  const removed: MatrixRowSummary[] = []

  for (const r of fetched) {
    const next: MatrixRowSnapshot = {
      source_id: r.Id,
      is_sell_off: r.IsSellOff__c === true,
      row_id: r.RowId__c,
      row_low: r.RowLow__c,
      row_high: r.RowHigh__c,
      range_low: r.RangeLow__c,
      range_high: r.RangeHigh__c,
      bid_amount: Number(r.RangeValue__c),
    }
    const prev = before.get(r.Id)
    if (!prev) {
      added.push(toSummary(next))
      continue
    }
    const changes: MatrixRowEdit['changes'] = []
    for (const field of TRACKED_FIELDS) {
      if (!sameValue(prev[field], next[field])) {
        changes.push({ field, before: prev[field], after: next[field] })
      }
    }
    if (changes.length > 0) {
      edited.push({
        row_id: next.row_id,
        range: describeRange(next),
        is_sell_off: next.is_sell_off,
        changes,
      })
    }
  }

  for (const r of existing) {
    if (r.source_id && removedSourceIds.has(r.source_id)) {
      removed.push(toSummary(r))
    }
  }

  if (added.length === 0 && edited.length === 0 && removed.length === 0) return null
  return {
    partner_slug: config.slug,
    config_name: config.name,
    added,
    edited,
    removed,
  }
}

function toSummary(r: MatrixRowSnapshot): MatrixRowSummary {
  return {
    row_id: r.row_id,
    range: describeRange(r),
    is_sell_off: r.is_sell_off,
    bid_amount: Number(r.bid_amount),
  }
}

function describeRange(r: MatrixRowSnapshot): string {
  const row = formatBand(r.row_low, r.row_high)
  const range = formatBand(r.range_low, r.range_high)
  if (range && row) return `${row} × ${range}`
  return row || range || (r.row_id ?? '—')
}

function formatBand(low: number | null, high: number | null): string {
  if (low === null && high === null) return ''
  if (low === null) return `≤${high}`
  if (high === null) return `≥${low}`
  return `${low}–${high}`
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a === 'number' && typeof b === 'number') return Number(a) === Number(b)
  if (typeof a === 'string' && typeof b === 'number') return parseFloat(a) === b
  if (typeof a === 'number' && typeof b === 'string') return a === parseFloat(b)
  return false
}

// Validate the just-synced matrix structure (#182). Uses the SF rows we just
// wrote (the new DB state) so no re-query is needed. Axis labels come from the
// config's dimensions (the payload field name) so messages read in domain terms
// (e.g. "credit_score") instead of the generic "row"/"range".
export function validateSyncedRows(
  config: { dimensions: { column: 'row' | 'range'; payload_field?: string }[] | null },
  rows: SalesforceBidRow[]
): MatrixProblem[] {
  const dims = config.dimensions ?? []
  const rowLabel = dims.find((d) => d.column === 'row')?.payload_field || 'row'
  const rangeLabel = dims.find((d) => d.column === 'range')?.payload_field || 'range'
  return validateMatrix(
    rows.map((r) => ({
      is_sell_off: r.IsSellOff__c === true,
      row_low: r.RowLow__c,
      row_high: r.RowHigh__c,
      range_low: r.RangeLow__c,
      range_high: r.RangeHigh__c,
    })),
    rowLabel,
    rangeLabel,
  )
}

async function writeHistory(
  configId: string,
  supabase: SupabaseClient,
  diff: Record<string, unknown>
): Promise<void> {
  await supabase.from('bid_config_history').insert({
    config_id: configId,
    source: 'salesforce_sync',
    diff,
  })
}

async function notifyMatrixChanges(
  supabase: SupabaseClient,
  successes: SyncResult[]
): Promise<void> {
  const byOrg = new Map<string, MatrixConfigChange[]>()
  for (const r of successes) {
    if (!r.diff) continue
    const list = byOrg.get(r.organization_id) ?? []
    list.push(r.diff)
    byOrg.set(r.organization_id, list)
  }
  if (byOrg.size === 0) return

  const changedAt = new Date().toISOString()
  for (const [orgId, changes] of byOrg) {
    try {
      await sendMatrixChangeAlert(supabase, orgId, null, { changed_at: changedAt, changes })
    } catch (err) {
      console.error(`[bid-matrix-sync] slack alert failed for org ${orgId}:`, err)
    }
  }
}

// Alert on structurally malformed matrices (#182). Aggregated per org and fired
// every sync while a matrix stays broken — the hourly cadence is the rate limit.
export async function notifyMatrixProblems(
  supabase: SupabaseClient,
  successes: SyncResult[]
): Promise<void> {
  const byOrg = new Map<string, MatrixConfigProblems[]>()
  for (const r of successes) {
    if (r.problems.length === 0) continue
    const list = byOrg.get(r.organization_id) ?? []
    list.push({ partner_slug: r.config_slug, config_name: r.config_name, problems: r.problems })
    byOrg.set(r.organization_id, list)
  }
  if (byOrg.size === 0) return

  const checkedAt = new Date().toISOString()
  for (const [orgId, configs] of byOrg) {
    try {
      await sendMatrixValidationAlert(supabase, orgId, null, { checked_at: checkedAt, configs })
    } catch (err) {
      console.error(`[bid-matrix-sync] validation alert failed for org ${orgId}:`, err)
    }
  }
}

/**
 * Cron entry point — sync every active partner_bid_config with sync_source='salesforce'.
 * Errors on one config don't stop the others; they're recorded on the config's
 * last_sync_error column.
 */
export async function syncAllSalesforceConfigs(
  env: Env,
  supabase: SupabaseClient
): Promise<{ successes: SyncResult[]; failures: { config_id: string; error: string }[] }> {
  const { data: configs, error } = await supabase
    .from('partner_bid_configs')
    .select('id')
    .eq('sync_source', 'salesforce')
    .eq('is_active', true)

  if (error) throw new Error(`failed to list configs: ${error.message}`)

  const successes: SyncResult[] = []
  const failures: { config_id: string; error: string }[] = []

  for (const c of (configs ?? []) as { id: string }[]) {
    try {
      const result = await syncBidConfig(c.id, env, supabase)
      successes.push(result)
    } catch (err) {
      failures.push({ config_id: c.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  await notifyMatrixChanges(supabase, successes)
  await notifyMatrixProblems(supabase, successes)

  return { successes, failures }
}
