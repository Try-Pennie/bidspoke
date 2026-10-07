/**
 * Salesforce bid matrix audit
 *
 * Pure audit job: fetches every BidRangeRow__c row from Salesforce and diffs it
 * against a snapshot in `sf_bid_matrix_audit`. On any change, posts one Slack
 * message per matrix that changed, naming the matrix and who changed it
 * (#1864). Independent of partner_bid_configs.
 *
 * Motivation: Pipedream still owns the bidding code path that reads the
 * matrix. Until Bidspoke takes over and migrations populate
 * partner_bid_configs, no per-partner sync exists, so per-partner alerts
 * never fire. This job exists so SF matrix edits are still auditable in
 * Slack regardless of where the bidding lives.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logReadFailure } from './scheduled-read'
import type { Env } from '../index'
import { getSalesforceToken } from '../engine/nodes/salesforce'
import { requireSalesforceCreds, resolveSalesforceCredentialOrg } from './salesforce-creds'
import { getSlackConnection, postMessage } from './slack'
import { parseJson } from './json'
import { fetchAllPaged } from './paginate'
import { fetchPartnerFlags, type PartnerFlag } from './bid-range-flags'
import { buildMatrixAuditMessage, type MatrixAuditAlert, type MatrixCellChange } from './matrix-audit-message'

interface SalesforceBidRow {
  Id: string
  RowId__c: string | null
  RowLow__c: number | null
  RowHigh__c: number | null
  RangeLow__c: number | null
  RangeHigh__c: number | null
  RangeValue__c: number
  IsSellOff__c: boolean
  LastModifiedDate?: string
  LastModifiedBy?: { Name: string | null } | null
  /** One boolean per partner checkbox, named by fetchPartnerFlags. */
  [partnerFlag: string]: unknown
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
  updated_at?: string
}

/** One matrix's differences from the snapshot, before who made them is looked up. */
export interface MatrixAuditChange {
  /** Sell-off or regular, then the partner checkboxes that are set. */
  key: string
  matrix: string
  is_sell_off: boolean
  cells: MatrixCellChange[]
}

export interface BaselineDecision {
  baseline: boolean
  reason: 'empty' | 'flags_changed' | null
  /** Labels of partners Salesforce has that the snapshot never tracked. */
  added: string[]
  /** API names the snapshot tracked that Salesforce no longer has. */
  removed: string[]
}

export interface AuditResult {
  rows_fetched: number
  rows_added: number
  rows_edited: number
  rows_removed: number
  matrices_changed: number
  /** The snapshot was rebuilt without comparing (empty, or the partner list changed). */
  baseline: boolean
  alerted: boolean
}

