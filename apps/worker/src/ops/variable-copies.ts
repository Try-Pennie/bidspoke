/**
 * The last good copy of each ops version's plain variables (#2999, phase 3 of
 * #2982; Dan's decisions of 2026-10-28 and 29): what a claimed run uses only
 * when the bidding Worker cannot be reached.
 *
 * WHAT IS KEPT (ops migration 20261029220000, ops_variable_copies). One row per
 * name a version reads: a plain variable with its value, a secret by NAME
 * only, or absent (the bidding Worker served no such variable), under a
 * version row whose existence says that list is whole. Never a secret's value:
 * VariableCopyInput has no field one could travel in, and the database's CHECK
 * holds a secret row's value null.
 *
 * THE ONE WRITER (writeVariableCopies), the minute tick in live mode, after its
 * own opsRunVariables answers. It writes the versions the claimed runs were
 * served, and refreshes every switched on workflow that may start at its
 * current version, all in one save_variable_copies call, which rewrites only
 * the rows that changed. The refresh (#3034) asks the bidding Worker in the
 * names mode (secrets 'names'), so bidding decrypts nothing and sends no
 * secret value, in requests of MAX_RUN_VARIABLES_PER_REQUEST, at most
 * VARIABLE_COPY_REFRESH_AT_ONCE at once, all under one deadline,
 * VARIABLE_COPY_REFRESH_DEADLINE_MS: the first failure or the deadline ends
 * it, no further request is started, and none of its answers is written that
 * tick (the claimed runs' versions still are). A claimed run's own answer
 * reaches this module through copySourceOf, its secrets by name only. The tick
 * skips the refresh when its own workflow fetch failed (#3000: the plan's
 * "skips when its workflow fetch already failed this tick", and only then), so
 * a bidding outage costs one failed request a minute, not one per workflow;
 * one that begins after the fetch succeeded, the claimed runs' own ask failing
 * included, costs at most the VARIABLE_COPY_REFRESH_AT_ONCE requests already
 * in flight, all ended by the one deadline. Running beside a claimed ask that
 * failed is what tells runs that fell back to the copy while bidding was up
 * (runs_on_variable_copy) from a bidding outage. The names a version reads are taken from its
 * copy once held, otherwise from its frozen definition (envReferences, the one
 * reading of that question), at most VARIABLE_COPY_DEFINITIONS_PER_TICK
 * definitions a tick; a version whose names cannot be told is not asked for.
 * ops-variable-copies-one-writer.test.ts holds every other module off the write.
 *
 * THE FALLBACK (variablesFromCopies, judgeCopy), when the tick's request for
 * the claimed runs' variables timed out, threw, or its whole answer could not
 * be read: a run whose version's copy is younger than the age limit (judged on
 * the database clock), whose definition reads no secret, and every one of
 * whose names the copy covers, is dispatched with the copy's plain values
 * (source copy), a name the copy holds as absent then failing the run by name
 * as it does today. Any other is returned to the queue unstarted. A run the
 * bidding Worker refused by name never reaches here.
 */
import { raceDeadline } from '../lib/alert-claim'
import { ENV_KEY, envReferences, namedVariables as named } from '../lib/definition-env-references'
import {
  MAX_RUN_VARIABLES_PER_REQUEST, parseServedOpsRunVariableNames,
  type OpsRunVariableNamesRequest, type OpsRunVariablesRequest, type ReadRunVariableNames, type ReadRunVariables,
} from '../lib/ops-gateway-contract'
import { formatErr } from '../lib/format-error'
import type { OrganizationId } from './ops-db'
import {
  MAX_VARIABLE_COPIES_PER_SAVE, MAX_VARIABLE_COPY_KEY_BYTES, MAX_VARIABLE_COPY_NAMES, MAX_VARIABLE_COPY_VALUE_BYTES,
  type ClaimedRun, type SaveVariableCopiesResult, type VariableCopy, type VariableCopyInput,
} from './ops-writes'
import type { DispatchedRunVariables } from './run-variables'

