/**
 * The ops Salesforce budget reading taken from a response (#2336, phase 6 of
 * #1689; plan: discussion #2329, "Sforce-Limit-Info from each ops response
 * writes sf_budget_readings").
 *
 * WHY. acquire_sf_lease refuses every call but the sf_limits read as
 * sf_budget_unmeasured when the org's sf_budget_readings row is missing or
 * older than 15 minutes, and as sf_budget_floor below the approved floor. Every
 * Salesforce REST response already says how much of the org's daily allocation
 * is used, so connectionFetch hands that reading here and the pool stays
 * measured for as long as ops is calling Salesforce at all.
 *
 * THE HEADER, as Salesforce documents it (REST API Developer Guide, version
 * 68.0, Winter '27, "Limit Info Header", read 2026-10-19 from
 * https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_rest.pdf;
 * the same page is developer.salesforce.com/docs/platform/api-rest/guide/headers-api-usage.html):
 *
 *   "This response header is returned in each request to REST API (except for
 *   calls to the Versions URI, /, which do not count towards your org's limit)."
 *   "Field name: Sforce-Limit-Info"
 *   "Field values: api-usage: Specifies the daily API usage for the organization
 *   against which the call was made. The first number is the number of API calls
 *   used, and the second number is the API limit for the organization."
 *   "Example: Sforce-Limit-Info: api-usage=10018/100000; api-bursts=1/750"
 *
 * So the value is fields separated by semicolons, and only api-usage is read:
 * api-bursts, and the per-app-api-usage field older versions of the page
 * describe, are other fields of the same header and are skipped.
 *
 * NEVER A NaN IN A COMPARISON (L50). Each number must be plain digits, finite,
 * and within the integer columns of sf_budget_readings; anything else is a
 * named refusal and nothing is written.
 *
 * USED ABOVE MAX IS A READING, NOT A FAULT. sf_budget_readings.daily_api_remaining
 * may be below zero by design ("Below zero when the org has run past its
 * allocation, which Salesforce allows for a while", 20261017220000_ops_connections_2334.sql),
 * and that is the reading that matters most: written as remaining below zero,
 * it makes acquire_sf_lease refuse at once as sf_budget_floor. Refused here, it
 * would leave the last reading under the allocation standing for up to 15
 * minutes while the org was past it.
 *
 * WHICH ORG. The org the connection MEASURED as (connection_measured_identity,
 * written only by verify from userinfo), never its declared target (L83), the
 * same key acquire_sf_lease draws the call's lease from (L66).
 *
 * HOW OFTEN: at most once per Salesforce org per SF_BUDGET_READING_MIN_INTERVAL_MS
 * in one isolate (docs/ops-connections-logins.md, "The budget reading"). The
 * reading is judged fresh for 15 minutes, so a reading a minute old is as good
 * to the pool as one a millisecond old, while a write per response would add an
 * ops database round trip and a subrequest to every Salesforce call, which a
 * dispatched run pays out of the same 10,000 subrequests per invocation as its
 * own work (docs/ops-ceilings-spike.md, P3). CPU is not the cost that binds: a
 * write is one small rpc, and a dispatched run has 30 s of CPU of its own (B2).
 */
import type { OrganizationId } from '../ops-db'

/** The fewest milliseconds between two readings written for one Salesforce org from one isolate. */
export const SF_BUDGET_READING_MIN_INTERVAL_MS = 60_000
/** How long a reading's write may take before connectionFetch stops waiting for it. */
export const SF_BUDGET_READING_DEADLINE_MS = 1_000
/** sf_budget_readings' daily_api_max and daily_api_remaining are Postgres integers. */
const PG_INT_MAX = 2_147_483_647

export type SforceLimitInfoRefusal = 'absent' | 'no_api_usage' | 'malformed' | 'not_finite' | 'out_of_range' | 'max_not_positive'

export type SforceLimitInfo =
  | { readonly ok: true; readonly used: number; readonly max: number }
  | { readonly ok: false; readonly refusal: SforceLimitInfoRefusal }

const API_USAGE = /^api-usage=(\d+)\/(\d+)$/

