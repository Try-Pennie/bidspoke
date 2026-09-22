/**
 * Fill each Tripoint win with what the lead was worth (#354).
 *
 * Tripoint's createLead response carries no amount, so `bid_cents` is null on
 * every Tripoint row outside Main Flow: 503 of 3,163 accepted bids carried a
 * price over the 7 days to 2026-09-04, and all 503 came from Main Flow, where a
 * bid_group node resolves one. Salesforce holds a figure for the rest, on the
 * prospect this run already created.
 *
 * IT IS AN ESTIMATE AND IS NAMED AS ONE. `Prospect__c.ExternalExchangeRevenue__c`
 * is a Salesforce FORMULA field (`IsCalculated: true`), derived from the
 * prospect's debt rather than reported by Tripoint: 0.001 of debt from $10,000
 * to $19,999 and 0.0016 from $20,000, for leads that came from an external
 * partner (Engine, AmOne, Lead Economy). That is a different rule from the one
 * Bidspoke prices Main Flow leads on, and deliberately so: Main Flow leads are
 * booked through `Lead.ExternalRevenue__c` (0.0009 to $12,499, 0.0012 above),
 * which `tripoint-pricing-check.ts` compares Bidspoke's config against daily
 * (#1166). So it goes in `estimated_revenue_cents`, never in `bid_cents`, which
 * means what a buyer offered us on every row it holds. Sharing that column would
 * make every later sum part measurement and part estimate with nothing
 * announcing it, which is the reasoning that kept the quoted rate out of it too
 * (#1158).
 *
 * That the two populations are priced on different rules is a recorded decision,
 * not drift: docs/adr/0010-engine-and-main-flow-price-tripoint-differently.md
 * (#1178). Never average or compare Tripoint figures across the two flows
 * without saying which rule produced each.
 *
 * WHY IT RUNS EVERY 15 MINUTES rather than daily. Bid rows reach Snowflake about
 * 57 minutes after the bid (measured 2026-09-04, average over a 24 hour window),
 * and the purge then deletes the exported row, so a value written after export
 * never reaches the warehouse and is then destroyed. A daily job would fill
 * almost nothing anybody could query. The residual is the rows bid in the last
 * few minutes before an export, and rather than assume it is small the job
 * COUNTS the rows that were exported while still unpriced and reports it, so the
 * gap is visible and a stopped cron shows up as that number climbing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { requireRowsAffected } from './db-retry'
import { parseJson } from './json'
import { getSalesforceToken } from '../engine/nodes/salesforce'
import { pickSalesforceCreds, resolveSalesforceCredsFor } from './salesforce-creds'

// Re-exported so the one implementation is reachable from this module's tests
// and call sites alike; the resolution itself lives in salesforce-creds.ts (#1174).
export { pickSalesforceCreds }
import type { Env } from '../index'

export interface FillCandidate {
  bid_id: string
  prospect_id: string
  /** The row's own partition key, carried so the UPDATE can name it. */
  attempted_at_utc: string
}

export interface RevenueUpdate {
  bid_id: string
  attempted_at_utc: string
  estimated_revenue_cents: number
}

export interface RevenueUpdateResult {
  updates: RevenueUpdate[]
  /** Prospects Salesforce returned no row for at all. */
  unmatched: string[]
  /** Prospects whose figure was present but not a usable amount. */
  unusable: string[]
  /** Prospects Salesforce answered for, carrying no figure. Nothing to record. */
  no_value: string[]
}

/**
 * Turn Salesforce's answer into per-row updates.
 *
 * Every outcome is separate on purpose. A prospect Salesforce has no row for, a
 * prospect with no figure, and a prospect with a broken figure are three
 * different facts, and folding them together would make a deleted prospect read
 * as a lead worth nothing (LESSONS L11).
 *
 * Zero is recorded as zero. Salesforce's measured minimum on live leads is
 * exactly 0, and null already means "no estimate was recorded", so collapsing
 * the two would lose a real value.
 */
export function revenueUpdates(
  candidates: FillCandidate[],
  byProspectId: Map<string, number | null>,
): RevenueUpdateResult {
  const updates: RevenueUpdate[] = []
  const unmatched: string[] = []
  const unusable: string[] = []
  const noValue: string[] = []

  for (const c of candidates) {
    if (!byProspectId.has(c.prospect_id)) {
      if (!unmatched.includes(c.prospect_id)) unmatched.push(c.prospect_id)
      continue
    }
    const dollars = byProspectId.get(c.prospect_id) ?? null
    if (dollars === null) {
      if (!noValue.includes(c.prospect_id)) noValue.push(c.prospect_id)
      continue
    }
    if (typeof dollars !== 'number' || !Number.isFinite(dollars) || dollars < 0) {
      if (!unusable.includes(c.prospect_id)) unusable.push(c.prospect_id)
      continue
    }
    updates.push({
      bid_id: c.bid_id,
      attempted_at_utc: c.attempted_at_utc,
      estimated_revenue_cents: Math.round(dollars * 100),
    })
  }

  return { updates, unmatched, unusable, no_value: noValue }
}