/**
 * How stale an unchanged version's confirmed_at may get before a save moves it.
 * Rewriting every version row every minute would be one write per switched on
 * workflow a minute for nothing; this keeps it to one per ten minutes, and the
 * age a fallback reads is then at most this much older than the truth, which
 * only ever refuses a copy sooner (fail safe against a 6 hour limit).
 */
export const VARIABLE_COPY_CONFIRM_EVERY_SECONDS = 600

/** The frozen definitions one tick reads to tell a new version's names: a burst of new versions is spread over the minutes that follow. */
export const VARIABLE_COPY_DEFINITIONS_PER_TICK = 40

/** The most one version's values may come to before it is left out of the copy, and the most one save call carries. */
export const MAX_VARIABLE_COPY_VERSION_BYTES = 1024 * 1024
export const MAX_VARIABLE_COPY_SAVE_BYTES = 4 * 1024 * 1024

/**
 * The most refresh requests in flight at once (#3034). Four: under the
 * platform's six simultaneous outbound connections an invocation may hold, so
 * the tick's own database calls running beside the refresh are not queued
 * behind it, and at most four bidding invocations read the bidding database
 * for it at once (each reads up to MAX_RUN_VARIABLES_PER_REQUEST versions in
 * parallel). The Pipedream export's 346 workflows make 9 requests, 3 rounds.
 */
export const VARIABLE_COPY_REFRESH_AT_ONCE = 4

/**
 * The one deadline the whole refresh runs under (#3034): one gateway call's
 * (GATEWAY_DEADLINE_MS in tick-live.ts, which a test holds equal), so the
 * refresh can hold a tick no longer than a single request could, however many
 * workflows are switched on. Sequential requests with a deadline each could
 * have held it about 2 minutes at 346 workflows.
 */
export const VARIABLE_COPY_REFRESH_DEADLINE_MS = 15_000

/** The ops database, as the copy uses it. The live one is ops-writes.ts through tick-live.ts. */
export interface VariableCopyDb {
  readVariableCopies(organizationId: OrganizationId, versions: ReadonlyArray<{ workflowId: string; versionNumber: number }>): Promise<VariableCopy[]>
  /** The one write of the copies (save_variable_copies). Only writeVariableCopies calls it. */
  saveVariableCopies(copies: readonly VariableCopyInput[]): Promise<SaveVariableCopiesResult>
  /** One version's frozen definition (workflow_definition), or null when ops does not hold it. */
  readDefinition(organizationId: OrganizationId, workflowId: string, versionNumber: number): Promise<Record<string, unknown> | null>
}

/**
 * One version's variables as the copy is written from them: the plain values
 * and each secret by NAME (#3034). No field a secret value could travel in, so
 * nothing past copySourceOf ever holds one.
 */
export interface CopySource {
  workflowId: string
  versionNumber: number
  values: Record<string, string>
  secretKeys: readonly string[]
  servedAt: string
}

/** A claimed run's served answer as the copy takes it: its secrets by name, their values left behind (#3034). */
export function copySourceOf(read: Extract<ReadRunVariables, { kind: 'served' }>): CopySource {
  return { workflowId: read.workflowId, versionNumber: read.versionNumber, values: { ...read.values }, secretKeys: Object.keys(read.secretValues), servedAt: read.servedAt }
}

const bytes = (text: string) => new TextEncoder().encode(text).length

/**
 * One version's copy from what the bidding Worker served and every name the
 * version reads: each plain value, each secret by NAME only, and each name it
 * did not serve as absent. A served name the version does not read is not
 * kept. Null for a version past the database's bounds, so it is left out
 * rather than failing the save of every other.
 */
export function copyInputOf(organizationId: OrganizationId, served: CopySource, names: readonly string[]): VariableCopyInput | null {
  const unique = [...new Set(names)]
  if (unique.length > MAX_VARIABLE_COPY_NAMES) return null
  if (unique.some((n) => !ENV_KEY.test(n) || bytes(n) > MAX_VARIABLE_COPY_KEY_BYTES)) return null
  const values: Record<string, string> = {}
  const secretKeys: string[] = []
  const absentKeys: string[] = []
  let total = 0
  for (const n of unique) {
    if (Object.hasOwn(served.values, n)) {
      const size = bytes(served.values[n])
      if (size > MAX_VARIABLE_COPY_VALUE_BYTES) return null
      total += size
      values[n] = served.values[n]
    } else if (served.secretKeys.includes(n)) {
      secretKeys.push(n)
    } else {
      absentKeys.push(n)
    }
  }
  if (total > MAX_VARIABLE_COPY_VERSION_BYTES) return null
  return { organizationId, workflowId: served.workflowId, versionNumber: served.versionNumber, servedAt: served.servedAt, values, secretKeys, absentKeys }
}

