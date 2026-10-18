// Snowflake REST API client for the lead_sightings export job.
// Auth: key-pair JWT (RS256). Service user `bidspoke_service` with RSA_PUBLIC_KEY
// configured in Snowflake; private key lives in the SNOWFLAKE_PRIVATE_KEY worker secret.

import { formatErr } from './format-error'
import { TokenMemo } from './token-memo'

export interface SnowflakeConfig {
  account: string         // e.g., 'jyc55588.us-east-1' (URL prefix)
  user: string            // e.g., 'bidspoke_service'
  privateKeyPem: string   // RSA private key in PEM (PKCS#1 or PKCS#8)
  database: string
  schema: string
  warehouse: string
  role: string
}

/**
 * A statement Snowflake rejected, carrying the structured fields of the
 * rejection rather than only the prose.
 *
 * Added for the archive identity check (#914), which has to tell a PERMISSION
 * refusal from a sleeping warehouse. Classifying that by matching words in the
 * message is exactly the branch-on-substring L35 warns about: the wording is
 * Snowflake's to change, and an unrecognised message would fall to whichever
 * side the regex happened to leave.
 *
 * Existing callers read `.message` and are unaffected.
 */
export class SnowflakeStatementError extends Error {
  readonly status: number
  /** Snowflake's own error code, e.g. 003001 for insufficient privileges. */
  readonly code: string | null

  constructor(message: string, status: number, code: string | null) {
    super(message)
    this.name = 'SnowflakeStatementError'
    this.status = status
    this.code = code
  }
}

/** Pulls Snowflake's structured error code out of a response body, if it has one. */
export function snowflakeErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown }
    return typeof parsed.code === 'string' ? parsed.code : null
  } catch {
    return null
  }
}

export interface SnowflakeStatementResponse {
  resultSetMetaData?: {
    numRows?: number
    rowType?: Array<{ name: string; type: string }>
    /**
     * One entry per result partition. Partition 0 arrives inline as `data`; the
     * rest have to be fetched by statement handle. Absent for a result that fits
     * in one partition (#986).
     */
    partitionInfo?: Array<{ rowCount?: number }>
  }
  data?: unknown[][]
  message?: string
  code?: string
  statementHandle?: string
  statementStatusUrl?: string
}

// ============================================================
// Public API
// ============================================================

/**
 * The ceiling this timeout has to stay under, in seconds.
 *
 * NOT ours to set. The edge in front of Snowflake answers `error code: 524`
 * when the origin has not responded, measured twice on the archive at roughly
 * this point. A statement timeout past it would replace a clean cancellation,
 * which names the statement and the limit it hit, with an opaque gateway error
 * carrying neither.
 */
export const EDGE_TIMEOUT_CEILING_SECONDS = 100

/**
 * How long Snowflake may spend on one statement before cancelling it (#1447).
 *
 * Was 60, which was cancelling real writes. Measured 2026-09-22: the execution
 * archive stopped three runs in 40 hours on this limit, and the 15:23 UTC run
 * spent 642 seconds resubmitting one statement three times, each attempt
 * cancelled at 60 seconds, and archived nothing for its trouble.
 *
 * The statements are not large. A healthy hour uses 9 to 13 sends for about 25
 * MB, so roughly 2 MB each, and the two failures on one hour landed on its
 * second and its tenth send, which rules out a single pathological record and
 * leaves Snowflake itself being slow. So the remedy is room, not smaller work:
 * this costs nothing on a statement that was always going to finish quickly.
 *
 * Shared with the nightly exports, which hold their own wall budget, so a slow
 * statement now blocks one of them for up to this long instead of 60 seconds.
 */
export const STATEMENT_TIMEOUT_SECONDS = 90

/**
 * The longest any one request to Snowflake may go without a complete answer.
 *
 * None of these fetches carried a deadline, and on 2026-09-23 the 14:23 UTC
 * archive run ended `exceededWallTime` at 899,991 ms of wall time against 5,174
 * ms of CPU: it waited out the platform's whole 15 minute cron limit on a call
 * that neither answered nor failed. The run's own wall budget is consulted
 * between pieces of work, so it cannot end a call already in flight (L110).
 *
 * Set past EDGE_TIMEOUT_CEILING_SECONDS because the edge answers a slow
 * statement itself at that ceiling with a 524 the retry path already handles, so
 * this only fires on a request that the edge did not answer either. The
 * relationship is asserted in the tests, not only stated here.
 */
export const REQUEST_DEADLINE_MS = (EDGE_TIMEOUT_CEILING_SECONDS + 20) * 1000

/**
 * A statement never sent, because even one attempt could run past the time the
 * caller gives up at (#1591).
 *
 * Its own class, and deliberately NOT a SnowflakeStatementError, because nothing
 * reached Snowflake: a caller that reported this as a Snowflake failure would send
 * whoever reads the alert to look for a fault in a service that was never asked.
 * It means the caller is out of time, which callers treat as their budget
 * stopping them.
 */
