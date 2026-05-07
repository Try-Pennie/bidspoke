/**
 * Salesforce bid matrix audit
 *
 * Pure audit job — fetches every BidRangeRow__c row from Salesforce and
 * diffs it against a snapshot in `sf_bid_matrix_audit`. On any change,
 * posts a Slack alert. Independent of partner_bid_configs.
 *
 * Motivation: Pipedream still owns the bidding code path that reads the
 * matrix. Until Bidspoke takes over and migrations populate
 * partner_bid_configs, no per-partner sync exists, so per-partner alerts
 * never fire. This job exists so SF matrix edits are still auditable in
 * Slack regardless of where the bidding lives.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import { getSalesforceToken } from '../engine/nodes/salesforce'
import { sendMatrixChangeAlert } from './slack'
import type { MatrixConfigChange, MatrixRowEdit, MatrixRowSummary } from './slack'

/** Partner flag columns on BidRangeRow__c we capture as a JSONB blob. */
export const PARTNER_FLAG_FIELDS = [
  'IsSoFi__c',
  'IsEPCVIP__c',
  'IsDot818__c',
  'IsNerdWallet__c',
  'IsBrainsome__c',
  'IsTLG__c',
  'IsAmOne__c',
  'IsAmOneDirect__c',
] as const

type PartnerFlagField = typeof PARTNER_FLAG_FIELDS[number]

interface SalesforceBidRow {
  Id: string
  RowId__c: string | null
  RowLow__c: number | null
  RowHigh__c: number | null
  RangeLow__c: number | null
  RangeHigh__c: number | null
  RangeValue__c: number
  IsSellOff__c: boolean
  IsSoFi__c: boolean
  IsEPCVIP__c: boolean
  IsDot818__c: boolean
  IsNerdWallet__c: boolean
  IsBrainsome__c: boolean
  IsTLG__c: boolean
  IsAmOne__c: boolean
  IsAmOneDirect__c: boolean
}

interface AuditSnapshot {
  source_id: string
  is_sell_off: boolean
  row_id: string | null
  row_low: number | null
  row_high: number | null
  range_low: number | null
  range_high: number | null
  bid_amount: number
  partner_flags: Record<string, boolean>
}

export interface AuditResult {
  rows_fetched: number
  rows_added: number
  rows_edited: number
  rows_removed: number
  alerted: boolean
}

export async function runMatrixAudit(env: Env, supabase: SupabaseClient): Promise<AuditResult> {
  const startedAt = new Date().toISOString()

  const sfRows = await querySalesforceMatrixRows(env)
  const existing = await readSnapshot(supabase)

  const rawEnv = env as unknown as Record<string, string | undefined>
  const instanceUrl = (rawEnv.SALESFORCE_INSTANCE_URL ?? '').replace(/\/$/, '')
  const diff = computeAuditDiff(existing, sfRows)

  // Apply state to the snapshot table — upsert all fetched rows, delete missing ones.
  if (sfRows.length > 0) {
    const records = sfRows.map((r) => toSnapshotRow(r, startedAt))
    const { error } = await supabase
      .from('sf_bid_matrix_audit')
      .upsert(records, { onConflict: 'source_id' })
    if (error) throw new Error(`sf_bid_matrix_audit upsert failed: ${error.message}`)
  }

  const fetchedIds = new Set(sfRows.map((r) => r.Id))
  const removedIds = existing.filter((e) => !fetchedIds.has(e.source_id)).map((e) => e.source_id)
  if (removedIds.length > 0) {
    const { error } = await supabase
      .from('sf_bid_matrix_audit')
      .delete()
      .in('source_id', removedIds)
    if (error) throw new Error(`sf_bid_matrix_audit delete failed: ${error.message}`)
  }

  const result: AuditResult = {
    rows_fetched: sfRows.length,
    rows_added: diff?.added.length ?? 0,
    rows_edited: diff?.edited.length ?? 0,
    rows_removed: diff?.removed.length ?? 0,
    alerted: false,
  }

  if (diff) {
    await notifyAllOrgsWithSlack(supabase, diff, startedAt, deriveBidMatrixListUrl(instanceUrl))
    result.alerted = true
  }

  return result
}

/**
 * PostgREST caps result sets at 1,000 rows by default. The matrix has > 1k SF
 * records (1,230 as of 2026-05-07), so a single SELECT silently truncates and
 * the diff falsely reports the missing tail as "added" on every run. Page
 * through with .range() until a short page comes back.
 */