export async function runMatrixAudit(env: Env, supabase: SupabaseClient): Promise<AuditResult> {
  const startedAt = new Date().toISOString()

  // Worker-level, so it has no organization of its own: the one holding the
  // global credentials is resolved from the data (#1174), and a lookup that
  // cannot name exactly one refuses rather than reading as the wrong tenant.
  const { orgId, error: orgError } = await resolveSalesforceCredentialOrg(supabase)
  if (!orgId) throw new Error(`SF audit cannot resolve the Salesforce credential org: ${orgError}`)
  const { instanceUrl, clientId, clientSecret } = await requireSalesforceCreds(env, supabase, orgId, 'the bid matrix audit')
  // Audit is a worker-level concern; no per-org token namespacing.
  const token = await getSalesforceToken(env, 'sf-matrix-audit', instanceUrl, clientId, clientSecret)

  const flags = await fetchPartnerFlags(instanceUrl, token)
  const sfRows = await querySalesforce<SalesforceBidRow>(
    instanceUrl,
    token,
    `SELECT ${rowFields(flags)} FROM BidRangeRow__c ORDER BY RowId__c, RangeLow__c, Id`,
  )
  const existing = await readSnapshot(supabase)
  const matrixUrl = deriveBidMatrixListUrl(instanceUrl)

  const decision = decideBaseline(existing, flags)
  if (decision.baseline) {
    // Nothing trustworthy to compare against, so record what is there now and
    // say so once, rather than reporting every row as an edit made this hour.
    if (sfRows.length > 0) await writeSnapshot(supabase, existing, sfRows, flags, startedAt)
    await notifyBaseline(supabase, decision, sfRows.length, matrixUrl)
    return { rows_fetched: sfRows.length, rows_added: 0, rows_edited: 0, rows_removed: 0, matrices_changed: 0, baseline: true, alerted: false }
  }

  const changes = computeAuditDiff(existing, sfRows, flags)
  const cells = changes.flatMap((c) => c.cells)
  const result: AuditResult = {
    rows_fetched: sfRows.length,
    rows_added: cells.filter((c) => c.before === null).length,
    rows_edited: cells.filter((c) => c.before !== null && c.after !== null).length,
    rows_removed: cells.filter((c) => c.after === null).length,
    matrices_changed: changes.length,
    baseline: false,
    alerted: false,
  }

  // Alert BEFORE advancing the snapshot. This audit exists because a silent
  // mid-day matrix edit broke bidding for ~3 hours, so a lost alert is the one
  // failure mode it must not have. If delivery fails we leave the snapshot
  // stale so the next hourly run re-diffs the same change and retries. (A
  // duplicate alert to an already-notified org on a partial failure is
  // acceptable; a lost matrix-change alert is not.)
  let delivered = true
  if (changes.length > 0) {
    const since = newestUpdate(existing)
    const deleted = await readDeletedSince(instanceUrl, token, flags, since)
    const touched = sfRows.concat(deleted.rows)
    const alerts: MatrixAuditAlert[] = changes.map((c) => ({
      matrix: c.matrix,
      is_sell_off: c.is_sell_off,
      cells: c.cells,
      ...editorsFor(c, touched, since, flags),
      earlier_saves_unread: !deleted.read,
    }))
    delivered = await notifyAllOrgsWithSlack(supabase, alerts, new Date(), matrixUrl)
    result.alerted = delivered
  }

  // Advance the snapshot only when there's nothing pending to alert, or the
  // alert was delivered.
  if (changes.length === 0 || delivered) {
    if (sfRows.length > 0) await writeSnapshot(supabase, existing, sfRows, flags, startedAt)
  }

  return result
}

async function writeSnapshot(
  supabase: SupabaseClient,
  existing: AuditSnapshot[],
  sfRows: SalesforceBidRow[],
  flags: PartnerFlag[],
  syncedAt: string,
): Promise<void> {
  const records = sfRows.map((r) => ({ ...toSnapshotRow(r, flags), source_synced_at: syncedAt, updated_at: syncedAt }))
  const { error } = await supabase
    .from('sf_bid_matrix_audit')
    .upsert(records, { onConflict: 'source_id' })
  if (error) throw new Error(`sf_bid_matrix_audit upsert failed: ${error.message}`)

  const fetchedIds = new Set(sfRows.map((r) => r.Id))
  const removedIds = existing.filter((e) => !fetchedIds.has(e.source_id)).map((e) => e.source_id)
  if (removedIds.length > 0) {
    // zero-row-ok: idempotent cleanup of source_ids observed missing moments
    // earlier; a concurrent audit having already removed them is success.
    const { error: deleteError } = await supabase
      .from('sf_bid_matrix_audit')
      .delete()
      .in('source_id', removedIds)
    if (deleteError) throw new Error(`sf_bid_matrix_audit delete failed: ${deleteError.message}`)
  }
}

/**
 * PostgREST caps result sets at 1,000 rows by default. The matrix has > 1k SF
 * records (1,545 as of 2026-10-07), so a single SELECT silently truncates and
 * the diff falsely reports the missing tail as "added" on every run. Page
 * through with .range() until a short page comes back.
 */
async function readSnapshot(supabase: SupabaseClient): Promise<AuditSnapshot[]> {
  return fetchAllPaged<AuditSnapshot>(
    (from, to) => supabase
      .from('sf_bid_matrix_audit')
      .select('source_id, is_sell_off, row_id, row_low, row_high, range_low, range_high, bid_amount, partner_flags, updated_at')
      // Stable ordering keeps OFFSET pagination from skipping/duplicating rows across pages.
      .order('source_id', { ascending: true })
      .range(from, to),
    'sf_bid_matrix_audit read',
  )
}

/** When the snapshot was last advanced, which is when the previous good run ended. */
function newestUpdate(existing: AuditSnapshot[]): string | null {
  let newest: Date | null = null
  for (const e of existing) {
    // An unparseable stamp is skipped rather than compared, where it would lose
    // every comparison and leave no lower bound to read the saves from.
    const at = e.updated_at ? new Date(e.updated_at) : null
    if (at && !Number.isNaN(at.getTime()) && (newest === null || at > newest)) newest = at
  }
  return newest ? newest.toISOString() : null
}