// ── The scheduled job ─────────────────────────────────────────────────────────

/**
 * How far back to look for unpriced rows. Wider than the 15 minute cadence so a
 * single skipped run is recovered by the next one, and still far inside the
 * ~57 minute export lag so the work is not wasted on rows already gone.
 */
export const LOOKBACK_MINUTES = 45

/** Salesforce `Id IN (...)` chunk size. Well under the SOQL statement limits. */
export const SOQL_CHUNK = 150

/** Rows per run. About 26 arrive per 15 minutes; this is headroom, not a target. */
export const MAX_ROWS_PER_RUN = 500

export interface FillSummary {
  scanned: number
  filled: number
  unmatched: number
  unusable: number
  no_value: number
  /** Rows that reached the warehouse with no estimate. The visible residual. */
  exported_unpriced: number
  errors: string[]
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * The SOQL for one chunk of prospect ids. Ids are Salesforce key strings, and
 * anything that is not one is dropped before it reaches the query rather than
 * being quoted into it.
 */
export function revenueSoql(prospectIds: string[]): string {
  const safe = prospectIds.filter((id) => /^[a-zA-Z0-9]{15,18}$/.test(id))
  const list = safe.map((id) => `'${id}'`).join(',')
  return `SELECT Id, ExternalExchangeRevenue__c FROM Prospect__c WHERE Id IN (${list})`
}

interface SalesforceRevenueRecord {
  Id?: unknown
  ExternalExchangeRevenue__c?: unknown
}

/** Read Salesforce's records into the map revenueUpdates consumes. */
export function indexRevenueRecords(records: SalesforceRevenueRecord[]): Map<string, number | null> {
  const map = new Map<string, number | null>()
  for (const r of records) {
    if (typeof r.Id !== 'string' || !r.Id) continue
    const raw = r.ExternalExchangeRevenue__c
    if (raw === null || raw === undefined) {
      map.set(r.Id, null)
      continue
    }
    // A string is what the REST API returns for some currency shapes, so it is
    // parsed rather than refused; anything that will not parse becomes NaN and
    // revenueUpdates reports it as unusable rather than writing it.
    map.set(r.Id, typeof raw === 'number' ? raw : Number(raw))
  }
  return map
}

/**
 * Salesforce is injected rather than reached for. A job that builds its own
 * network client cannot be tested without one, and a test that reaches a live
 * partner is either an integration test or a missing seam (LESSONS L196, L291).
 * `salesforceRevenueFetcher` below builds the real one.
 */
export interface FillDeps {
  supabase: SupabaseClient
  fetchRevenue: (prospectIds: string[]) => Promise<SalesforceRevenueRecord[]>
  now?: () => Date
}

/**
 * The population this job fills, as ONE filter both its queries apply, so the
 * candidate read and the exported residual count can never drift apart, and a
 * test can prove a row is selected by the job's own predicate rather than by a
 * restatement of it (#1411, L16). Unpriced Tripoint wins: the winner flag set
 * by the finalize, no estimate yet, and no partner reported amount, because a
 * measured bid beats a derived one (Main Flow's bid_group winners carry one and
 * create no Salesforce prospect, so they were 39 of 39 false candidates on
 * 2026-09-05).
 */
export const UNPRICED_TRIPOINT_WIN_FILTER: ReadonlyArray<['eq', string, string | boolean] | ['is', string, null]> = [
  ['eq', 'partner_slug', 'tripoint'],
  ['eq', 'is_winner', true],
  ['is', 'estimated_revenue_cents', null],
  ['is', 'bid_cents', null],
]

interface FilterChain {
  eq(column: string, value: unknown): FilterChain
  is(column: string, value: null): FilterChain
}

// T is left unconstrained on purpose: constraining it to the builder's own eq
// and is signatures sends the compiler into PostgREST's generic column types
// (TS2589). The chain is the same object in and out, so the cast is honest.
export function unpricedTripointWinFilter<T>(query: T): T {
  let chain = query as unknown as FilterChain
  for (const [op, column, value] of UNPRICED_TRIPOINT_WIN_FILTER) {
    chain = op === 'eq' ? chain.eq(column, value) : chain.is(column, value)
  }
  return chain as unknown as T
}

export async function runTripointRevenueFill(deps: FillDeps): Promise<FillSummary> {
  const { supabase, fetchRevenue } = deps
  const now = deps.now ? deps.now() : new Date()
  const since = new Date(now.getTime() - LOOKBACK_MINUTES * 60_000).toISOString()
  const summary: FillSummary = {
    scanned: 0, filled: 0, unmatched: 0, unusable: 0, no_value: 0,
    exported_unpriced: 0, errors: [],
  }

  // Unpriced Tripoint wins still inside the window and not yet exported. Rows
  // already exported are deliberately excluded: filling one writes a value the
  // warehouse will never see and the purge then deletes, so the work would be
  // invisible either way. They are counted separately below instead.
  const { data: bids, error: bidsErr } = await unpricedTripointWinFilter(
    supabase
      .from('lead_sighting_bids')
      .select('id, sighting_id, attempted_at_utc')
      .is('exported_at', null)
      .gte('attempted_at_utc', since)
      .limit(MAX_ROWS_PER_RUN),
  )

  if (bidsErr) {
    // A failed read is not an empty window (LESSONS L98).
    summary.errors.push(`bids_query_failed: ${bidsErr.message}`)
    return summary
  }

  const bidRows = (bids ?? []) as Array<{ id: string; sighting_id: string; attempted_at_utc: string }>
  summary.scanned = bidRows.length
  if (bidRows.length === 0) {
    summary.exported_unpriced = await countExportedUnpriced(supabase, since, summary)
    return summary
  }

  // The prospect id lives on the sighting. `execution_started_at_utc` is that
  // table's partition key and is bounded here so the lookup prunes instead of
  // fanning out across every monthly partition, which an id-only filter does.
  const sightingWindow = new Date(now.getTime() - (LOOKBACK_MINUTES + 60) * 60_000).toISOString()
  const sightingIds = [...new Set(bidRows.map((b) => b.sighting_id))]
  const { data: sightings, error: sightErr } = await supabase
    .from('lead_sightings')
    .select('id, prospect_id')
    .in('id', sightingIds)
    .gte('execution_started_at_utc', sightingWindow)
    // Bounded by the ids asked for, so the limit can never truncate: a
    // truncation here would silently report those bids as having no prospect,
    // which is a different fact. Written as an enforced bound rather than a
    // comment claiming one, because the bid read above is already capped at
    // MAX_ROWS_PER_RUN and this list is a subset of it.
    .limit(sightingIds.length)

  if (sightErr) {
    summary.errors.push(`sightings_query_failed: ${sightErr.message}`)
    return summary
  }

  const prospectBySighting = new Map<string, string>()
  let withoutProspect = 0
  for (const s of (sightings ?? []) as Array<{ id: string; prospect_id: string | null }>) {
    if (typeof s.prospect_id === 'string' && s.prospect_id) prospectBySighting.set(s.id, s.prospect_id)
    else withoutProspect++
  }
  if (withoutProspect > 0) {
    // Not an error: a run that never created a prospect has nothing to look up.
    // Named so it cannot be read as a Salesforce problem.
    summary.errors.push(`no_prospect_id: ${withoutProspect}`)
  }

  const candidates: FillCandidate[] = bidRows
    .filter((b) => prospectBySighting.has(b.sighting_id))
    .map((b) => ({
      bid_id: b.id,
      prospect_id: prospectBySighting.get(b.sighting_id) as string,
      attempted_at_utc: b.attempted_at_utc,
    }))

  // Each chunk is its own failure boundary: one Salesforce error must not
  // discard the answers the other chunks already gave (LESSONS L73). The rows it
  // covered stay unpriced and unexported, so the next run picks them up.
  const byProspectId = new Map<string, number | null>()
  for (const ids of chunk([...new Set(candidates.map((c) => c.prospect_id))], SOQL_CHUNK)) {
    try {
      for (const [id, value] of indexRevenueRecords(await fetchRevenue(ids))) {
        byProspectId.set(id, value)
      }
    } catch (e) {
      summary.errors.push(`salesforce_query_failed: ${formatErr(e)}`)
    }
  }

  // Only rows Salesforce was actually asked about are judged. Without this a
  // chunk that failed would have every one of its prospects reported as
  // unmatched, which reads as "Salesforce has no such prospect" (LESSONS L11).
  const answered = candidates.filter((c) => byProspectId.has(c.prospect_id))
  const result = revenueUpdates(answered, byProspectId)
  summary.unmatched = result.unmatched.length
  summary.unusable = result.unusable.length
  summary.no_value = result.no_value.length

  for (const u of result.updates) {
    // The UPDATE names `attempted_at_utc`, the partition key, so it touches one
    // partition rather than scanning all of them. And it is checked for rows
    // affected, because supabase-js reports error:null on a write that matched
    // nothing (#487).
    const { rows, error } = await requireRowsAffected<{ id: string }>(
      'lead_sighting_bids.estimated_revenue_cents',
      () =>
        supabase
          .from('lead_sighting_bids')
          .update({ estimated_revenue_cents: u.estimated_revenue_cents })
          .eq('id', u.bid_id)
          .eq('attempted_at_utc', u.attempted_at_utc)
          .select('id'),
      // A write that matched nothing is a real failure here, not a warning: it
      // means the row moved or was purged mid-run, and the count must not
      // include it.
      { onMiss: 'error', context: { bid_id: u.bid_id } },
    )
    if (error) {
      summary.errors.push(`update_failed ${u.bid_id}: ${error.message}`)
      continue
    }
    summary.filled += rows.length
  }

  summary.exported_unpriced = await countExportedUnpriced(supabase, since, summary)
  return summary
}

/**
 * Rows that reached the warehouse with no estimate. This is the job's own
 * residual, reported rather than assumed: rows bid in the last minutes before an
 * export are gone before any run can reach them, and if the schedule ever stops
 * this number is what climbs (LESSONS L98, L357).
 */
async function countExportedUnpriced(
  supabase: SupabaseClient,
  since: string,
  summary: FillSummary,
): Promise<number> {
  // Same population as the candidate read above, through the same filter, or the
  // residual reports rows this job would never have filled anyway.
  const { count, error } = await unpricedTripointWinFilter(
    supabase
      .from('lead_sighting_bids')
      .select('id', { count: 'exact', head: true }),
  )
    .not('exported_at', 'is', null)
    .gte('attempted_at_utc', since)

  if (error) {
    summary.errors.push(`residual_count_failed: ${error.message}`)
    return 0
  }
  return count ?? 0
}

/**
 * The real Salesforce reader, built once per run and handed to
 * runTripointRevenueFill. Follows bid-matrix-sync's path: credentials off the
 * env loosely (they are Cloudflare secrets and are not on the typed Env), one
 * cached token per organization, and a paged query.
 *
 * A non-2xx response THROWS, so the caller records the chunk as failed and
 * leaves its rows for the next run, rather than treating an outage as a set of
 * prospects Salesforce does not have.
 */
export function salesforceRevenueFetcher(
  env: Env,
  orgId: string,
  supabase: SupabaseClient,
): (prospectIds: string[]) => Promise<SalesforceRevenueRecord[]> {
  return async (prospectIds: string[]) => {
    const { creds, missing } = await resolveSalesforceCredsFor(env, supabase, orgId)
    if (!creds) {
      throw new Error(
        `Salesforce credentials missing for the Tripoint revenue fill: ${missing.join(', ')} (checked the organization env store and the Worker env)`,
      )
    }
    const { instanceUrl, clientId, clientSecret } = creds

    const token = await getSalesforceToken(env, orgId, instanceUrl, clientId, clientSecret)
    const soql = revenueSoql(prospectIds)
    const records: SalesforceRevenueRecord[] = []
    let next: string | undefined = `${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`

    while (next) {
      const res: Response = await fetch(next, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Salesforce query failed (${res.status}): ${text.slice(0, 500)}`)
      }
      const body = await parseJson<{
        records: SalesforceRevenueRecord[]
        done: boolean
        nextRecordsUrl?: string
      }>(res)
      records.push(...body.records)
      next = body.done ? undefined : body.nextRecordsUrl ? `${instanceUrl}${body.nextRecordsUrl}` : undefined
    }
    return records
  }
}

/**
 * The organization that owns the Tripoint partner config.
 *
 * The Salesforce token is cached per organization, so this names the right one
 * rather than taking whichever organization happens to come back first from an
 * unrelated table. A missing config and an unreadable table are reported
 * separately: only one of them means somebody should look at partner settings
 * (LESSONS L11).
 */
export async function resolveTripointOrg(
  supabase: SupabaseClient,
): Promise<{ orgId: string | null; error: string | null }> {
  const { data, error } = await supabase
    .from('partner_configs')
    .select('organization_id')
    .eq('slug', 'tripoint')
    .limit(1)

  if (error) return { orgId: null, error: `org_lookup_failed: ${error.message}` }
  const rows = (data ?? []) as Array<{ organization_id?: unknown }>
  const orgId = typeof rows[0]?.organization_id === 'string' ? rows[0].organization_id : null
  if (!orgId) return { orgId: null, error: 'no_tripoint_partner_config' }
  return { orgId, error: null }
}

/** What the scheduled handler calls: resolve the organization, then fill. */
export async function runTripointRevenueFillForEnv(
  supabase: SupabaseClient,
  env: Env,
): Promise<FillSummary> {
  const { orgId, error } = await resolveTripointOrg(supabase)
  if (!orgId) {
    return {
      scanned: 0, filled: 0, unmatched: 0, unusable: 0, no_value: 0,
      exported_unpriced: 0, errors: [error ?? 'no_tripoint_partner_config'],
    }
  }
  return runTripointRevenueFill({ supabase, fetchRevenue: salesforceRevenueFetcher(env, orgId, supabase) })
}
