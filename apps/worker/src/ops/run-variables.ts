/**
 * An ops run's variables (#2998, phase 2 of #2982; Dan's decisions of
 * 2026-10-28 and 29): read when the run starts, secrets included.
 *
 * THE PATH. The minute tick claims runs, then asks the bidding Worker once per
 * organization for their current variables (OpsGateway.opsRunVariables, which
 * derives the names from the version it holds). Each run's answer rides that
 * run's signed dispatch (DispatchedRunVariables): plain values and secret
 * values, for that run only, never stored. The run's start records them
 * (start_run_execution, run_requests.run_variables): the source, served_at,
 * the plain values, and the secret NAMES only (RunVariablesRecord). The first
 * start's record wins, so every retry and every continued slice (#1951) uses
 * the plain values the run started with; only the secrets are asked again,
 * since they are never kept (runVariablesFor). While the bidding Worker cannot
 * be reached, a run may instead carry the last good copy's plain values
 * (source copy, #2999, variable-copies.ts), never a secret.
 *
 * A REFUSAL. The bidding Worker refuses a run by name (RUN_VARIABLES_REFUSALS).
 * The tick ends it unrun, by an outcome that already exists (refusedRunEnd):
 * a deleted workflow dead as workflow_deleted, any other failed with its
 * reason named first in the error, as a missing variable fails a run.
 */
import { ENV_KEY, namedVariables as named } from '../lib/definition-env-references'
import type { ReadRunVariables, RunVariablesRefusal } from '../lib/ops-gateway-contract'
import type { CompleteOutcome } from './ops-writes'
import { RUN_VARIABLE_SOURCES, type RunVariableSource } from './run-vocabulary'

/**
 * What a run's dispatch carries (#2998): this start's variables, secret values
 * included, for this run only. From the bidding Worker, or (#2999) from the
 * last good copy ops keeps, used only while bidding cannot be reached, which
 * holds no secret, so a copy's secretValues is always empty.
 */
export interface DispatchedRunVariables {
  source: RunVariableSource
  servedAt: string
  values: Record<string, string>
  secretValues: Record<string, string>
}