// ── Baseline ──────────────────────────────────────────────────────────────────

/**
 * A snapshot can only be compared against if it tracks the same partners
 * Salesforce has. When a partner checkbox is added, every row of that partner's
 * matrix reads as the default matrix in the old snapshot, so a diff would
 * report hundreds of edits nobody made. An empty snapshot (#1176) has nothing
 * to compare at all. Both rebuild the snapshot instead of alerting.
 */
export function decideBaseline(existing: AuditSnapshot[], flags: PartnerFlag[]): BaselineDecision {
  if (existing.length === 0) return { baseline: true, reason: 'empty', added: [], removed: [] }
  const tracked = new Set<string>()
  for (const e of existing) for (const k of Object.keys(e.partner_flags ?? {})) tracked.add(k)
  const live = new Set(flags.map((f) => f.field))
  const added = flags.filter((f) => !tracked.has(f.field)).map((f) => f.label)
  const removed = [...tracked].filter((f) => !live.has(f)).sort()
  if (added.length === 0 && removed.length === 0) return { baseline: false, reason: null, added: [], removed: [] }
  return { baseline: true, reason: 'flags_changed', added, removed }
}

// ── Diff ──────────────────────────────────────────────────────────────────────

/**
 * Diff each matrix by band rather than by Salesforce record Id. The Bid Matrix
 * screen deletes and recreates every row of a matrix on each save, so Ids
 * change on every edit and only the bid amount of a band says whether anything
 * really moved. The matrix is part of the identity, so two matrices holding the
 * same band are never compared with each other (#1864).
 */
export function computeAuditDiff(
  existing: AuditSnapshot[],
  fetched: SalesforceBidRow[],
  flags: PartnerFlag[],
): MatrixAuditChange[] {
  const before = existing.map((e) => ({ ...e, bid_amount: Number(e.bid_amount) }))
  const after = fetched.map((r) => toSnapshotRow(r, flags))

  const buckets = new Map<string, { before: number[]; after: number[]; row: AuditSnapshot }>()
  const bucketOf = (s: AuditSnapshot) => {
    const key = `${matrixKey(s, flags)}#${s.row_low}|${s.row_high}|${s.range_low}|${s.range_high}`
    let b = buckets.get(key)
    if (!b) {
      b = { before: [], after: [], row: s }
      buckets.set(key, b)
    }
    return b
  }
  for (const s of before) bucketOf(s).before.push(s.bid_amount)
  for (const s of after) bucketOf(s).after.push(s.bid_amount)

  const byMatrix = new Map<string, MatrixAuditChange>()
  for (const { before: was, after: now, row } of buckets.values()) {
    const changed = pairBids(was, now)
    if (changed.length === 0) continue
    const key = matrixKey(row, flags)
    let change = byMatrix.get(key)
    if (!change) {
      change = { key, matrix: matrixName(row, flags), is_sell_off: row.is_sell_off === true, cells: [] }
      byMatrix.set(key, change)
    }
    for (const [b, a] of changed) {
      change.cells.push({
        debt: { low: num(row.row_low), high: num(row.row_high) },
        vantage: { low: num(row.range_low), high: num(row.range_high) },
        before: b,
        after: a,
      })
    }
  }

  const low = (n: number | null) => n ?? -Infinity
  for (const change of byMatrix.values()) {
    change.cells.sort((a, b) => low(a.debt.low) - low(b.debt.low) || low(a.vantage.low) - low(b.vantage.low))
  }
  return [...byMatrix.values()].sort((x, y) =>
    x.matrix.localeCompare(y.matrix) || Number(x.is_sell_off) - Number(y.is_sell_off),
  )
}

/**
 * Pairs the bids one band held before with the ones it holds now. Equal amounts
 * pair first, so a band holding two rows can never produce an edit by matching
 * them across each other in whatever order they arrived; what is left pairs
 * low to low, and the remainder is bids added or deleted.
 */