export class SnowflakeNotSentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnowflakeNotSentError'
  }
}

/** A request abandoned at its deadline, distinct from one that failed outright. */
export class SnowflakeRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnowflakeRequestTimeoutError'
  }
}

/**
 * fetch, then read the whole body, inside one deadline. The body is covered too
 * because a response whose headers arrive and whose body then stalls hangs the
 * run exactly as a silent connection does.
 */
async function fetchTextWithDeadline(
  url: string,
  init: RequestInit,
  deadlineMs: number,
): Promise<{ res: Response; text: string }> {
  const signal = AbortSignal.timeout(deadlineMs)
  try {
    const res = await fetch(url, { ...init, signal })
    const text = await res.text()
    return { res, text }
  } catch (e) {
    if (signal.aborted) {
      throw new SnowflakeRequestTimeoutError(
        `Snowflake ${init.method ?? 'GET'} sent no answer within ${deadlineMs} ms, so the request was abandoned`,
      )
    }
    throw e
  }
}

/**
 * The request body for one statement, built where it can be read back.
 *
 * Its own function so the timeout it carries is provable without a signing key
 * or a network: a constant beside a literal in a request nobody can assemble in
 * a test is a number nothing checks (L3).
 */
export function statementRequestBody(
  config: SnowflakeConfig,
  statement: string,
  bindings?: unknown[],
): Record<string, unknown> {
  // Snowflake stores unquoted identifiers uppercase. Send uppercase to match
  // regardless of how the secret is set.
  const body: Record<string, unknown> = {
    statement,
    timeout: STATEMENT_TIMEOUT_SECONDS,
    database: config.database.toUpperCase(),
    schema: config.schema.toUpperCase(),
    warehouse: config.warehouse.toUpperCase(),
    role: config.role.toUpperCase(),
  }
  if (bindings && bindings.length > 0) {
    const bindMap: Record<string, { type: string; value: string }> = {}
    for (let i = 0; i < bindings.length; i++) {
      bindMap[String(i + 1)] = { type: 'TEXT', value: bindings[i] == null ? '' : String(bindings[i]) }
    }
    body.bindings = bindMap
  }
  return body
}

/**
 * The edges, in seconds, of the buckets attempt durations are counted in
 * (#1443). Chosen around the numbers the timeout decision turns on: Snowflake's
 * 45 second switch to async, the statement timeout this client sends (60 until
 * #1447, STATEMENT_TIMEOUT_SECONDS since), and the edge ceiling past it.
 */
export const SEND_DURATION_BUCKETS_SECONDS = [5, 15, 30, 45, 60, 90, 120] as const

/** What one run's Snowflake sends cost, as written into its run record. */
export interface SnowflakeSendStats {
  /** Statements that reached Snowflake at least once. */
  statements: number
  /** Every POST, first attempts and resubmits alike. */
  attempts: number
  resubmits: number
  /** Statements refused before their first attempt, because it could outrun the caller's deadline. */
  notSent: number
  /** Statements Snowflake answered with 202 and that had to be polled. */
  asyncStatements: number
  /** Failed attempts by HTTP status, or `no_response` when none arrived. */
  failedAttempts: Record<string, number>
  /** The highest HTTP status among the failed attempts, or null when none failed with one. */
  worstStatus: number | null
  slowestAttemptMs: number
  totalAttemptMs: number
  /** One statement from send to result, resubmits and polling included. */
  slowestStatementMs: number
  totalStatementMs: number
  /** Attempts counted by duration, keyed `<5`, `<15`, ... and `>=120`. */
  attemptSeconds: Record<string, number>
}

function bucketLabel(ms: number): string {
  for (const edge of SEND_DURATION_BUCKETS_SECONDS) if (ms < edge * 1000) return `<${edge}`
  return `>=${SEND_DURATION_BUCKETS_SECONDS[SEND_DURATION_BUCKETS_SECONDS.length - 1]}`
}

/**
 * Counts what a run's Snowflake sends cost and how often they were retried
 * (#1443).
 *
 * Owned by the CALLER, one per run, and passed down with each statement, so the
 * figures land in that run's own record. Nothing here is module state: a count
 * kept at module scope would mix every invocation an isolate happens to serve.
 *
 * Before this the only trace of a resubmit was a console line in Workers Logs,
 * which nobody can read at a glance and few people may read at all (#958), and
 * no duration below a whole run was recorded anywhere. So a slowly degrading
 * Snowflake, where every write starts needing a second attempt, looked exactly
 * like a healthy one until a budget ran out, and the statement timeout had to be
 * chosen without the distribution it should be chosen from.
 *
 * The clock is the meter's own, so the durations it records are measured on the
 * same clock a test controls.
 */