async function readSnapshot(supabase: SupabaseClient): Promise<AuditSnapshot[]> {
  const PAGE_SIZE = 1000
  const all: AuditSnapshot[] = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('sf_bid_matrix_audit')
      .select('source_id, is_sell_off, row_id, row_low, row_high, range_low, range_high, bid_amount, partner_flags')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`sf_bid_matrix_audit read failed: ${error.message}`)
    const page = (data ?? []) as unknown as AuditSnapshot[]
    all.push(...page)
    if (page.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

// ── Diff ──────────────────────────────────────────────────────────────────────

/**
 * Diff by *content identity* (range bands + sell-off + partner flags) instead
 * of SF record Id. Salesforce flows/triggers occasionally destroy-and-recreate
 * rows on edit, giving each "new" row a fresh Id. If we keyed on Id, those
 * recreate cycles would show up as N added + N removed even though the matrix
 * logic is unchanged. Identity-keyed diff handles them as no-ops; only the
 * actual bid-amount change shows as an edit.
 *
 * Partner-flag toggles still surface as add+remove (different identities) —
 * which is correct: removing SoFi from a row IS a real, alert-worthy change.
 */
export function computeAuditDiff(
  existing: AuditSnapshot[],
  fetched: SalesforceBidRow[]
): MatrixConfigChange | null {
  const beforeBuckets = new Map<string, AuditSnapshot[]>()
  for (const e of existing) {
    const key = identityKey(e)
    const bucket = beforeBuckets.get(key)
    if (bucket) bucket.push(e)
    else beforeBuckets.set(key, [e])
  }

  const added: MatrixRowSummary[] = []
  const edited: MatrixRowEdit[] = []
  const removed: MatrixRowSummary[] = []

  for (const r of fetched) {
    const next = toSnapshotRow(r)
    const key = identityKey(next)
    const bucket = beforeBuckets.get(key)
    if (!bucket || bucket.length === 0) {
      added.push(toSummary(next))
      continue
    }
    const prev = bucket.shift()!
    // Identity matches; bid_amount is the only field left to compare.
    if (!sameValue(prev.bid_amount, next.bid_amount)) {
      edited.push({
        row_id: next.row_id,
        range: describeRange(next) + flagSuffix(next.partner_flags),
        is_sell_off: next.is_sell_off,
        changes: [{ field: 'bid_amount', before: prev.bid_amount, after: next.bid_amount }],
      })
    }
  }

  for (const bucket of beforeBuckets.values()) {
    for (const e of bucket) removed.push(toSummary(e))
  }

  if (added.length === 0 && edited.length === 0 && removed.length === 0) return null
  return {
    partner_slug: 'salesforce_audit',
    config_name: 'BidRangeRow__c (full audit)',
    added,
    edited,
    removed,
  }
}

function identityKey(r: AuditSnapshot): string {
  const flags = PARTNER_FLAG_FIELDS.map((f) => `${f}=${r.partner_flags?.[f] === true ? 1 : 0}`).join(',')
  return [r.is_sell_off, r.row_low, r.row_high, r.range_low, r.range_high, flags].join('|')
}

// ── Salesforce ────────────────────────────────────────────────────────────────

async function querySalesforceMatrixRows(env: Env): Promise<SalesforceBidRow[]> {
  const rawEnv = env as unknown as Record<string, string | undefined>
  const instanceUrl = (rawEnv.SALESFORCE_INSTANCE_URL ?? '').replace(/\/$/, '')
  const clientId = rawEnv.SALESFORCE_CLIENT_ID ?? ''
  const clientSecret = rawEnv.SALESFORCE_CLIENT_SECRET ?? ''

  if (!instanceUrl || !clientId || !clientSecret) {
    throw new Error('SF audit requires SALESFORCE_INSTANCE_URL, SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET')
  }

  // Audit is a worker-level concern; no per-org token namespacing.
  const token = await getSalesforceToken(env, 'sf-matrix-audit', instanceUrl, clientId, clientSecret)

  const fields = [
    'Id', 'RowId__c', 'RowLow__c', 'RowHigh__c', 'RangeLow__c', 'RangeHigh__c',
    'RangeValue__c', 'IsSellOff__c',
    ...PARTNER_FLAG_FIELDS,
  ].join(', ')

  const soql = `SELECT ${fields} FROM BidRangeRow__c ORDER BY RowId__c, RangeLow__c`
  const url = `${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`

  const all: SalesforceBidRow[] = []
  let next: string | undefined = url
  while (next) {
    const res: Response = await fetch(next, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`SF query failed (${res.status}): ${text.slice(0, 500)}`)
    }
    const body = await res.json() as { records: SalesforceBidRow[]; done: boolean; nextRecordsUrl?: string }
    all.push(...body.records)
    next = body.done ? undefined : body.nextRecordsUrl ? `${instanceUrl}${body.nextRecordsUrl}` : undefined
  }
  return all
}

// ── Slack notify ──────────────────────────────────────────────────────────────

