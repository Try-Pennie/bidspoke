/**
 * Stamps PD_Completed_Timestamp__c on the fallback Submissions that never got one
 * (#2581). The operator script is `scripts/backfill-fallback-pd-timestamp.ts`;
 * this module is its logic, kept here so it is typechecked, linted and tested
 * with the Worker's own suite, and it holds no credentials of its own.
 *
 * WHY. Until Main Flow version 173 (2026-10-21) the Send Fallback Salesforce node
 * wrote ADV, XBC and InternalDebtRouting__c = 20000 to Submission__c but not
 * PD_Completed_Timestamp__c. trypennie skips a resubmit only when that timestamp
 * is set (Halo-lab-Trypennie/trypennie#559), so every older fallback submission
 * stays open to being overwritten. Measured 2026-10-21: 24,640 of them.
 *
 * WHAT IT WRITES. Each record's own CreatedDate, in the flow's format
 * (`new Date().toISOString().slice(0, 19)`: UTC, whole seconds, no zone suffix).
 * The flow finished seconds to minutes after creation, so the value is close
 * rather than exact; trypennie only tests that the field is set.
 *
 * SAFETY.
 *   - Only records matching FALLBACK_PREDICATE are ever selected, so a verified
 *     20,000 that Send Salesforce already stamped is never touched.
 *   - Every batch re-applies the predicate to its Ids immediately before writing,
 *     so a record that gained a timestamp since the read is skipped, and a second
 *     run finds nothing to do. The window left is the round trip between that
 *     re-check and the write (well under a second). A live run stamping a record
 *     inside it would have its value replaced by CreatedDate, which still leaves
 *     the field set, the only thing trypennie reads.
 *   - Writes go through sObject Collections, at most 200 per request, with
 *     allOrNone false, so one refused record does not refuse its batch.
 *   - It stops on the first batch where more than 1% of the records sent fail,
 *     and on any request that fails as a whole.
 *   - Nothing but Ids, CreatedDate, the written value, counts and Salesforce
 *     status codes is printed or recorded: Submissions carry SSNs and contact
 *     details, so no other field is selected at all.
 */
import { salesforceDataUrl, salesforceNextPageUrl, salesforceQueryUrl, salesforceRequestHeaders } from './salesforce-api'
import { SALESFORCE_ID, refusalText } from './salesforce-write'
import { formatErr } from './format-error'

export const SUBMISSION_OBJECT = 'Submission__c'
export const TIMESTAMP_FIELD = 'PD_Completed_Timestamp__c'

/** Exactly the population measured on #2581. Changing it changes which records are written. */
export const FALLBACK_PREDICATE = 'InternalDebtRouting__c = 20000 AND PD_Completed_Timestamp__c = null AND XBC_SO__c != null'

/** The sObject Collections ceiling, and the most Ids one re-check query carries. */
export const MAX_BATCH = 200

/** A batch with MORE than this share of its sent records failing stops the run. */
export const FAILURE_STOP_RATE = 0.01

export interface QueryPage {
  totalSize: number
  done: boolean
  nextRecordsUrl?: string
  records: Array<{ Id: string; CreatedDate: string }>
}

export interface UpdateResult {
  id: string | null
  success: boolean
  errors: Array<{ statusCode: string; fields: string[] }>
}

/** What the backfill needs from Salesforce, so the tests can stand a fake in for it. */
export interface SubmissionStore {
  query(soql: string): Promise<QueryPage>
  queryMore(nextRecordsUrl: string): Promise<QueryPage>
  update(rows: Array<{ Id: string; value: string }>): Promise<UpdateResult[]>
}

export interface Candidate {
  Id: string
  CreatedDate: string
}

export type RecordResult =
  | { id: string; outcome: 'skipped' }
  | { id: string; outcome: 'updated'; value: string }
  | { id: string; outcome: 'failed'; value: string; statusCodes: string[]; fields: string[] }
  | { id: string; outcome: 'unknown'; value: string }

export interface ApplyReport {
  updated: number
  /** No longer matching the predicate when its batch was re-checked. */
  skipped: number
  /** Salesforce answered this record with an error. */
  failed: number
  /** Sent in a request that failed as a whole, so whether it landed is not known. A re-run settles it. */
  unknown: number
  /** Not reached, because of --limit or a stop. */
  notReached: number
  stopped: string | null
  failureCodes: Record<string, number>
}

export function candidatesSoql(): string {
  return `SELECT Id, CreatedDate FROM ${SUBMISSION_OBJECT} WHERE (${FALLBACK_PREDICATE}) ORDER BY CreatedDate, Id`
}