export class SnowflakeSendMeter {
  private statements = 0
  private attempts = 0
  private resubmits = 0
  private notSent = 0
  private asyncStatements = 0
  private readonly failedAttempts: Record<string, number> = {}
  private worstStatus: number | null = null
  private slowestAttemptMs = 0
  private totalAttemptMs = 0
  private slowestStatementMs = 0
  private totalStatementMs = 0
  private readonly attemptSeconds: Record<string, number> = Object.fromEntries(
    [...SEND_DURATION_BUCKETS_SECONDS.map((edge) => `<${edge}`), `>=${SEND_DURATION_BUCKETS_SECONDS[SEND_DURATION_BUCKETS_SECONDS.length - 1]}`].map(
      (label) => [label, 0],
    ),
  )

  constructor(readonly now: () => number = Date.now) {}

  /** One POST. `status` is null when no response arrived at all. */
  recordAttempt(ms: number, status: number | null): void {
    this.attempts++
    this.totalAttemptMs += ms
    this.slowestAttemptMs = Math.max(this.slowestAttemptMs, ms)
    this.attemptSeconds[bucketLabel(ms)]++
    if (status !== null && status >= 200 && status < 300) return
    const key = status === null ? 'no_response' : String(status)
    this.failedAttempts[key] = (this.failedAttempts[key] ?? 0) + 1
    if (status !== null) this.worstStatus = Math.max(this.worstStatus ?? 0, status)
  }

  recordResubmit(): void {
    this.resubmits++
  }

  recordNotSent(): void {
    this.notSent++
  }

  recordAsync(): void {
    this.asyncStatements++
  }

  recordStatement(ms: number): void {
    this.statements++
    this.totalStatementMs += ms
    this.slowestStatementMs = Math.max(this.slowestStatementMs, ms)
  }

  snapshot(): SnowflakeSendStats {
    return {
      statements: this.statements,
      attempts: this.attempts,
      resubmits: this.resubmits,
      notSent: this.notSent,
      asyncStatements: this.asyncStatements,
      failedAttempts: { ...this.failedAttempts },
      worstStatus: this.worstStatus,
      slowestAttemptMs: this.slowestAttemptMs,
      totalAttemptMs: this.totalAttemptMs,
      slowestStatementMs: this.slowestStatementMs,
      totalStatementMs: this.totalStatementMs,
      attemptSeconds: { ...this.attemptSeconds },
    }
  }
}

/** What a caller may tell one statement about the run it belongs to. */
export interface StatementOptions {
  /**
   * Epoch ms after which the caller will have stopped, so no resubmit may be
   * started that could still be running then (#1451). Omitted means only the
   * attempt count bounds the retries, which is what every caller without a
   * budget of its own has always had.
   */
  giveUpAt?: number
  /** Where this statement's attempts, retries and duration are counted (#1443). */
  meter?: SnowflakeSendMeter
  /** Injected so a test crossing a resubmit delay or a poll does not wait. */
  sleep?: (ms: number) => Promise<void>
}

export async function executeStatement(
  config: SnowflakeConfig,
  statement: string,
  bindings?: unknown[],
  opts: StatementOptions = {},
): Promise<SnowflakeStatementResponse> {
  // One token per identity, reused across statements until it nears expiry
  // (#609). Signing per statement re-imported the key and re-signed hundreds of
  // times in one export run for a token valid for an hour.
  const jwt = await sharedTokenCache.token(config)
  const url = `https://${snowflakeHost(config.account)}/api/v2/statements`
  const body = statementRequestBody(config, statement, bindings)

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${jwt}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'bidspoke-worker/1.0',
    'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
  }

  const meter = opts.meter
  const startedAt = meter?.now()
  // A fresh requestId per statement. Resubmitting the SAME requestId with
  // retry=true is Snowflake's idempotency contract: it will not execute a
  // statement that already succeeded, which is what makes retrying a request
  // that died before we saw its response safe.
  // Stamped before the send, so a statement that goes async can say how long it
  // had already run when polling began (#608).
  const sentAt = Date.now()
  let sent = false
  try {
    const { status, text } = await postStatementWithRetry(url, headers, JSON.stringify(body), crypto.randomUUID(), {
      giveUpAt: opts.giveUpAt,
      meter,
      now: meter?.now,
      sleep: opts.sleep,
    })
    sent = true
    if (status === 202) meter?.recordAsync()
    return await resolveStatementResult(config, headers, status, text, { sentAt, sleep: opts.sleep })
  } catch (e) {
    // A statement never sent is counted as not sent, not as a statement.
    if (!(e instanceof SnowflakeNotSentError)) sent = true
    throw e
  } finally {
    if (meter && startedAt !== undefined && sent) meter.recordStatement(meter.now() - startedAt)
  }
}

