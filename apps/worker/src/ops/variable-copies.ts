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
 * current version (asked of the bidding Worker in requests of
 * MAX_RUN_VARIABLES_PER_REQUEST, one after another, stopping at the first that
 * fails), all in one save_variable_copies call, which rewrites only the rows
 * that changed. The tick skips the refresh when its own workflow fetch failed
 * or its claimed ask did, so a bidding outage costs one failed request a
 * minute, not one per workflow. The names a version reads are taken from its
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
import { ENV_KEY, envReferences, namedVariables as named } from '../lib/definition-env-references'
import { MAX_RUN_VARIABLES_PER_REQUEST, parseServedOpsRunVariables, type OpsRunVariablesRequest, type ReadRunVariables } from '../lib/ops-gateway-contract'
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

/** The ops database, as the copy uses it. The live one is ops-writes.ts through tick-live.ts. */
export interface VariableCopyDb {
  readVariableCopies(organizationId: OrganizationId, versions: ReadonlyArray<{ workflowId: string; versionNumber: number }>): Promise<VariableCopy[]>
  /** The one write of the copies (save_variable_copies). Only writeVariableCopies calls it. */
  saveVariableCopies(copies: readonly VariableCopyInput[]): Promise<SaveVariableCopiesResult>
  /** One version's frozen definition (workflow_definition), or null when ops does not hold it. */
  readDefinition(organizationId: OrganizationId, workflowId: string, versionNumber: number): Promise<Record<string, unknown> | null>
}

type Served = Extract<ReadRunVariables, { kind: 'served' }>

const bytes = (text: string) => new TextEncoder().encode(text).length

/**
 * One version's copy from what the bidding Worker served and every name the
 * version reads: each plain value, each secret by NAME only, and each name it
 * did not serve as absent. A served name the version does not read is not
 * kept. Null for a version past the database's bounds, so it is left out
 * rather than failing the save of every other.
 */
export function copyInputOf(organizationId: OrganizationId, served: Served, names: readonly string[]): VariableCopyInput | null {
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
    } else if (Object.hasOwn(served.secretValues, n)) {
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
  fetchRunVariables(request: OpsRunVariablesRequest): Promise<unknown>
  /** What the tick's claimed ask served, each with its organization. */
  served: ReadonlyArray<{ organizationId: OrganizationId; read: Served }>
  /** Every switched on workflow that may start, at its current version; empty when the refresh is skipped. */
  refresh: readonly CopyTarget[]
  /** One line per failure, never a value. */
  log(step: string, fields: Record<string, string | number>): void
}

function bump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by
}

/**
 * The copies' one write, a tick at most (the module comment says what is
 * written and when). Never throws: each failure is counted, and logged without
 * a value, and the rest goes on, since nothing here may cost a run.
 */
export async function writeVariableCopies(w: WriteVariableCopies): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  const served = new Map<string, { organizationId: OrganizationId; read: Served }>()
  for (const s of w.served) served.set(versionKey(s.organizationId, s.read.workflowId, s.read.versionNumber), s)
  const wanted = new Map<string, CopyTarget>()
  for (const s of w.served) wanted.set(versionKey(s.organizationId, s.read.workflowId, s.read.versionNumber), { organizationId: s.organizationId, workflowId: s.read.workflowId, versionNumber: s.read.versionNumber })
  for (const t of w.refresh) wanted.set(versionKey(t.organizationId, t.workflowId, t.versionNumber), t)
  if (wanted.size === 0) return counts
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

  // 2. The refresh: every version whose names are known and that no claimed run was served, one request after another.
  const requests: OpsRunVariablesRequest[] = []
  for (const organizationId of organizations) {
    const ask = (byOrganization.get(organizationId) ?? []).filter((t) => {
      const key = versionKey(organizationId, t.workflowId, t.versionNumber)
      return names.has(key) && !served.has(key)
    })
    for (let at = 0; at < ask.length; at += MAX_RUN_VARIABLES_PER_REQUEST) {
      requests.push({ organization_id: organizationId, runs: ask.slice(at, at + MAX_RUN_VARIABLES_PER_REQUEST).map((t) => ({ workflow_id: t.workflowId, version_number: t.versionNumber })) })
    }
  }
  for (const request of requests) {
    try {
      const read = parseServedOpsRunVariables(await w.fetchRunVariables(request), request)
      bump(counts, 'variable_copies_refresh_requests')
      const organizationId = request.organization_id as OrganizationId
      for (const r of read.runs) {
        if (r.kind === 'served') served.set(versionKey(organizationId, r.workflowId, r.versionNumber), { organizationId, read: r })
        else bump(counts, 'variable_copies_refresh_refused')
      }
      if (read.unreadable.length > 0) bump(counts, 'variable_copies_refresh_unreadable', read.unreadable.length)
    } catch (err) {
      // The bidding Worker is likely down: each further request would wait out its own deadline.
      bump(counts, 'variable_copies_refresh_failed')
      w.log('variable_copies_refresh_failed', { organization_id: request.organization_id, versions: request.runs.length, error: formatErr(err) })
      break
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
  return counts
}
