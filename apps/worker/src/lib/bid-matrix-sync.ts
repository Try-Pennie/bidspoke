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

export interface SyncResult {
  config_id: string
  config_slug: string
  rows_fetched: number
  rows_upserted: number
  rows_deleted: number
  last_synced_at: string
  error?: string
}

interface BidConfigForSync {
  id: string
  slug: string
  organization_id: string
  sf_object: string | null
  sf_filters: { partner_flag?: string; extra?: string } | null
  sync_source: 'salesforce' | 'manual'
  is_active: boolean
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
    .select('id, slug, organization_id, sf_object, sf_filters, sync_source, is_active')
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
    const { upserted, deleted } = await applyToDb(configId, rows, startedAt, supabase)

    await supabase
      .from('partner_bid_configs')
      .update({ last_synced_at: startedAt, last_sync_error: null })
      .eq('id', configId)

    await writeHistory(configId, supabase, {
      source: 'salesforce_sync',
      rows_fetched: rows.length,
      rows_upserted: upserted,
      rows_deleted: deleted,
    })

    return {
      config_id: configId,
      config_slug: config.slug,
      rows_fetched: rows.length,
      rows_upserted: upserted,
      rows_deleted: deleted,
      last_synced_at: startedAt,
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
    const body = await res.json() as { records: SalesforceBidRow[]; done: boolean; nextRecordsUrl?: string }
    all.push(...body.records)
    next = body.done ? undefined : body.nextRecordsUrl ? `${instanceUrl}${body.nextRecordsUrl}` : undefined
  }
  return all
}

async function applyToDb(
  configId: string,
  rows: SalesforceBidRow[],
  syncedAt: string,
  supabase: SupabaseClient
): Promise<{ upserted: number; deleted: number }> {
  // Upsert all rows keyed on (config_id, source_id).
  if (rows.length > 0) {
    const records = rows.map((r) => ({
      config_id: configId,
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

  // Delete rows that weren't part of this sync (no longer present in SF).
  const { data: stale, error: staleErr } = await supabase
    .from('bid_matrix_rows')
    .select('id')
    .eq('config_id', configId)
    .or(`source_synced_at.lt.${syncedAt},source_synced_at.is.null`)

  if (staleErr) throw new Error(`stale-row query failed: ${staleErr.message}`)
  const deleteIds = (stale ?? []).map((r) => (r as { id: string }).id)

  if (deleteIds.length > 0) {
    const { error: delErr } = await supabase
      .from('bid_matrix_rows')
      .delete()
      .in('id', deleteIds)
    if (delErr) throw new Error(`bid_matrix_rows delete failed: ${delErr.message}`)
  }

  return { upserted: rows.length, deleted: deleteIds.length }
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

  return { successes, failures }
}