/** Whether a claimed run may use its version's copy, and with what, or why not. */
export type CopyJudgement = { kind: 'use'; variables: DispatchedRunVariables } | { kind: 'refuse'; why: string }

/**
 * One run against its version's copy. reads is what its frozen definition
 * reads (envReferences), or null when ops does not hold the definition. Never
 * a secret: the copy holds none, so a run that reads one waits for bidding.
 */
export function judgeCopy(copy: VariableCopy | undefined, reads: readonly string[] | null, staleAfterMs: number): CopyJudgement {
  if (copy === undefined) return { kind: 'refuse', why: 'no copy of this version\'s variables is kept' }
  if (!(Date.parse(copy.dbNow) - Date.parse(copy.confirmedAt) < staleAfterMs)) {
    return { kind: 'refuse', why: `the copy kept of this version's variables was last confirmed more than ${staleAfterMs / 3_600_000} hours ago` }
  }
  if (reads === null) return { kind: 'refuse', why: 'ops does not hold this version\'s definition, so which variables it reads cannot be told' }
  const secret = reads.filter((k) => copy.secretKeys.includes(k))
  if (secret.length > 0) {
    return { kind: 'refuse', why: `the definition reads the secret ${secret.length === 1 ? 'variable' : 'variables'} ${named(secret)}, whose value the copy never holds` }
  }
  const uncovered = reads.filter((k) => !Object.hasOwn(copy.values, k) && !copy.absentKeys.includes(k))
  if (uncovered.length > 0) {
    return { kind: 'refuse', why: `the definition reads ${named(uncovered)}, which the copy never asked the bidding Worker about` }
  }
  return { kind: 'use', variables: { source: 'copy', servedAt: copy.servedAt, values: { ...copy.values }, secretValues: {} } }
}

const versionKey = (organizationId: string, workflowId: string, versionNumber: number) => `${organizationId}:${workflowId}:${versionNumber}`

/**
 * The fallback for the claimed runs whose variables the bidding Worker could
 * not answer at all: each run judged against its version's copy, read once
 * per organization, each organization its own boundary (L73). A throw anywhere
 * refuses that organization's runs with why, so each goes back to the queue.
 */
export async function variablesFromCopies(db: VariableCopyDb, runs: readonly ClaimedRun[], staleAfterMs: number): Promise<Map<string, CopyJudgement>> {
  const judged = new Map<string, CopyJudgement>()
  const byOrganization = new Map<OrganizationId, ClaimedRun[]>()
  for (const run of runs) {
    try {
      byOrganization.set(run.organizationId, [...(byOrganization.get(run.organizationId) ?? []), run])
    } catch (err) {
      judged.set(run.runRequestId, { kind: 'refuse', why: `the run could not be matched to its copy (${formatErr(err)})` })
    }
  }
  await Promise.all([...byOrganization.entries()].map(async ([organizationId, orgRuns]) => {
    try {
      const versions = [...new Map(orgRuns.map((r) => [`${r.workflowId}:${r.workflowVersion}`, { workflowId: r.workflowId, versionNumber: r.workflowVersion }])).values()]
      const copies = await db.readVariableCopies(organizationId, versions)
      for (const v of versions) {
        const copy = copies.find((c) => c.workflowId === v.workflowId && c.versionNumber === v.versionNumber)
        // The definition is read only for a copy that could still be used.
        const fresh = copy !== undefined && Date.parse(copy.dbNow) - Date.parse(copy.confirmedAt) < staleAfterMs
        const definition = fresh ? await db.readDefinition(organizationId, v.workflowId, v.versionNumber) : null
        const judgement = judgeCopy(copy, definition === null ? null : envReferences(definition), staleAfterMs)
        for (const run of orgRuns) {
          if (run.workflowId === v.workflowId && run.workflowVersion === v.versionNumber) judged.set(run.runRequestId, judgement)
        }
      }
    } catch (err) {
      for (const run of orgRuns) {
        if (!judged.has(run.runRequestId)) judged.set(run.runRequestId, { kind: 'refuse', why: `the copy kept of its variables could not be read (${formatErr(err)})` })
      }
    }
  }))
  return judged
}

