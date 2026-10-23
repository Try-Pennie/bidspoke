import { ActionFailure } from '../failure'
import type { ActionArgs, ActionContext, JsonValue } from '../types'
import {
  COLUMN_NAME, dataUrl, invalid, isObject, objectName, recordId, SALESFORCE_BULK_MAX_BYTES, SALESFORCE_RESULTS_MAX_ROWS, salesforceObject, salesforceSend, text,
  unreadable, type SalesforceRequest,
} from './call'
import { CsvError, parseCsv, toCsv } from './csv'

/**
 * Bulk API 2.0 ingest jobs (#2337), as the parser workflows run them by hand:
 * open a job (POST /jobs/ingest), upload one CSV (PUT .../batches), close it
 * (PATCH state UploadComplete), and read its state and results later (GET
 * /jobs/ingest/<id>, .../failedResults, .../successfulResults), since a job
 * runs after the step that closed it.
 *
 * An open job runs nothing until it is closed. So a failure before the close
 * aborts the job (PATCH state Aborted, best effort: an abort that fails leaves an
 * open job that still runs nothing) and is not applied; what the connection
 * bound fetch throws for the upload passes on unchanged after the abort. Once
 * the close is sent the records may be running, so a close whose answer is lost
 * is settled by reading the job back (#2337's rule for an uncertain send: a read
 * back decides whether the write landed): still Open, nothing ran, so the
 * job is aborted and the failure passes on; UploadComplete, InProgress or
 * JobComplete, the close landed and the step succeeds; anything else, or a read
 * back that fails, is `salesforce_bulk_close_unknown`, outcome unknown, naming
 * the job to check.
 */

export const BULK_OPERATIONS = ['insert', 'update', 'upsert', 'delete'] as const

/** A cell as the CSV writes it: Bulk API 2.0 reads #N/A as null, and an empty cell as "leave as it is". */
function cell(value: JsonValue, place: number, column: string): string {
  if (value === null) return '#N/A'
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value) && !/e/i.test(String(value))) return String(value)
  throw invalid(`record ${place}'s ${column} is not text, a plain number, a boolean or null`)
}

/** Every record as one CSV, its columns the first record's fields; every record must have the same fields (L705). */
function csvOf(records: readonly JsonValue[]): string {
  const first = records[0]
  if (!isObject(first)) throw invalid('record 1 is not an object')
  const columns = Object.keys(first)
  if (columns.length === 0 || columns.some((c) => !COLUMN_NAME.test(c))) throw invalid('every column must be a field API name, such as Status or Account.External_Id__c')
  const same = new Set(columns)
  const rows = records.map((r, i) => {
    if (!isObject(r)) throw invalid(`record ${i + 1} is not an object`)
    const keys = Object.keys(r)
    if (keys.length !== columns.length || keys.some((k) => !same.has(k))) {
      throw new ActionFailure('salesforce_bulk_rows_differ', `record ${i + 1} has other fields than record 1; every record of a bulk job must name the same fields`, 'not_applied')
    }
    return columns.map((c) => cell(r[c], i + 1, c))
  })
  return toCsv(columns, rows)
}

async function abort(ctx: ActionContext, url: string): Promise<void> {
  try {
    const response = await ctx.fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ state: 'Aborted' }), signal: ctx.signal })
    await response.body?.cancel()
  } catch {
    // An open job runs nothing; the failure that led here is the one reported.
  }
}