// Statuses worth resubmitting. 429/503/504 are Snowflake's own documented
// retryable set; 502 is the same Envoy-proxy class as the 503 that aborted the
// bids export on 2026-07-09 ("upstream connect error or disconnect/reset before
// headers"). 500 is deliberately NOT here: it can mean the statement itself
// failed server-side, and retrying would just hide a real error behind a delay.
//
// 408 and 524 are the two spellings of the SAME timeout the 504 above stands
// for, and they were added on 2026-09-22 after each one stopped an execution
// archive run that a resubmit would very likely have carried (#1440): a 524
// twice, which is the edge in front of Snowflake giving up on the origin, and a
// 408 carrying `Statement reached its statement or warehouse timeout of 60
// second(s) and was canceled`, which is Snowflake reporting the statement
// timeout this client itself sends (60 at the time, now
// STATEMENT_TIMEOUT_SECONDS). Neither can mean the statement failed, which is the
// ambiguity that keeps 500 off this list, so neither needs the body inspected.
//
// A 408 says the statement was CANCELED, so the resubmit is a genuine second
// attempt rather than a no-op de-duplicated by the requestId contract. That is
// the intended behaviour: the archive's hours succeed 35 runs in 39, so the
// slowness is a busy warehouse rather than a statement that can never fit, and
// a caller whose budget the attempts eat still stops cleanly on its own deadline
// instead of losing the whole run to one slow write.
const TRANSIENT_STATUSES = new Set([408, 429, 502, 503, 504, 524])

// The one 500 that is not a statement failure. On 2026-08-11 the 16:37 UTC
// sightings export died on its first MERGE with HTTP 500 and body
// `{"code":"ErrorCode{messageCode=370001}","message":"Idle timeout expired:
// 30001/30000 ms"}`. That is Snowflake timing out on its own side after 30s,
// which the blanket 500 rule above treated as fatal.
//
// Matched on the timeout WORDS, not on 370001: Snowflake uses 370001 as a
// generic internal-error code that also fires for genuinely broken SQL, so
// keying on the code would start silently retrying real failures. Resubmitting
// is safe for the same reason it is for a dropped connection: the requestId
// contract below means Snowflake will not re-run a statement that already
// succeeded, which is exactly the ambiguity a timeout leaves us with.
const TRANSIENT_500_BODY = /idle timeout expired/i

export function isTransientSnowflakeError(status: number, body?: string): boolean {
  if (TRANSIENT_STATUSES.has(status)) return true
  return status === 500 && body !== undefined && TRANSIENT_500_BODY.test(body)
}

export interface RetryOptions {
  maxAttempts?: number
  requestDeadlineMs?: number
  delaysMs?: number[]
  sleep?: (ms: number) => Promise<void>
  /** See StatementOptions.giveUpAt. */
  giveUpAt?: number
  /** Epoch ms. Injected so the give-up arithmetic is testable without waiting. */
  now?: () => number
  /** Where attempts, resubmits and refusals are counted (#1443). */
  meter?: SnowflakeSendMeter
}

/**
 * How many times a statement may be CANCELLED at its own statement timeout
 * before it is not sent again (#1451).
 *
 * A 408 is Snowflake cancelling the statement at STATEMENT_TIMEOUT_SECONDS, so a
 * resubmit is the same work against the same limit. On 2026-09-22 the three
 * attempts on one archive hour were identical and so were their outcomes, and
 * the third cost another full timeout for nothing. Two is kept rather than one
 * because the archive's hours succeed 35 runs in 39: a single cancel is usually a
 * busy moment, and a second one in a row says the warehouse is not going to take
 * this statement now. Other transient failures keep the full attempt count.
 */
const MAX_STATEMENT_TIMEOUTS = 2

// Bounded on purpose. The export's per-run wall-time budget (12 min, see
// sightings-export.ts) is spent across hundreds of batches, so a long retry
// ladder on any one batch would starve the drain. Worst case here is ~5s of
// waiting per batch, and exportTable's deadline check stops the run cleanly if
// a sustained Snowflake outage eats the budget anyway.
const RETRY_MAX_ATTEMPTS = 3
const RETRY_DELAYS_MS = [1_000, 4_000]

/**
 * POST a statement, resubmitting on transient failures.
 *
 * Retries carry the original requestId plus retry=true so Snowflake dedupes a
 * statement that already ran. That matters most for the case we cannot observe:
 * a connection dropped before headers, where the MERGE may or may not have been
 * applied. Exported for unit testing.
 */