/** A version the copy is written for: a claimed run's, or a switched on workflow's current one. */
export interface CopyTarget {
  organizationId: OrganizationId
  workflowId: string
  versionNumber: number
}

export interface WriteVariableCopies {
  db: VariableCopyDb
  /** The gateway's opsRunVariables; the refresh sends only names requests through it. */
  fetchRunVariables(request: OpsRunVariablesRequest): Promise<unknown>
  /** The clock the refresh's one deadline waits on (the gateway's, injected so a test can pass it). */
  sleep(ms: number): Promise<void>
  /** What the tick's claimed ask served, each with its organization, its secrets by name (copySourceOf). */
  served: ReadonlyArray<{ organizationId: OrganizationId; read: CopySource }>
  /** Every switched on workflow that may start, at its current version; empty when the refresh is skipped. */
  refresh: readonly CopyTarget[]
  /** One line per failure, never a value. */
  log(step: string, fields: Record<string, string | number>): void
}

function bump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by
}

type RefreshOutcome =
  | { kind: 'answered'; answers: Array<{ request: OpsRunVariableNamesRequest; read: { runs: ReadRunVariableNames[]; unreadable: string[] } }> }
  | { kind: 'failed'; request: OpsRunVariableNamesRequest | null; error: string }

/**
 * How the refresh went this tick, for the tick's pages (#3000): skipped (no
 * switched on workflow it could ask about, nothing asked), answered (every
 * request answered), or failed (the first failure or the deadline ended it).
 * answeredRequests counts the requests bidding answered at all, readable or
 * not, and unreadable says, one per request, why an answer could not be read
 * whole or in part.
 */
export type VariableCopyRefresh =
  | { kind: 'nothing_asked'; answeredRequests: 0; unreadable: [] }
  | { kind: 'answered'; workflows: number; answeredRequests: number; unreadable: string[] }
  /** workflows is null when how many it covers is not known (the tick's copies write threw, #3131). */
  | { kind: 'failed'; workflows: number | null; error: string; answeredRequests: number; unreadable: string[] }

/** What the copies' write did: its counts, and how its refresh went. */
export interface VariableCopiesWritten {
  counts: Record<string, number>
  refresh: VariableCopyRefresh
}

/**
 * The refresh's requests (#3034): at most VARIABLE_COPY_REFRESH_AT_ONCE in
 * flight, all under one VARIABLE_COPY_REFRESH_DEADLINE_MS deadline. The first
 * failure (a throw, or an answer that is not the shape at all) or the deadline
 * ends it: no further request is started, and every answer, earlier ones
 * included, is dropped, so a refresh is written whole or not at all. A late
 * answer after the end is ignored.
 */