function pairBids(was: number[], now: number[]): Array<[number | null, number | null]> {
  const left = [...was]
  const right: number[] = []
  for (const n of now) {
    const i = left.findIndex((w) => sameAmount(w, n))
    if (i >= 0) left.splice(i, 1)
    else right.push(n)
  }
  left.sort((a, b) => a - b)
  right.sort((a, b) => a - b)
  const pairs: Array<[number | null, number | null]> = []
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    pairs.push([i < left.length ? left[i] : null, i < right.length ? right[i] : null])
  }
  return pairs
}

function sameAmount(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100)
}

function num(v: number | string | null): number | null {
  return v === null || v === undefined ? null : Number(v)
}

function setFlags(s: AuditSnapshot, flags: PartnerFlag[]): PartnerFlag[] {
  return flags.filter((f) => s.partner_flags?.[f.field] === true)
}

function matrixKey(s: AuditSnapshot, flags: PartnerFlag[]): string {
  const set = setFlags(s, flags).map((f) => f.field)
  return [s.is_sell_off ? 'sell-off' : 'regular', ...set].join('|')
}

function matrixName(s: AuditSnapshot, flags: PartnerFlag[]): string {
  const set = setFlags(s, flags)
  return set.length === 0 ? 'Default' : set.map((f) => f.label).join(' + ')
}

// ── Who changed it ────────────────────────────────────────────────────────────

/** Salesforce writes "+0000"; Date wants "+00:00". */
function sfInstant(s: string): Date {
  return new Date(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
}

/**
 * Everyone who saved this matrix since the last run, and the span of their
 * saves. Each save rebuilds the matrix, so the rows deleted since the last run
 * carry the earlier saves (and the start of the session), and the live rows
 * carry the last one.
 */
export function editorsFor(
  change: MatrixAuditChange,
  rows: SalesforceBidRow[],
  since: string | null,
  flags: PartnerFlag[],
): Pick<MatrixAuditAlert, 'editors' | 'edited_from' | 'edited_to'> {
  const after = since ? new Date(since) : null
  const mine = rows
    .filter((r) => r.LastModifiedDate && matrixKey(toSnapshotRow(r, flags), flags) === change.key)
    .map((r) => ({ at: sfInstant(r.LastModifiedDate as string), name: r.LastModifiedBy?.Name ?? null }))
    .filter((r) => !Number.isNaN(r.at.getTime()) && (after === null || r.at > after))
    .sort((a, b) => a.at.getTime() - b.at.getTime())
  if (mine.length === 0) return { editors: [], edited_from: null, edited_to: null }
  const editors = [...new Set(mine.map((r) => r.name).filter((n): n is string => !!n))]
  return {
    editors,
    edited_from: mine[0].at.toISOString(),
    edited_to: mine[mine.length - 1].at.toISOString(),
  }
}

// ── Salesforce ────────────────────────────────────────────────────────────────

function rowFields(flags: PartnerFlag[]): string {
  return [
    'Id', 'RowId__c', 'RowLow__c', 'RowHigh__c', 'RangeLow__c', 'RangeHigh__c',
    'RangeValue__c', 'IsSellOff__c', 'LastModifiedDate', 'LastModifiedBy.Name',
    ...flags.map((f) => f.field),
  ].join(', ')
}

async function querySalesforce<T>(
  instanceUrl: string,
  token: string,
  soql: string,
  endpoint: 'query' | 'queryAll' = 'query',
): Promise<T[]> {
  const all: T[] = []
  let next: string | undefined = `${instanceUrl}/services/data/v60.0/${endpoint}?q=${encodeURIComponent(soql)}`
  while (next) {
    const res: Response = await fetch(next, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`SF query failed (${res.status}): ${text.slice(0, 500)}`)
    }
    const body = await parseJson<{ records: T[]; done: boolean; nextRecordsUrl?: string }>(res)
    all.push(...body.records)
    next = body.done ? undefined : body.nextRecordsUrl ? `${instanceUrl}${body.nextRecordsUrl}` : undefined
  }
  return all
}

/**
 * The rows the Bid Matrix screen deleted since the last run, from the recycle
 * bin. They only add the earlier saves of a session to "Changed by", so a
 * failure here is logged and the alert goes out saying it knows only the last
 * save, rather than not at all.
 */