/** The same predicate over one batch's Ids, asked again immediately before writing them. */
export function recheckSoql(ids: string[]): string {
  for (const id of ids) if (!SALESFORCE_ID.test(id)) throw new Error(`${JSON.stringify(id)} is not a Salesforce id`)
  const list = ids.map((id) => `'${id}'`).join(',')
  return `SELECT Id, CreatedDate FROM ${SUBMISSION_OBJECT} WHERE Id IN (${list}) AND (${FALLBACK_PREDICATE}) ORDER BY CreatedDate, Id`
}

const SF_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/

/**
 * A Salesforce datetime as the flow writes its completedDate:
 * `new Date().toISOString().slice(0, 19)`, so UTC, whole seconds, no zone.
 * Throws on anything that is not a full datetime with a zone, rather than guess.
 */
export function flowTimestamp(createdDate: string): string {
  const m = SF_DATETIME.exec(createdDate)
  if (!m) throw new Error(`${JSON.stringify(createdDate)} is not a Salesforce datetime`)
  const zone = m[7] === 'Z' ? 'Z' : `${m[7].slice(0, 3)}:${m[7].slice(-2)}`
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${zone}`)
  if (Number.isNaN(ms)) throw new Error(`${JSON.stringify(createdDate)} is not a Salesforce datetime`)
  return new Date(ms).toISOString().slice(0, 19)
}

function checkRecord(r: unknown): Candidate {
  const o = (r ?? {}) as { Id?: unknown; CreatedDate?: unknown }
  if (typeof o.Id !== 'string' || !SALESFORCE_ID.test(o.Id)) throw new Error('Salesforce returned a record with no usable Id')
  if (typeof o.CreatedDate !== 'string') throw new Error(`Salesforce returned ${o.Id} with no CreatedDate`)
  flowTimestamp(o.CreatedDate)
  return { Id: o.Id, CreatedDate: o.CreatedDate }
}

/** Every record a query matches, following queryMore to the end, with no cap. */
async function readAll(store: SubmissionStore, soql: string): Promise<Candidate[]> {
  let page = await store.query(soql)
  const total = page.totalSize
  const out: Candidate[] = []
  for (;;) {
    if (!Array.isArray(page.records)) throw new Error('Salesforce answered a query with no records array')
    for (const r of page.records) out.push(checkRecord(r))
    if (page.done) break
    if (typeof page.nextRecordsUrl !== 'string' || !page.nextRecordsUrl) {
      throw new Error('Salesforce said the query was not done but gave no next page')
    }
    page = await store.queryMore(page.nextRecordsUrl)
  }
  // A read that ends short of what Salesforce counted is refused, never used in part (L211).
  if (out.length !== total) throw new Error(`Salesforce counted ${total} matching records but returned ${out.length}`)
  if (new Set(out.map((c) => c.Id)).size !== out.length) throw new Error('Salesforce returned the same record twice')
  return out
}

/** The Submissions matching the predicate now, oldest first. */
export function readCandidates(store: SubmissionStore): Promise<Candidate[]> {
  return readAll(store, candidatesSoql())
}

export function summarize(candidates: Candidate[]): { count: number; earliest: string | null; latest: string | null; sampleIds: string[] } {
  if (candidates.length === 0) return { count: 0, earliest: null, latest: null, sampleIds: [] }
  // Compared as normalised UTC strings, which sort as times do.
  const at = (c: Candidate) => flowTimestamp(c.CreatedDate)
  const byTime = [...candidates].sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0))
  return {
    count: candidates.length,
    earliest: byTime[0].CreatedDate,
    latest: byTime[byTime.length - 1].CreatedDate,
    sampleIds: candidates.slice(0, 5).map((c) => c.Id),
  }
}

export interface ApplyOptions {
  /** At most this many records are WRITTEN; records skipped on the re-check do not count. Null for all. */
  limit: number | null
  onResult?: (r: RecordResult) => void
  onBatch?: (b: { batch: number; sent: number; updated: number; skipped: number; failed: number }) => void
}

/**
 * Writes the timestamp to `candidates`, re-checking each batch against the
 * predicate first, in batches of at most MAX_BATCH.
 */
export async function applyBackfill(store: SubmissionStore, candidates: Candidate[], opts: ApplyOptions): Promise<ApplyReport> {
  const report: ApplyReport = { updated: 0, skipped: 0, failed: 0, unknown: 0, notReached: 0, stopped: null, failureCodes: {} }
  const record = (r: RecordResult) => opts.onResult?.(r)
  let remaining = opts.limit ?? Number.POSITIVE_INFINITY
  let next = 0
  let batch = 0

  while (next < candidates.length && remaining > 0) {
    const chunk = candidates.slice(next, next + Math.min(MAX_BATCH, remaining))
    next += chunk.length
    batch++

    let current: Candidate[]
    try {
      current = await readAll(store, recheckSoql(chunk.map((c) => c.Id)))
    } catch (e) {
      next -= chunk.length
      report.stopped = `batch ${batch}: the re-check failed, so nothing in it was written: ${formatErr(e)}`
      break
    }
    const stillMatching = new Set(current.map((c) => c.Id))
    const inChunk = new Set(chunk.map((c) => c.Id))
    if (current.some((c) => !inChunk.has(c.Id))) {
      next -= chunk.length
      report.stopped = `batch ${batch}: the re-check returned a record that was not asked for, so nothing in it was written`
      break
    }
    let skippedHere = 0
    for (const c of chunk) {
      if (!stillMatching.has(c.Id)) {
        skippedHere++
        record({ id: c.Id, outcome: 'skipped' })
      }
    }
    report.skipped += skippedHere

    const rows = current.map((c) => ({ Id: c.Id, value: flowTimestamp(c.CreatedDate) }))
    if (rows.length === 0) {
      opts.onBatch?.({ batch, sent: 0, updated: 0, skipped: skippedHere, failed: 0 })
      continue
    }

    let results: UpdateResult[]
    try {
      results = await store.update(rows)
      if (!Array.isArray(results) || results.length !== rows.length) {
        throw new Error(`Salesforce answered ${Array.isArray(results) ? results.length : 'no'} results for ${rows.length} records`)
      }
    } catch (e) {
      for (const r of rows) record({ id: r.Id, outcome: 'unknown', value: r.value })
      report.unknown += rows.length
      report.stopped = `batch ${batch}: the update request failed, so whether its ${rows.length} records landed is unknown (a re-run settles it): ${formatErr(e)}`
      break
    }

    let failedHere = 0
    let updatedHere = 0
    rows.forEach((row, i) => {
      const res = results[i]
      if (res.success && (res.id === null || res.id.slice(0, 15) === row.Id.slice(0, 15))) {
        updatedHere++
        record({ id: row.Id, outcome: 'updated', value: row.value })
        return
      }
      failedHere++
      const errors = Array.isArray(res.errors) ? res.errors : []
      const statusCodes = errors.map((e) => String(e.statusCode))
      if (res.success) statusCodes.push('RESULT_ID_MISMATCH')
      for (const code of statusCodes.length ? statusCodes : ['NO_STATUS_CODE']) report.failureCodes[code] = (report.failureCodes[code] ?? 0) + 1
      record({ id: row.Id, outcome: 'failed', value: row.value, statusCodes, fields: errors.flatMap((e) => (Array.isArray(e.fields) ? e.fields.map(String) : [])) })
    })
    report.updated += updatedHere
    report.failed += failedHere
    remaining -= rows.length
    opts.onBatch?.({ batch, sent: rows.length, updated: updatedHere, skipped: skippedHere, failed: failedHere })

    if (failedHere / rows.length > FAILURE_STOP_RATE) {
      report.stopped = `batch ${batch}: ${failedHere} of ${rows.length} records failed, more than ${FAILURE_STOP_RATE * 100}%`
      break
    }
  }

  report.notReached = candidates.length - next
  return report
}

export interface BackfillArgs {
  apply: boolean
  limit: number | null
}

/** `[--apply] [--limit N]`. Anything else is refused rather than ignored. */
export function parseBackfillArgs(argv: string[]): BackfillArgs | { error: string } {
  let apply = false
  let limit: number | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') {
      apply = true
      continue
    }
    if (a === '--limit' || a.startsWith('--limit=')) {
      const raw = a === '--limit' ? argv[++i] : a.slice('--limit='.length)
      if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) return { error: `--limit takes a whole number of at least 1, got ${JSON.stringify(raw ?? null)}` }
      limit = Number(raw)
      continue
    }
    return { error: `unknown argument ${JSON.stringify(a)}` }
  }
  if (limit !== null && !apply) return { error: '--limit only applies with --apply; the dry run always reads every matching record' }
  return { apply, limit }
}

/**
 * The whole run: read, then either print the dry run summary or apply. Exit 0
 * when it completed, 1 when it stopped.
 */
export async function runBackfill(
  store: SubmissionStore,
  args: BackfillArgs,
  io: { print: (line: string) => void; onResult?: (r: RecordResult) => void },
): Promise<{ exitCode: 0 | 1; report: ApplyReport | null }> {
  const candidates = await readCandidates(store)
  const s = summarize(candidates)

  if (!args.apply) {
    io.print('Dry run: nothing was written.')
    io.print(`Matching Submissions: ${s.count}`)
    io.print(`Earliest CreatedDate: ${s.earliest ?? 'none'}`)
    io.print(`Latest CreatedDate: ${s.latest ?? 'none'}`)
    io.print(`Sample Ids: ${s.sampleIds.join(', ') || 'none'}`)
    return { exitCode: 0, report: null }
  }

  io.print(`Matching Submissions at start: ${s.count}`)
  if (args.limit !== null) io.print(`Writing at most ${args.limit} (--limit)`)
  const report = await applyBackfill(store, candidates, {
    limit: args.limit,
    onResult: io.onResult,
    onBatch: (b) => io.print(`Batch ${b.batch}: sent ${b.sent}, updated ${b.updated}, skipped ${b.skipped}, failed ${b.failed}`),
  })
  io.print(`Updated: ${report.updated}`)
  io.print(`Skipped (no longer matching): ${report.skipped}`)
  io.print(`Failed: ${report.failed}`)
  if (report.unknown) io.print(`Outcome unknown (request failed): ${report.unknown}`)
  io.print(`Not reached: ${report.notReached}`)
  const codes = Object.entries(report.failureCodes)
  if (codes.length) io.print(`Failure codes: ${codes.map(([k, v]) => `${k}=${v}`).join(', ')}`)
  if (report.stopped) io.print(`Stopped at ${report.stopped}`)
  return { exitCode: report.stopped ? 1 : 0, report }
}

/** How long one Salesforce request may take. A collection update of 200 runs triggers and flows. */
export const SALESFORCE_BACKFILL_TIMEOUT_MS = 120_000

export interface SubmissionStoreDeps {
  instanceUrl: string
  token: () => Promise<string>
  /** Clears a cached token Salesforce refused, so the retry fetches a fresh one. */
  evictToken: () => Promise<void>
  fetch?: typeof fetch
  timeoutMs?: number
}

/**
 * The SubmissionStore over Salesforce's REST API: the shared url and header
 * rules (salesforce-api.ts), and a token from the caller, which the operator
 * script gets from getSalesforceToken.
 */
export function salesforceSubmissionStore(deps: SubmissionStoreDeps): SubmissionStore {
  const doFetch = deps.fetch ?? fetch
  const timeoutMs = deps.timeoutMs ?? SALESFORCE_BACKFILL_TIMEOUT_MS
  const origin = new URL(deps.instanceUrl).origin

  const call = async (op: string, url: string, init: { method: string; body?: string }): Promise<unknown> => {
    const send = async (token: string) =>
      doFetch(url, {
        method: init.method,
        headers: salesforceRequestHeaders(token, 'backfill-fallback-pd-timestamp'),
        body: init.body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    let res = await send(await deps.token())
    // A cached token Salesforce has expired answers 401 until the cache ages out.
    // A 401 means nothing was processed, so one retry with a fresh token is safe.
    if (res.status === 401) {
      await deps.evictToken()
      res = await send(await deps.token())
    }
    const text = await res.text()
    if (!res.ok) throw new Error(`Salesforce ${op} failed (${res.status}): ${refusalText(text)}`)
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error(`Salesforce ${op} answered ${res.status} with a body that is not JSON`)
    }
  }

  return {
    async query(soql) {
      return (await call('query', salesforceQueryUrl(deps.instanceUrl, soql), { method: 'GET' })) as QueryPage
    },
    async queryMore(nextRecordsUrl) {
      const url = salesforceNextPageUrl(deps.instanceUrl, nextRecordsUrl)
      if (new URL(url).origin !== origin) throw new Error('Salesforce gave a next page on another host, so it was not followed')
      return (await call('queryMore', url, { method: 'GET' })) as QueryPage
    },
    async update(rows) {
      if (rows.length > MAX_BATCH) throw new Error(`${rows.length} records is more than one request may carry (${MAX_BATCH})`)
      const body = {
        allOrNone: false,
        records: rows.map((r) => ({ attributes: { type: SUBMISSION_OBJECT }, id: r.Id, [TIMESTAMP_FIELD]: r.value })),
      }
      return (await call('composite update', salesforceDataUrl(deps.instanceUrl, '/composite/sobjects'), {
        method: 'PATCH',
        body: JSON.stringify(body),
      })) as UpdateResult[]
    },
  }
}