async function refreshAnswers(
  w: WriteVariableCopies, requests: readonly OpsRunVariableNamesRequest[], heard: { answered: number; unreadable: string[] },
): Promise<RefreshOutcome> {
  const answers: Extract<RefreshOutcome, { kind: 'answered' }>['answers'] = []
  let failure: Extract<RefreshOutcome, { kind: 'failed' }> | null = null
  let next = 0
  const sender = async () => {
    while (failure === null && next < requests.length) {
      const request = requests[next++]
      let raw: unknown
      try {
        raw = await w.fetchRunVariables(request)
      } catch (err) {
        failure ??= { kind: 'failed', request, error: formatErr(err) }
        continue
      }
      // Answered, so whatever follows is about the answer's shape, never about reaching bidding (#3000).
      heard.answered++
      try {
        const read = parseServedOpsRunVariableNames(raw, request)
        // One reason per request (#3000): the page counts requests, and names the first reason of each.
        if (read.unreadable.length > 0) heard.unreadable.push(read.unreadable[0])
        if (failure === null) answers.push({ request, read })
      } catch (err) {
        heard.unreadable.push(formatErr(err))
        failure ??= { kind: 'failed', request, error: formatErr(err) }
      }
    }
  }
  const raced = await raceDeadline(
    () => Promise.all(Array.from({ length: Math.min(VARIABLE_COPY_REFRESH_AT_ONCE, requests.length) }, sender)),
    VARIABLE_COPY_REFRESH_DEADLINE_MS,
    (ms) => w.sleep(ms),
  )
  if (raced.kind === 'timed_out') {
    failure ??= { kind: 'failed', request: null, error: `the refresh did not finish within ${VARIABLE_COPY_REFRESH_DEADLINE_MS / 1000} s` }
  } else if (raced.kind === 'threw') {
    failure ??= { kind: 'failed', request: null, error: formatErr(raced.error) }
  }
  return failure ?? { kind: 'answered', answers }
}

/**
 * The copies' one write, a tick at most (the module comment says what is
 * written and when). Never throws: each failure is counted, and logged without
 * a value, and the rest goes on, since nothing here may cost a run.
 */