export async function postStatementWithRetry(
  url: string,
  headers: Record<string, string>,
  body: string,
  requestId: string,
  opts: RetryOptions = {},
): Promise<{ status: number; text: string }> {
  const maxAttempts = opts.maxAttempts ?? RETRY_MAX_ATTEMPTS
  const delaysMs = opts.delaysMs ?? RETRY_DELAYS_MS
  const doSleep = opts.sleep ?? sleep
  const deadlineMs = opts.requestDeadlineMs ?? REQUEST_DEADLINE_MS
  const now = opts.now ?? Date.now
  let statementTimeouts = 0

  // The same rule the resubmit below follows, applied before the FIRST attempt
  // too (#1591). Inside an archive hour sends run one after another, so a batch
  // can start seconds before the run's deadline and then take a whole request
  // deadline, which is long enough to reach the platform's cron kill.
  if (opts.giveUpAt !== undefined && now() + deadlineMs > opts.giveUpAt) {
    opts.meter?.recordNotSent()
    throw new SnowflakeNotSentError(
      `not sent: ${Math.max(0, Math.round((opts.giveUpAt - now()) / 1000))}s left before the caller's deadline, ` +
        `and one attempt can take ${Math.round(deadlineMs / 1000)}s`,
    )
  }

  for (let attempt = 1; ; attempt++) {
    const target = `${url}?requestId=${encodeURIComponent(requestId)}${attempt > 1 ? '&retry=true' : ''}`
    let retryable: boolean
    let error: Error

    const attemptStartedAt = now()
    try {
      const { res, text } = await fetchTextWithDeadline(target, { method: 'POST', headers, body }, deadlineMs)
      opts.meter?.recordAttempt(now() - attemptStartedAt, res.status)
      if (res.ok) return { status: res.status, text }
      if (res.status === 408) statementTimeouts++
      retryable = isTransientSnowflakeError(res.status, text)
      error = new SnowflakeStatementError(`Snowflake ${res.status}: ${text}`, res.status, snowflakeErrorCode(text))
    } catch (e) {
      // fetch rejected or hit its deadline, so no complete response arrived.
      // Always retryable: the requestId contract covers the ambiguity about
      // whether it executed.
      retryable = true
      error = e instanceof Error ? e : new Error(formatErr(e))
      opts.meter?.recordAttempt(now() - attemptStartedAt, null)
    }

    if (!retryable || attempt >= maxAttempts) throw error
    // Both refusals below keep the original error, class and status included,
    // and only say in front of it why nothing more was tried, so a caller that
    // reads the status still can and a reader of the message learns the reason.
    if (statementTimeouts >= MAX_STATEMENT_TIMEOUTS) {
      error.message = `statement timed out twice, so it was not sent a third time: ${error.message}`
      throw error
    }
    const delayMs = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)]
    // The run's wall budget is checked between hours, never during a send, so
    // this is the only place a batch that keeps failing can be stopped before it
    // spends the rest of the run (#1451). An attempt is priced at its full
    // request deadline, because that is how long one can take before anything
    // here gets to decide again.
    if (opts.giveUpAt !== undefined && now() + delayMs + deadlineMs > opts.giveUpAt) {
      error.message =
        `gave up after attempt ${attempt} of ${maxAttempts}: another could run past the caller's deadline ` +
        `${Math.max(0, Math.round((opts.giveUpAt - now()) / 1000))}s away: ${error.message}`
      throw error
    }
    // A silent retry makes one benign stall and a systemic Snowflake
    // degradation indistinguishable: a run where most batches retried looked
    // exactly like a clean run, so the first visible signal was a whole run
    // dying. Log every resubmit so the rate is countable before that.
    console.warn(
      `[snowflake] retrying statement ${requestId} (attempt ${attempt} of ${maxAttempts}): ${error.message}`,
    )
    opts.meter?.recordResubmit()
    await doSleep(delayMs)
  }
}

// Decide the result of a 2xx statement response. A 200 carries the completed
// result; a 202 means the statement is still running (it didn't finish within
// the body `timeout`, e.g. a cold-warehouse resume) and only carries a
// statementHandle to poll. Treating 202 as success would let the export stamp
// exported_at and purge the source rows 24h later even if the MERGE never
// completed — so poll the statement to a terminal state instead.
// Exported for unit testing.
export async function resolveStatementResult(
  config: SnowflakeConfig,
  headers: Record<string, string>,
  status: number,
  text: string,
  pollOpts?: PollOptions,
): Promise<SnowflakeStatementResponse> {
  if (status === 202) {
    const parsed = parseResponse(text)
    const handle = parsed.statementHandle
    if (!handle) throw new Error(`Snowflake returned 202 without a statementHandle: ${text}`)
    const polled = await pollStatement(config, headers, handle, pollOpts)
    // The handle we polled with is the fallback, so a terminal body that does not
    // echo it can still have its later partitions fetched. Anything the body does
    // carry wins.
    return assembleResultPartitions(config, headers, { statementHandle: handle, ...polled }, pollOpts?.requestDeadlineMs)
  }
  return assembleResultPartitions(config, headers, parseResponse(text), pollOpts?.requestDeadlineMs)
}