/** The api-usage field of a Sforce-Limit-Info header value, or a named refusal. */
export function parseSforceLimitInfo(header: string | null): SforceLimitInfo {
  if (header === null) return { ok: false, refusal: 'absent' }
  const fields = header.split(';').map((f) => f.trim())
  const usage = fields.filter((f) => f.startsWith('api-usage='))
  if (usage.length === 0) return { ok: false, refusal: 'no_api_usage' }
  if (usage.length > 1) return { ok: false, refusal: 'malformed' }
  const match = API_USAGE.exec(usage[0])
  if (match === null) return { ok: false, refusal: 'malformed' }
  const used = Number(match[1])
  const max = Number(match[2])
  if (!Number.isFinite(used) || !Number.isFinite(max)) return { ok: false, refusal: 'not_finite' }
  if (used > PG_INT_MAX || max > PG_INT_MAX) return { ok: false, refusal: 'out_of_range' }
  if (max < 1) return { ok: false, refusal: 'max_not_positive' }
  return { ok: true, used, max }
}

/**
 * What one isolate remembers between calls: the measured org of each
 * connection generation it has seen, and when it last wrote each org's reading.
 * Both are only savings: a cold isolate reads the org and writes the reading
 * once, and nothing is wrong. A measured org is remembered only once found,
 * since a generation's measured row never changes once written (verify writes
 * nothing on identity_changed) and a removal deletes it along with the copy,
 * which connectionFetch refuses before any request.
 */
export class SfBudgetMemory {
  private readonly orgs = new Map<string, string>()
  private readonly written = new Map<string, number>()

  constructor(private readonly bound = 1_000) {}

  orgOf(key: string): string | undefined {
    return this.orgs.get(key)
  }

  rememberOrg(key: string, sfOrgId: string): void {
    this.orgs.set(key, sfOrgId)
    trim(this.orgs, this.bound)
  }

  /** Claims the org's write if none was claimed within the interval; the claim is taken before the write, so two calls at once write once. */
  claim(sfOrgId: string, now: number): boolean {
    const last = this.written.get(sfOrgId)
    if (last !== undefined && now - last < SF_BUDGET_READING_MIN_INTERVAL_MS && now >= last) return false
    this.written.set(sfOrgId, now)
    trim(this.written, this.bound)
    return true
  }

  /** A failed write gives its claim back, so the next response tries again. */
  release(sfOrgId: string, claimedAt: number): void {
    if (this.written.get(sfOrgId) === claimedAt) this.written.delete(sfOrgId)
  }
}

function trim(map: Map<string, unknown>, bound: number): void {
  while (map.size > bound) {
    const oldest = map.keys().next()
    if (oldest.done) return
    map.delete(oldest.value)
  }
}

export interface SfBudgetRecorderDeps {
  memory: SfBudgetMemory
  /** The connection generation's measured org (ops-writes.ts readMeasuredSfOrg), or null when verify has not measured it. */
  readMeasuredSfOrg(organizationId: OrganizationId, connectionId: string, generation: number): Promise<string | null>
  /** record_sf_budget_reading (ops-writes.ts recordSfBudgetReading), bound to the ops client, source sforce_limit_info. */
  recordSfBudgetReading(sfOrgId: string, reading: { dailyApiMax: number; dailyApiRemaining: number }): Promise<unknown>
}

export type SfBudgetRecordOutcome = 'recorded' | 'throttled' | 'unmeasured'

/**
 * One response's reading, written for the org the connection measured as, or
 * skipped by name. Throws when the read or the write fails; connectionFetch
 * catches it, so a reading never changes the answer of the call it came on.
 */
export async function recordSfBudgetReadingFor(
  deps: SfBudgetRecorderDeps, organizationId: OrganizationId, connectionId: string, generation: number,
  reading: { used: number; max: number }, now: number,
): Promise<SfBudgetRecordOutcome> {
  const key = `${organizationId}:${connectionId}:${generation}`
  let sfOrgId = deps.memory.orgOf(key)
  if (sfOrgId === undefined) {
    const measured = await deps.readMeasuredSfOrg(organizationId, connectionId, generation)
    if (measured === null) return 'unmeasured'
    deps.memory.rememberOrg(key, measured)
    sfOrgId = measured
  }
  if (!deps.memory.claim(sfOrgId, now)) return 'throttled'
  try {
    await deps.recordSfBudgetReading(sfOrgId, { dailyApiMax: reading.max, dailyApiRemaining: reading.max - reading.used })
  } catch (err) {
    deps.memory.release(sfOrgId, now)
    throw err
  }
  return 'recorded'
}