export async function writeVariableCopies(w: WriteVariableCopies): Promise<VariableCopiesWritten> {
  const counts: Record<string, number> = {}
  let refresh: VariableCopyRefresh = { kind: 'nothing_asked', answeredRequests: 0, unreadable: [] }
  const served = new Map<string, { organizationId: OrganizationId; read: CopySource }>()
  for (const s of w.served) served.set(versionKey(s.organizationId, s.read.workflowId, s.read.versionNumber), s)
  const wanted = new Map<string, CopyTarget>()
  for (const s of w.served) wanted.set(versionKey(s.organizationId, s.read.workflowId, s.read.versionNumber), { organizationId: s.organizationId, workflowId: s.read.workflowId, versionNumber: s.read.versionNumber })
  for (const t of w.refresh) wanted.set(versionKey(t.organizationId, t.workflowId, t.versionNumber), t)
  if (wanted.size === 0) return { counts, refresh }
  const byOrganization = new Map<OrganizationId, CopyTarget[]>()
  for (const t of wanted.values()) byOrganization.set(t.organizationId, [...(byOrganization.get(t.organizationId) ?? []), t])
  const organizations = [...byOrganization.keys()].sort()

  // 1. The names each version reads: from its copy once held, else from its frozen definition.
  const names = new Map<string, string[]>()
  let definitionsRead = 0
  for (const organizationId of organizations) {
    const versions = byOrganization.get(organizationId) ?? []
    try {
      for (let at = 0; at < versions.length; at += MAX_VARIABLE_COPIES_PER_SAVE) {
        for (const c of await w.db.readVariableCopies(organizationId, versions.slice(at, at + MAX_VARIABLE_COPIES_PER_SAVE))) {
          names.set(versionKey(organizationId, c.workflowId, c.versionNumber), [...Object.keys(c.values), ...c.secretKeys, ...c.absentKeys])
        }
      }
    } catch (err) {
      bump(counts, 'variable_copies_read_failed')
      w.log('variable_copies_read_failed', { organization_id: organizationId, error: formatErr(err) })
      continue
    }
    for (const v of versions) {
      const key = versionKey(organizationId, v.workflowId, v.versionNumber)
      if (names.has(key)) continue
      if (definitionsRead >= VARIABLE_COPY_DEFINITIONS_PER_TICK) {
        bump(counts, 'variable_copies_names_deferred')
        continue
      }
      definitionsRead++
      try {
        const definition = await w.db.readDefinition(organizationId, v.workflowId, v.versionNumber)
        if (definition === null) bump(counts, 'variable_copies_names_unknown')
        else names.set(key, envReferences(definition))
      } catch (err) {
        bump(counts, 'variable_copies_names_unknown')
        w.log('variable_copy_definition_read_failed', { organization_id: organizationId, workflow_id: v.workflowId, version_number: v.versionNumber, error: formatErr(err) })
      }
    }
  }

  // 2. The refresh: every version whose names are known and that no claimed run was served, by name only, concurrently under one deadline.
  const requests: OpsRunVariableNamesRequest[] = []
  for (const organizationId of organizations) {
    const ask = (byOrganization.get(organizationId) ?? []).filter((t) => {
      const key = versionKey(organizationId, t.workflowId, t.versionNumber)
      return names.has(key) && !served.has(key)
    })
    for (let at = 0; at < ask.length; at += MAX_RUN_VARIABLES_PER_REQUEST) {
      requests.push({
        organization_id: organizationId,
        runs: ask.slice(at, at + MAX_RUN_VARIABLES_PER_REQUEST).map((t) => ({ workflow_id: t.workflowId, version_number: t.versionNumber })),
        secrets: 'names',
      })
    }
  }
  if (requests.length > 0) {
    const heard = { answered: 0, unreadable: [] as string[] }
    const outcome = await refreshAnswers(w, requests, heard)
    const workflows = requests.reduce((n, r) => n + r.runs.length, 0)
    refresh = outcome.kind === 'failed'
      ? { kind: 'failed', workflows, error: outcome.error, answeredRequests: heard.answered, unreadable: heard.unreadable }
      : { kind: 'answered', workflows, answeredRequests: heard.answered, unreadable: heard.unreadable }
    if (outcome.kind === 'failed') {
      // The bidding Worker is likely down, or one answer could not be read at all: nothing of this refresh is written.
      bump(counts, 'variable_copies_refresh_failed')
      w.log('variable_copies_refresh_failed', {
        ...(outcome.request === null ? {} : { organization_id: outcome.request.organization_id, versions: outcome.request.runs.length }),
        requests: requests.length, error: outcome.error,
      })
    } else {
      for (const { request, read } of outcome.answers) {
        bump(counts, 'variable_copies_refresh_requests')
        const organizationId = request.organization_id as OrganizationId
        for (const r of read.runs) {
          if (r.kind === 'served') {
            served.set(versionKey(organizationId, r.workflowId, r.versionNumber), {
              organizationId, read: { workflowId: r.workflowId, versionNumber: r.versionNumber, values: r.values, secretKeys: r.secretKeys, servedAt: r.servedAt },
            })
          } else {
            bump(counts, 'variable_copies_refresh_refused')
          }
        }
        if (read.unreadable.length > 0) bump(counts, 'variable_copies_refresh_unreadable', read.unreadable.length)
      }
    }
  }

  // 3. The copies, each version whole, in as few saves as the bounds allow (one, at today's sizes).
  const inputs: VariableCopyInput[] = []
  for (const [key, s] of served) {
    const reads = names.get(key)
    if (reads === undefined) continue
    const input = copyInputOf(s.organizationId, s.read, reads)
    if (input === null) bump(counts, 'variable_copies_too_large')
    else inputs.push(input)
  }
  const saves: VariableCopyInput[][] = []
  let size = 0
  for (const input of inputs) {
    const inputBytes = bytes(JSON.stringify(input))
    const last = saves[saves.length - 1]
    if (last === undefined || last.length >= MAX_VARIABLE_COPIES_PER_SAVE || size + inputBytes > MAX_VARIABLE_COPY_SAVE_BYTES) {
      saves.push([input])
      size = inputBytes
    } else {
      last.push(input)
      size += inputBytes
    }
  }
  for (const save of saves) {
    try {
      const r = await w.db.saveVariableCopies(save)
      bump(counts, 'variable_copies_versions_written', r.versionsWritten)
      bump(counts, 'variable_copies_versions_unchanged', r.versionsUnchanged)
      bump(counts, 'variable_copies_keys_written', r.keysWritten)
      bump(counts, 'variable_copies_keys_deleted', r.keysDeleted)
      bump(counts, 'variable_copies_refused_no_copy', r.refusedNoCopy)
      bump(counts, 'variable_copies_refused_older', r.refusedOlder)
    } catch (err) {
      bump(counts, 'variable_copies_save_failed')
      w.log('variable_copies_save_failed', { versions: save.length, error: formatErr(err) })
    }
  }
  return { counts, refresh }
}