/**
 * Return the statement's WHOLE result, or refuse (#986).
 *
 * Snowflake chunks a large result set into partitions. Partition 0 comes inline
 * with the statement response and the rest are separate GETs, so reading `data`
 * alone silently answers with a prefix of the result. Nothing about a prefix
 * looks wrong: it parses, it has the right columns, and it arrives faster than
 * the whole thing would (L98).
 *
 * The row count is reconciled against `numRows` in BOTH directions of arrival,
 * the multi-partition fetch and the plain single-partition read, because a
 * truncation that comes with no `partitionInfo` at all would otherwise pass. Only
 * a SHORT result is refused: a surplus cannot be truncation, and a DML
 * statement's result is a one-row count whose `numRows` contract this code does
 * not own, so refusing on any inequality would risk the export path to catch a
 * case that carries no data-loss risk.
 *
 * A failed partition fetch throws rather than returning what it has. There is no
 * retry here on purpose: the callers that read multi-row results are scheduled
 * jobs whose next run measures the same day again, and a partial result that had
 * been retried into existence is indistinguishable from a complete one.
 */
export async function assembleResultPartitions(
  config: SnowflakeConfig,
  headers: Record<string, string>,
  response: SnowflakeStatementResponse,
  requestDeadlineMs: number = REQUEST_DEADLINE_MS,
): Promise<SnowflakeStatementResponse> {
  const partitions = response.resultSetMetaData?.partitionInfo
  const declaredRows = response.resultSetMetaData?.numRows
  const rows: unknown[][] = [...(response.data ?? [])]

  if (partitions !== undefined && partitions.length > 1) {
    const handle = response.statementHandle
    if (!handle) {
      throw new Error(
        `Snowflake declared ${partitions.length} result partitions without a statementHandle to fetch them with, ` +
          `so only the ${rows.length} rows of partition 0 could be read`,
      )
    }
    for (let index = 1; index < partitions.length; index++) {
      rows.push(...(await fetchPartition(config, headers, handle, index, partitions.length, requestDeadlineMs)))
    }
  }

  if (typeof declaredRows === 'number' && rows.length < declaredRows) {
    throw new Error(
      `Snowflake returned ${rows.length} of the ${declaredRows} rows it declared for this statement, ` +
        `across ${partitions?.length ?? 1} partition(s), so the result is incomplete`,
    )
  }

  return { ...response, data: rows }
}

async function fetchPartition(
  config: SnowflakeConfig,
  headers: Record<string, string>,
  handle: string,
  index: number,
  total: number,
  requestDeadlineMs: number,
): Promise<unknown[][]> {
  const url = `https://${snowflakeHost(config.account)}/api/v2/statements/${handle}?partition=${index}`
  const { res, text } = await fetchTextWithDeadline(url, { method: 'GET', headers }, requestDeadlineMs)
  if (!res.ok) {
    throw new SnowflakeStatementError(
      `Snowflake returned ${res.status} for partition ${index} of ${total}: ${text}`,
      res.status,
      snowflakeErrorCode(text),
    )
  }
  return parseResponse(text).data ?? []
}

export interface PollOptions {
  intervalMs?: number
  maxAttempts?: number
  requestDeadlineMs?: number
  /** Injected so a test can poll without waiting. */
  sleep?: (ms: number) => Promise<void>
  /** Epoch ms. Injected with `sleep` so the elapsed figures are testable. */
  now?: () => number
  /**
   * Epoch ms at which the statement was first sent. Every log line and failure
   * reports elapsed time from here, because that is the time the caller's wall
   * budget actually lost. Omitted means polling began at send.
   */
  sentAt?: number
}

const POLL_INTERVAL_MS = 2000
// ~60s of polling, spent only on a statement that came back 202 because it had
// not finished inside STATEMENT_TIMEOUT_SECONDS. So the longest one attempt can
// take is that limit plus this, and the comment names the constant rather than
// a number, which is what let it go on saying 60 after the limit moved (#1449).
const POLL_MAX_ATTEMPTS = 30