/** What a run records of its variables at its first start: never a secret's value. */
export interface RunVariablesRecord {
  source: RunVariableSource
  servedAt: string
  values: Record<string, string>
  secretKeys: string[]
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
const sameKeys = (v: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(v).sort()
  return own.length === keys.length && [...keys].sort().every((k, i) => own[i] === k)
}

/** A map of variable names to text. */
function isNamedText(v: unknown): v is Record<string, string> {
  return isRecord(v) && Object.entries(v).every(([k, x]) => ENV_KEY.test(k) && typeof x === 'string')
}

/** One served answer as a dispatch carries it. */
export function dispatchedFrom(read: Extract<ReadRunVariables, { kind: 'served' }>): DispatchedRunVariables {
  return { source: 'bidding', servedAt: read.servedAt, values: { ...read.values }, secretValues: { ...read.secretValues } }
}

/** Exactly a DispatchedRunVariables: the dispatch's check (dispatch-auth.ts). */
export function isDispatchedRunVariables(v: unknown): v is DispatchedRunVariables {
  if (!isRecord(v) || !sameKeys(v, ['source', 'servedAt', 'values', 'secretValues'])) return false
  if (!(RUN_VARIABLE_SOURCES as readonly unknown[]).includes(v.source) || !isTime(v.servedAt) || !isNamedText(v.values) || !isNamedText(v.secretValues)) return false
  // The copy keeps no secret's value, so a copy carrying one is not the copy's.
  if (v.source === 'copy' && Object.keys(v.secretValues).length > 0) return false
  const values = v.values
  return !Object.keys(v.secretValues).some((k) => Object.hasOwn(values, k))
}

/**
 * What a run reports to the tick of the variables it ran on (#3000, phase 4 of
 * #2982): where its recorded variables came from, and how old they were, in
 * whole seconds from their served_at to this start, on the run's own clock (a
 * served_at ahead of it is no age). Never a value. A retry or continued slice
 * reports its first start's source, since that record is what it runs on.
 */
export interface RunVariablesUsed {
  source: RunVariableSource
  ageSeconds: number
}

/** The report of a run's variables from its start's record, or null when it has none. */
export function variablesUsed(recorded: RunVariablesRecord | null, nowMs: number): RunVariablesUsed | null {
  if (recorded === null) return null
  return { source: recorded.source, ageSeconds: Math.max(0, Math.floor((nowMs - Date.parse(recorded.servedAt)) / 1000)) }
}

/** The record a start sends: the secret names, never their values. */
export function recordOf(d: DispatchedRunVariables): RunVariablesRecord {
  return { source: d.source, servedAt: d.servedAt, values: { ...d.values }, secretKeys: Object.keys(d.secretValues).sort() }
}

/** The record as start_run_execution takes it (p_variables) and run_requests.run_variables holds it. */
export function recordRow(r: RunVariablesRecord): { source: string; served_at: string; values: Record<string, string>; secret_keys: string[] } {
  return { source: r.source, served_at: r.servedAt, values: { ...r.values }, secret_keys: [...r.secretKeys] }
}

/** start_run_execution's run_variables: null when the run has none, and a refusal by name for any other shape. */
export function parseRunVariablesRecord(raw: unknown): RunVariablesRecord | null {
  if (raw === null) return null
  const bad = (why: string) => new Error(`run_variables ${why}`)
  if (!isRecord(raw) || !sameKeys(raw, ['source', 'served_at', 'values', 'secret_keys'])) throw bad('is not exactly { source, served_at, values, secret_keys }')
  if (!(RUN_VARIABLE_SOURCES as readonly unknown[]).includes(raw.source)) throw bad('names a source the ops Worker does not know')
  if (!isTime(raw.served_at)) throw bad('has no served_at time')
  if (!isNamedText(raw.values)) throw bad('values are not names and text')
  if (!Array.isArray(raw.secret_keys) || !raw.secret_keys.every((k) => typeof k === 'string' && ENV_KEY.test(k))) throw bad('secret_keys are not variable names')
  return { source: raw.source as RunVariableSource, servedAt: raw.served_at, values: { ...raw.values }, secretKeys: [...(raw.secret_keys as string[])] }
}

/**
 * What a run is given: the variables its definition reads, each a plain value
 * recorded at the run's first start or a secret served for this start, and the
 * secrets among them (for masking, mask-secrets.ts); or why it is given none,
 * as the run's error. Nothing is run on a blank.
 */
export function runVariablesFor(
  reads: readonly string[], recorded: RunVariablesRecord | null, secretValues: Readonly<Record<string, string>>,
): { env: Record<string, string>; secrets: Record<string, string> } | { refused: string } {
  if (reads.length === 0) return { env: {}, secrets: {} }
  if (recorded === null) {
    return { refused: `the definition reads ${named(reads)}, and the run has no record of its variables from when it started, so nothing was run` }
  }
  const missing = reads.filter((k) => !Object.hasOwn(recorded.values, k) && !recorded.secretKeys.includes(k))
  if (missing.length > 0) {
    const one = missing.length === 1
    return { refused: `the definition reads ${named(missing)}, which ${one ? 'was not a variable' : 'were not variables'} of this workflow when the run started, so nothing was run; add ${one ? 'it' : 'them'} and run it again` }
  }
  const unserved = reads.filter((k) => recorded.secretKeys.includes(k) && !Object.hasOwn(secretValues, k))
  if (unserved.length > 0) {
    const one = unserved.length === 1
    return { refused: `the definition reads the secret ${one ? 'variable' : 'variables'} ${named(unserved)}, which the run read when it started and the bidding Worker did not serve when it started again, so nothing was run` }
  }
  const env: Record<string, string> = {}
  const secrets: Record<string, string> = {}
  for (const k of reads) {
    if (Object.hasOwn(recorded.values, k)) env[k] = recorded.values[k]
    else secrets[k] = env[k] = secretValues[k]
  }
  return { env, secrets }
}

/** Why the bidding Worker would not serve a run's variables, in a sentence. Names only, never a value. */
function refusalSaid(reason: RunVariablesRefusal, keys: readonly string[], version: number): string {
  switch (reason) {
    case 'version_missing': return `the bidding Worker holds no version ${version} of this workflow`
    case 'other_organization': return 'the bidding Worker holds this workflow under another organization than the run\'s'
    case 'not_ops_lane': return 'the workflow is no longer on the ops lane'
    case 'workflow_deleted': return 'the workflow is deleted'
    case 'version_unreadable': return `version ${version}'s stored definition cannot be read, so which variables it reads cannot be told`
    case 'secret_unreadable': return `the secret ${keys.length === 1 ? 'variable' : 'variables'} ${named(keys)} would not decrypt on the bidding Worker`
  }
}

/**
 * How the tick ends, unrun, a run the bidding Worker refused (#2998). Each by
 * an outcome that already exists: a deleted workflow dead as workflow_deleted,
 * as the tick ends a run its copy says is deleted; any other failed with no
 * status reason and the refusal named first in its error, as a missing
 * variable fails a run. None falls back to another source of values.
 */
export function refusedRunEnd(refusal: { reason: RunVariablesRefusal; keys: readonly string[] }, version: number): CompleteOutcome {
  if (refusal.reason === 'workflow_deleted') return { outcome: 'dead', reason: 'workflow_deleted' }
  return { outcome: 'failed', error: `variables_refused (${refusal.reason}): ${refusalSaid(refusal.reason, refusal.keys, version)}, so nothing was run` }
}