async function readDeletedSince(
  instanceUrl: string,
  token: string,
  flags: PartnerFlag[],
  since: string | null,
): Promise<{ rows: SalesforceBidRow[]; read: boolean }> {
  if (!since) return { rows: [], read: false }
  const literal = new Date(since).toISOString().replace(/\.\d{3}Z$/, 'Z')
  try {
    const rows = await querySalesforce<SalesforceBidRow>(
      instanceUrl,
      token,
      `SELECT ${rowFields(flags)} FROM BidRangeRow__c WHERE IsDeleted = TRUE AND LastModifiedDate > ${literal}`,
      'queryAll',
    )
    return { rows, read: true }
  } catch (err) {
    console.error('[sf-matrix-audit] could not read deleted rows, so Changed by names the last save only:', err)
    return { rows: [], read: false }
  }
}

// ── Slack notify ──────────────────────────────────────────────────────────────

async function slackOrgIds(supabase: SupabaseClient): Promise<string[]> {
  const { data: orgs, error: orgsError } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  logReadFailure('sf-matrix-audit', 'organizations', orgsError)
  return Array.from(new Set(((orgs ?? []) as { organization_id: string }[]).map((r) => r.organization_id)))
}

/** Delivered, or nothing to deliver (no Slack, or matrix alerts switched off). */
async function postToOrg(supabase: SupabaseClient, orgId: string, blocks: unknown[], text: string): Promise<boolean> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection || !connection.matrix_alerts_enabled) return true
  const channel = connection.matrix_alerts_channel || connection.default_channel
  return (await postMessage(connection.bot_token, channel, blocks, text)) !== null
}

// Returns true only when EVERY message to every org was delivered (or was a
// no-op: org opted out / no Slack). A false return means the caller must NOT
// advance the snapshot, so the change is re-diffed and retried next run.
// Exported for unit testing.
export async function notifyAllOrgsWithSlack(
  supabase: SupabaseClient,
  alerts: MatrixAuditAlert[],
  now: Date,
  matrixUrl: string | undefined,
): Promise<boolean> {
  const orgIds = await slackOrgIds(supabase)
  let allDelivered = true
  for (const orgId of orgIds) {
    for (const alert of alerts) {
      try {
        const { blocks, text } = buildMatrixAuditMessage(alert, now, matrixUrl)
        if (!(await postToOrg(supabase, orgId, blocks, text))) allDelivered = false
      } catch (err) {
        console.error(`[sf-matrix-audit] slack alert failed for org ${orgId}:`, err)
        allDelivered = false
      }
    }
  }
  return allDelivered
}

/**
 * What to say when the snapshot is rebuilt, or null to say nothing. An empty
 * record is announced, so a rebuild from nothing is never mistaken for a quiet
 * hour (#1176). A rebuild because Salesforce gained or lost a partner checkbox
 * is quiet, by Dan's choice on 2026-10-07, and only logged.
 */
export function baselineNotice(decision: BaselineDecision, rowCount: number): string | null {
  if (decision.reason !== 'empty') return null
  return `The bid matrix audit had no record to compare against, so it recorded the current ${rowCount} bids. Changes are reported from the next run.`
}

/**
 * Posts the rebuild notice where there is one. It reports rather than guards,
 * so a failure to post it is logged and does not undo the rebuild.
 */
async function notifyBaseline(
  supabase: SupabaseClient,
  decision: BaselineDecision,
  rowCount: number,
  matrixUrl: string | undefined,
): Promise<void> {
  const text = baselineNotice(decision, rowCount)
  if (text === null) {
    console.log(
      `[sf-matrix-audit] rebuilt the snapshot of ${rowCount} bids quietly: partners added ${decision.added.join(', ') || 'none'}, removed ${decision.removed.join(', ') || 'none'}`,
    )
    return
  }
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Bid matrix tracking updated', emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text } },
  ]
  if (matrixUrl) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `<${matrixUrl}|Open in Salesforce \u2192>` } })
  for (const orgId of await slackOrgIds(supabase)) {
    try {
      if (!(await postToOrg(supabase, orgId, blocks, 'Bid matrix tracking updated'))) {
        console.error(`[sf-matrix-audit] baseline notice not delivered to org ${orgId}`)
      }
    } catch (err) {
      console.error(`[sf-matrix-audit] baseline notice failed for org ${orgId}:`, err)
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toSnapshotRow(r: SalesforceBidRow, flags: PartnerFlag[]): AuditSnapshot {
  const partnerFlags: Record<string, boolean> = {}
  for (const f of flags) partnerFlags[f.field] = r[f.field] === true
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
  }
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