// Poll GET /api/v2/statements/{handle} until the statement reaches a terminal
// state. 202 = still running (keep polling); 2xx = complete (return the body);
// non-2xx = failed (throw, so the export batch fails and retries next run
// without stamping exported_at). Exhausting the attempts also throws.
//
// Logged at entry, on every poll and at completion (#608). This path spends a
// caller's wall budget sleeping, up to POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS per
// statement, and it used to say nothing, so a run slowing down here looked the
// same as a run that was simply slow, and the timeout it ended in did not say it
// had been waiting. Every failure it throws now carries how long it waited.
// Exported for unit testing.
export async function pollStatement(
  config: SnowflakeConfig,
  headers: Record<string, string>,
  handle: string,
  pollOpts: PollOptions = {},
): Promise<SnowflakeStatementResponse> {
  const intervalMs = pollOpts.intervalMs ?? POLL_INTERVAL_MS
  const maxAttempts = pollOpts.maxAttempts ?? POLL_MAX_ATTEMPTS
  const deadlineMs = pollOpts.requestDeadlineMs ?? REQUEST_DEADLINE_MS
  const doSleep = pollOpts.sleep ?? sleep
  const now = pollOpts.now ?? Date.now
  const url = `https://${snowflakeHost(config.account)}/api/v2/statements/${handle}?partition=0`
  const pollingFrom = now()
  const sentAt = pollOpts.sentAt ?? pollingFrom
  const sinceSent = (): string => `${Math.round((now() - sentAt) / 1000)}s after it was sent`

  console.warn(
    `[snowflake] statement ${handle} went async (202) ${sinceSent()}; ` +
      `polling every ${Math.round(intervalMs / 1000)}s, at most ${maxAttempts} times`,
  )

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await doSleep(intervalMs)
    const { res, text } = await fetchTextWithDeadline(url, { method: 'GET', headers }, deadlineMs)
    const elapsed = Math.round((now() - sentAt) / 1000)
    if (res.status === 202) {
      console.warn(
        `[snowflake] statement ${handle} still running after poll ${attempt} of ${maxAttempts}, ${elapsed}s since it was sent`,
      )
      continue
    }
    if (!res.ok) {
      throw new SnowflakeStatementError(
        `Snowflake poll ${res.status} on poll ${attempt} of ${maxAttempts}, ${elapsed}s after statement ${handle} was sent: ${text}`,
        res.status,
        snowflakeErrorCode(text),
      )
    }
    console.warn(`[snowflake] statement ${handle} completed after ${attempt} polls, ${elapsed}s after it was sent`)
    return parseResponse(text)
  }
  throw new Error(
    `Snowflake statement ${handle} did not complete after ${maxAttempts} polls, ${sinceSent()}: ` +
      `it went async and was waited on for ${Math.round((now() - pollingFrom) / 1000)}s`,
  )
}

function parseResponse(text: string): SnowflakeStatementResponse {
  try {
    return JSON.parse(text) as SnowflakeStatementResponse
  } catch {
    return { message: text }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ============================================================
// Host / account name helpers
// ============================================================

export function snowflakeHost(account: string): string {
  // 'jyc55588.us-east-1' → 'jyc55588.us-east-1.snowflakecomputing.com'
  return `${account.toLowerCase()}.snowflakecomputing.com`
}

// Encode a string for a Snowflake single-quoted literal. Snowflake treats
// backslash as an escape character inside string literals, so a lone trailing
// backslash would escape the closing quote and break out of the literal (SQL
// injection / query corruption). Double backslashes first, then double quotes.
// Shared by every call site that hand-builds SQL text (export VALUES lists,
// schema-sync filters) so the escaping lives in exactly one place.
export function escapeSqlLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "''")
}

function accountForJwt(account: string): string {
  // JWT iss/sub uses just the account locator (no region), uppercased.
  return account.split('.')[0].toUpperCase()
}

// ============================================================
// JWT signer
// ============================================================

/** How long a signed token is valid for, which Snowflake caps at one hour. */
export const JWT_LIFETIME_SECONDS = 3600

/**
 * How much life a cached token must still have to be handed out (#609).
 *
 * A token is checked when each request ARRIVES, and one statement can hold its
 * headers for a long time: resubmits, a poll after a 202, partition fetches.
 * The platform ends a cron invocation at 15 minutes, so a margin of 20 means a
 * token handed out at any moment of a run is still valid when that run is
 * killed, whatever the statement does in between. The cost is re-signing every
 * 40 minutes instead of every 60, which is nothing next to once per statement.
 */
export const TOKEN_REUSE_MARGIN_MS = 20 * 60 * 1000

/**
 * Signed tokens, one per Snowflake identity (#609), held in a TokenMemo
 * (`lib/token-memo.ts`, #2335) so there is one implementation of the memo.
 *
 * Keyed on account, user AND the key itself: the archive signs as several
 * identities (reader, writer, eraser), and a rotated key must never be answered
 * with a token signed by the old one, so the key is the memo key's generation.
 * It lives at module scope, so it outlives one invocation inside a reused
 * isolate, which is safe only because reuse is decided by the token's own expiry
 * rather than by the invocation: nothing is handed out with less than
 * TOKEN_REUSE_MARGIN_MS left.
 *
 * The memo stores the promise rather than the string, so a burst of statements
 * that arrive together share one signing, and a signing that fails is evicted so
 * the next statement tries again instead of inheriting the rejection.
 */
export class SnowflakeTokenCache {
  private readonly memo: TokenMemo<string>

  constructor(now: () => number = Date.now) {
    this.memo = new TokenMemo<string>({ now, reuseMarginMs: TOKEN_REUSE_MARGIN_MS })
  }