export async function ingest(ctx: ActionContext, instance: string, args: ActionArgs): Promise<JsonValue> {
  const object = objectName(args)
  const operation = text(args, 'operation').trim()
  if (!(BULK_OPERATIONS as readonly string[]).includes(operation)) throw invalid(`operation must be one of ${BULK_OPERATIONS.join(', ')}`)
  const externalId = operation === 'upsert' ? objectName(args, 'external_id_field') : null
  if (operation !== 'upsert' && args.external_id_field !== undefined && args.external_id_field !== null) throw invalid('only an upsert names an external_id_field')
  const records = args.records
  if (!Array.isArray(records) || records.length === 0) throw invalid('records must be a list of one or more objects of field API names and values')
  const csv = csvOf(records as readonly JsonValue[])
  const bytes = new TextEncoder().encode(csv).length
  if (bytes > SALESFORCE_BULK_MAX_BYTES) {
    throw new ActionFailure('salesforce_bulk_upload_too_large', `the CSV is ${bytes} bytes, over the ${SALESFORCE_BULK_MAX_BYTES} a step uploads; split the records across steps`, 'not_applied')
  }

  const jobs = dataUrl(instance, '/jobs/ingest')
  const open: SalesforceRequest = {
    method: 'POST', url: jobs, what: `POST jobs/ingest (${object} ${operation})`, effect: 'opens',
    body: { object, operation, ...(externalId === null ? {} : { externalIdFieldName: externalId }), contentType: 'CSV', lineEnding: 'LF', columnDelimiter: 'COMMA' },
  }
  const job = await salesforceObject(ctx, open)
  const jobId = job.id
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9]{1,18}$/.test(jobId)) throw unreadable(open, 'named no job id')
  const jobUrl = `${jobs}/${jobId}`

  try {
    await salesforceSend(ctx, { method: 'PUT', url: `${jobUrl}/batches`, body: csv, contentType: 'text/csv', what: `PUT job ${jobId} batches`, effect: 'opens' })
  } catch (err) {
    await abort(ctx, jobUrl)
    throw err
  }

  const close: SalesforceRequest = { method: 'PATCH', url: jobUrl, body: { state: 'UploadComplete' }, what: `PATCH job ${jobId} UploadComplete`, effect: 'write' }
  const done = (state: JsonValue | undefined) => ({ job_id: jobId, state: typeof state === 'string' ? state : 'UploadComplete', object, operation, records: records.length })
  let closed: Readonly<Record<string, JsonValue>>
  try {
    closed = await salesforceObject(ctx, close)
  } catch (err) {
    if (err instanceof ActionFailure) {
      if (err.outcome === 'not_applied') await abort(ctx, jobUrl)
      throw err
    }
    // The connection bound fetch threw: before sending (a requeue, a refused login) or after (a timeout). The job's own
    // state says which: still open, nothing runs, so it is aborted and the failure passes on; closed, the close landed.
    const state = await stateOf(ctx, jobUrl)
    if (state === 'Open') {
      await abort(ctx, jobUrl)
      throw err
    }
    if (state !== null && CLOSED_STATES.has(state)) return done(state)
    throw new ActionFailure('salesforce_bulk_close_unknown', `the close of job ${jobId} was sent and its answer lost, and the job could not be read back as open or closed, so its records may be running; read the job before anything is sent again`, 'unknown')
  }
  return done(closed.state)
}

/** The states of a job whose close landed: it is queued, running or finished. */
const CLOSED_STATES: ReadonlySet<string> = new Set(['UploadComplete', 'InProgress', 'JobComplete'])

/** A job's state, read back, or null when it cannot be read. */
async function stateOf(ctx: ActionContext, jobUrl: string): Promise<string | null> {
  try {
    const job = await salesforceObject(ctx, { method: 'GET', url: jobUrl, what: 'GET jobs/ingest', effect: 'read' })
    return typeof job.state === 'string' ? job.state : null
  } catch {
    // Unreadable: the caller reports the close's outcome as unknown.
    return null
  }
}

async function results(ctx: ActionContext, jobUrl: string, kind: 'failedResults' | 'successfulResults'): Promise<JsonValue[]> {
  const request: SalesforceRequest = { method: 'GET', url: `${jobUrl}/${kind}`, accept: 'text/csv', what: `GET job ${kind}`, effect: 'read' }
  const answer = await salesforceSend(ctx, request)
  let lines: string[][]
  try {
    lines = parseCsv(answer.text)
  } catch (err) {
    if (err instanceof CsvError) throw unreadable(request, 'was not CSV')
    throw err
  }
  if (lines.length === 0) return []
  const [header, ...rows] = lines
  if (rows.length > SALESFORCE_RESULTS_MAX_ROWS) {
    throw new ActionFailure('salesforce_results_over_cap', `the job has ${rows.length} ${kind} rows, over the ${SALESFORCE_RESULTS_MAX_ROWS} a step reads, so none is returned`, 'not_applied')
  }
  return rows.map((row, i) => {
    if (row.length !== header.length) throw unreadable(request, `row ${i + 1} has ${row.length} fields under ${header.length} columns`)
    return Object.fromEntries(header.map((h, j) => [h, row[j]]))
  })
}

export async function readJob(ctx: ActionContext, instance: string, args: ActionArgs, wants: { failed: boolean; successful: boolean }): Promise<JsonValue> {
  const id = recordId(args, 'job_id')
  const jobUrl = dataUrl(instance, `/jobs/ingest/${id}`)
  const job = await salesforceObject(ctx, { method: 'GET', url: jobUrl, what: 'GET jobs/ingest', effect: 'read' })
  const out: Record<string, JsonValue> = { job }
  if (wants.failed) out.failed_results = await results(ctx, jobUrl, 'failedResults')
  if (wants.successful) out.successful_results = await results(ctx, jobUrl, 'successfulResults')
  return out
}