async function notifyAllOrgsWithSlack(
  supabase: SupabaseClient,
  change: MatrixConfigChange,
  changedAt: string,
  matrixUrl: string | undefined
): Promise<void> {
  const { data: orgs } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')

  const orgIds = Array.from(new Set(((orgs ?? []) as { organization_id: string }[]).map((r) => r.organization_id)))
  if (orgIds.length === 0) return

  for (const orgId of orgIds) {
    try {
      await sendMatrixChangeAlert(supabase, orgId, null, { changed_at: changedAt, changes: [change], matrix_url: matrixUrl })
    } catch (err) {
      console.error(`[sf-matrix-audit] slack alert failed for org ${orgId}:`, err)
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toSnapshotRow(r: SalesforceBidRow, syncedAt?: string): AuditSnapshot & { source_synced_at?: string; updated_at?: string } {
  const partnerFlags: Record<string, boolean> = {}
  for (const flag of PARTNER_FLAG_FIELDS) {
    partnerFlags[flag] = r[flag as PartnerFlagField] === true
  }
  return {
    source_id: r.Id,
    is_sell_off: r.IsSellOff__c === true,
    row_id: r.RowId__c,
    row_low: r.RowLow__c,
    row_high: r.RowHigh__c,
    range_low: r.RangeLow__c,
    range_high: r.RangeHigh__c,
    bid_amount: Number(r.RangeValue__c),
    partner_flags: partnerFlags,
    ...(syncedAt ? { source_synced_at: syncedAt, updated_at: syncedAt } : {}),
  }
}

function toSummary(r: AuditSnapshot): MatrixRowSummary {
  return {
    row_id: r.row_id,
    range: describeRange(r) + flagSuffix(r.partner_flags),
    is_sell_off: r.is_sell_off,
    bid_amount: Number(r.bid_amount),
  }
}

function flagSuffix(flags: Record<string, boolean>): string {
  const flagged = Object.entries(flags).filter(([, v]) => v).map(([k]) => k.replace(/^Is/, '').replace(/__c$/, ''))
  return flagged.length > 0 ? ` [${flagged.join(', ')}]` : ''
}

/**
 * Build a Lightning URL for the Bid Matrix list view from the SOAP/REST instance URL.
 * Pennie uses `<sub>.my.salesforce.com` for OAuth/REST and `<sub>.lightning.force.com`
 * for the Lightning UI; the subdomain is shared.
 *
 *   https://trypennie.my.salesforce.com → https://trypennie.lightning.force.com/lightning/n/Bid_Matrix
 */
function deriveBidMatrixListUrl(instanceUrl: string): string | undefined {
  if (!instanceUrl) return undefined
  const m = instanceUrl.match(/^https?:\/\/([^.]+)\.my\.salesforce\.com$/)
  if (!m) return undefined
  return `https://${m[1]}.lightning.force.com/lightning/n/Bid_Matrix`
}

/**
 * BidRangeRow__c dimensions per Pennie convention:
 *   Row dimension (RowLow__c/RowHigh__c)     = engine debt in dollars
 *   Range dimension (RangeLow__c/RangeHigh__c) = Vantage Score band
 *
 * Both can be `0–0` (placeholder for "no constraint on this dimension"). Hide
 * those so the alert reads as just the active band(s).
 */
function describeRange(r: { row_low: number | null; row_high: number | null; range_low: number | null; range_high: number | null; row_id: string | null }): string {
  const debt = formatBand(r.row_low, r.row_high)
  const vantage = formatBand(r.range_low, r.range_high)
  const debtLabel = debt ? `Debt $${debt}` : ''
  const vantageLabel = vantage ? `Vantage ${vantage}${vantageTierName(r.range_low, r.range_high)}` : ''
  if (debtLabel && vantageLabel) return `${debtLabel} × ${vantageLabel}`
  return debtLabel || vantageLabel || (r.row_id ?? '—')
}

function formatBand(low: number | null, high: number | null): string {
  if (low === null && high === null) return ''
  if (Number(low) === 0 && Number(high) === 0) return ''
  if (low === null) return `≤${fmtNum(high)}`
  if (high === null) return `≥${fmtNum(low)}`
  return `${fmtNum(low)}–${fmtNum(high)}`
}

function fmtNum(n: number | null): string {
  return n === null ? '?' : Number(n).toLocaleString('en-US')
}

/** Standard Vantage Score tier names — append in parens when bounds match exactly. */
function vantageTierName(low: number | null, high: number | null): string {
  if (low === 301 && high === 499) return ' (Very Poor)'
  if (low === 500 && high === 600) return ' (Poor)'
  if (low === 601 && high === 660) return ' (Fair)'
  if (low === 661 && high === 780) return ' (Good)'
  if (low === 781 && high === 850) return ' (Excellent)'
  return ''
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a === 'number' && typeof b === 'number') return Number(a) === Number(b)
  if (typeof a === 'string' && typeof b === 'number') return parseFloat(a) === b
  if (typeof a === 'number' && typeof b === 'string') return a === parseFloat(b)
  return false
}