  token(config: SnowflakeConfig): Promise<string> {
    const key = {
      connectionId: `snowflake:${config.account}`,
      generation: config.privateKeyPem,
      sub: config.user,
      scope: '',
    }
    return this.memo.get(key, async (at) => {
      const iat = Math.floor(at / 1000)
      const privateKey = await importPrivateKey(config.privateKeyPem)
      return {
        value: await signSnowflakeJwt(config, privateKey, iat),
        expiresAtMs: (iat + JWT_LIFETIME_SECONDS) * 1000,
      }
    })
  }
}

const sharedTokenCache = new SnowflakeTokenCache()

/**
 * A Snowflake key pair JWT for `account` and `user`, issued at `iat` (seconds).
 * Exported unchanged for the ops Snowflake minter (#2335), which signs for a
 * connection's declared account and user, so both lanes sign one way.
 */
export async function signSnowflakeJwt(config: Pick<SnowflakeConfig, 'account' | 'user'>, privateKey: CryptoKey, iat: number): Promise<string> {
  const fingerprint = await publicKeyFingerprint(privateKey)
  const account = accountForJwt(config.account)
  const user = config.user.toUpperCase()
  const iss = `${account}.${user}.SHA256:${fingerprint}`
  const sub = `${account}.${user}`
  const payload = { iss, sub, iat, exp: iat + JWT_LIFETIME_SECONDS }
  return signRs256Jwt(privateKey, payload)
}

/**
 * A compact RS256 JWT (RSASSA-PKCS1-v1_5 over SHA-256) of `payload`, with the
 * header `{ alg: 'RS256', typ: 'JWT' }` (#2335). Shared by the Snowflake key
 * pair token above and the ops login minters; it lives here, generalised in
 * place, so the export's signing is the same code it always was.
 */
export async function signRs256Jwt(privateKey: CryptoKey, payload: Readonly<Record<string, unknown>>): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' }

  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)))
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const signingInput = `${headerB64}.${payloadB64}`

  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`
}

async function publicKeyFingerprint(privateKey: CryptoKey): Promise<string> {
  // Export private as JWK to get n + e, build a public-only JWK, import as
  // public key, then export as SPKI (DER) and SHA-256 hash that.
  const jwk = (await crypto.subtle.exportKey('jwk', privateKey)) as JsonWebKey
  const publicJwk: JsonWebKey = {
    kty: 'RSA',
    n: jwk.n,
    e: jwk.e,
    alg: 'RS256',
    ext: true,
  }
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    publicJwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify'],
  )
  const spki = (await crypto.subtle.exportKey('spki', publicKey)) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', spki)
  // Snowflake expects standard base64 (with padding), not base64url.
  return bytesToBase64Standard(new Uint8Array(digest))
}

// ============================================================
// PEM parser — handles PKCS#1 and PKCS#8
// ============================================================

/**
 * An RSA private key from PEM (PKCS#1 or PKCS#8), for RS256 signing. Exported
 * unchanged for the ops minters (#2335): the Snowflake key pair and a Google
 * service account key are both PEM, so both lanes read a key one way.
 */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const trimmed = pem.replace(/\r/g, '').trim()
  const isPkcs1 = trimmed.includes('BEGIN RSA PRIVATE KEY')
  const der = pemToDer(trimmed)
  const pkcs8 = isPkcs1 ? pkcs1ToPkcs8(der) : der

  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true, // extractable — needed so we can derive the public key for fingerprinting
    ['sign'],
  )
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  return base64ToBytes(b64)
}

// Wrap PKCS#1 RSAPrivateKey in PKCS#8 PrivateKeyInfo envelope.
// Layout:
//   SEQUENCE {
//     INTEGER 0,
//     AlgorithmIdentifier { OID rsaEncryption, NULL },
//     OCTET STRING <pkcs1 bytes>
//   }
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const algorithmId = new Uint8Array([
    0x30, 0x0d,                                                       // SEQUENCE, len 13
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, // OID 1.2.840.113549.1.1.1
    0x05, 0x00,                                                       // NULL
  ])
  const version = new Uint8Array([0x02, 0x01, 0x00]) // INTEGER 0

  const octetHeader = derLengthPrefix(0x04, pkcs1.length)
  const innerLen = version.length + algorithmId.length + octetHeader.length + pkcs1.length
  const outerHeader = derLengthPrefix(0x30, innerLen)

  const out = new Uint8Array(outerHeader.length + innerLen)
  let i = 0
  out.set(outerHeader, i); i += outerHeader.length
  out.set(version, i); i += version.length
  out.set(algorithmId, i); i += algorithmId.length
  out.set(octetHeader, i); i += octetHeader.length
  out.set(pkcs1, i)
  return out
}

// DER tag + length, supporting short, 1-byte, and 2-byte length forms.
function derLengthPrefix(tag: number, length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([tag, length])
  if (length < 0x100) return new Uint8Array([tag, 0x81, length])
  return new Uint8Array([tag, 0x82, (length >> 8) & 0xff, length & 0xff])
}

// ============================================================
// Base64 helpers
// ============================================================

function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64Standard(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function bytesToBase64Standard(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
