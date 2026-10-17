/**
 * The run engine's vocabularies agree with the ops database's CHECK constraints
 * (#1948, L83).
 *
 * The database is what refuses a wrong value; run-vocabulary.ts is what the
 * Worker and its readers switch over. A status added to one and not the other
 * is a reader that silently omits it, or a write the database refuses only in
 * production. This reads each named constraint out of the ops migrations and
 * compares its list with the TypeScript one, as a set.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'
import {
  ALL_OBSERVATION_REASONS,
  CONNECTION_COPY_STATES,
  CONNECTION_STATUSES,
  ALL_STATUS_REASONS,
  ENGINE_FAILED_REASONS,
  EXECUTION_STATUSES,
  HOLDER_FAILED_REASONS,
  LEASED_RUN_REQUEST_STATUSES,
  LEDGER_METHODS,
  OBSERVATION_OUTCOMES,
  OBSERVATION_REASONS,
  OPS_SWEEPS,
  OVERLAP_RULES,
  RESOURCE_WAIT_CAUSES,
  RESUME_REASONS,
  RUN_REQUEST_STATUSES,
  SEND_LEDGER_STATUSES,
  SF_BUDGET_SOURCES,
  SF_LEASE_OUTCOMES,
  SF_LEASE_PURPOSES,
  STATUS_REASONS,
  TERMINAL_RUN_REQUEST_STATUSES,
  TRIGGER_KINDS,
} from '../../../../worker/src/ops/run-vocabulary'

const MIGRATIONS = path.join(REPO_ROOT, 'supabase-ops/supabase/migrations')
const SQL = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(path.join(MIGRATIONS, f), 'utf8'))
  .join('\n')

/**
 * The quoted values of the first IN (...) list inside the named constraint, as
 * its LAST definition states it: the migrations are read in order, and a later
 * one that drops and adds a constraint (#2334 widened the sweeps) is what the
 * database holds.
 */
export function constraintValues(sql: string, name: string): string[] {
  const at = sql.lastIndexOf(`CONSTRAINT ${name} CHECK`)
  if (at < 0) throw new Error(`no constraint ${name} in the ops migrations`)
  const list = /IN\s*\(([^)]*)\)/.exec(sql.slice(at))
  if (!list) throw new Error(`constraint ${name} has no IN list`)
  return [...list[1].matchAll(/'([^']*)'/g)].map((m) => m[1])
}

/** The body of the named function as the LAST migration to create or replace it states it, up to its closing $fn$. */
export function functionBody(sql: string, name: string): string {
  const starts = [...sql.matchAll(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, 'g'))]
  if (starts.length === 0) throw new Error(`no function ${name} in the ops migrations`)
  const at = starts[starts.length - 1].index!
  const end = sql.indexOf('$fn$;', at)
  if (end < 0) throw new Error(`function ${name} has no closing $fn$`)
  return sql.slice(at, end)
}

const sorted = (values: readonly string[]) => [...values].sort()

describe('the run engine vocabularies match the ops database constraints', () => {
  it.each([
    ['run_requests_status_check', RUN_REQUEST_STATUSES],
    ['run_requests_trigger_kind_check', TRIGGER_KINDS],
    ['workflow_executions_trigger_type_check', TRIGGER_KINDS],
    ['run_requests_status_reason_check', ALL_STATUS_REASONS],
    ['run_requests_resume_reason_check', RESUME_REASONS],
    ['workflow_executions_resume_reason_check', RESUME_REASONS],
    ['run_requests_overlap_check', OVERLAP_RULES],
    ['run_requests_terminal_at_check', TERMINAL_RUN_REQUEST_STATUSES],
    ['run_requests_lease_check', LEASED_RUN_REQUEST_STATUSES],
    ['workflow_executions_status_check', EXECUTION_STATUSES],
    ['send_ledger_status_check', SEND_LEDGER_STATUSES],
    ['send_ledger_method_check', LEDGER_METHODS],
    // The minute cron's (#1949).
    ['schedule_fire_observations_outcome_check', OBSERVATION_OUTCOMES],
    ['schedule_fire_observations_reason_check', ALL_OBSERVATION_REASONS],
    ['ops_lane_sweeps_sweep_check', OPS_SWEEPS],
    // The ops connections' and Salesforce pool's (#2334).
    ['sf_leases_purpose_check', SF_LEASE_PURPOSES],
    ['sf_budget_readings_source_check', SF_BUDGET_SOURCES],
  ] as const)('%s', (name, values) => {
    expect(sorted(constraintValues(SQL, name))).toEqual(sorted(values))
  })

  it('every status that needs a reason has its reasons listed, and only those', () => {
    expect(sorted(constraintValues(SQL, 'run_requests_reason_required'))).toEqual(
      sorted(Object.keys(STATUS_REASONS).filter((s) => s !== 'failed')),
    )
  })

  it('an observation pairs each outcome with its own reasons, as the database does (#1949)', () => {
    const at = SQL.indexOf('CONSTRAINT schedule_fire_observations_pair_check CHECK')
    expect(at).toBeGreaterThan(-1)
    const pair = SQL.slice(at, SQL.indexOf(');', at))
    for (const [outcome, reasons] of Object.entries(OBSERVATION_REASONS)) {
      const clause = new RegExp(`outcome = '${outcome}' AND reason IN \\(([^)]*)\\)`).exec(pair)
      expect(clause, outcome).not.toBeNull()
      expect(sorted([...clause![1].matchAll(/'([^']*)'/g)].map((m) => m[1]))).toEqual(sorted(reasons))
    }
  })

  it('no reason belongs to two statuses, so a reason names its status', () => {
    expect(new Set(ALL_STATUS_REASONS).size).toBe(ALL_STATUS_REASONS.length)
  })

  /**
   * Three vocabularies are answers of a function rather than a CHECK (#2334), so
   * they are read out of the function's LAST definition: the values its CASE
   * gives, and the outcomes it selects.
   */
  it.each([
    ['connection_status', /(?:THEN|ELSE) '([a-z_]+)'/g, CONNECTION_STATUSES],
    ['connection_copy', /(?:THEN|ELSE) '([a-z_]+)'/g, CONNECTION_COPY_STATES],
    ['acquire_sf_lease', /SELECT '([a-z_]+)'::text/g, SF_LEASE_OUTCOMES],
  ] as const)('%s answers exactly its vocabulary', (name, pattern, values) => {
    expect(sorted([...new Set([...functionBody(SQL, name).matchAll(pattern)].map((m) => m[1]))])).toEqual(sorted(values))
  })

  it('acquire_sf_lease guards the same purposes its table allows', () => {
    const guard = /p_purpose NOT IN \(([^)]*)\)/.exec(functionBody(SQL, 'acquire_sf_lease'))
    expect(guard).not.toBeNull()
    expect(sorted([...guard![1].matchAll(/'([^']*)'/g)].map((m) => m[1]))).toEqual(sorted(SF_LEASE_PURPOSES))
  })

  it('claim_ops_sweep, as last replaced, guards the same sweeps its table allows', () => {
    const guard = /p_sweep NOT IN \(([^)]*)\)/.exec(functionBody(SQL, 'claim_ops_sweep'))
    expect(guard).not.toBeNull()
    expect(sorted([...guard![1].matchAll(/'([^']*)'/g)].map((m) => m[1]))).toEqual(sorted(OPS_SWEEPS))
  })

  /**
   * complete_run_request's guards are vocabularies too (#2334 deploy 2). A
   * holder may fail a run only for HOLDER_FAILED_REASONS: the engine alone ends
   * one for resource_wait_exceeded or lease_lapsed_repeatedly (F122), so those
   * are in the status reason CHECK and STATUS_REASONS.failed and never in this
   * guard.
   */
  function guardIn(body: string, branch: string, param: string): string[] {
    const at = body.indexOf(`WHEN '${branch}' THEN`)
    expect(at, `complete_run_request has no ${branch} branch`).toBeGreaterThan(-1)
    const guard = new RegExp(`${param} NOT IN \\(([^)]*)\\)`).exec(body.slice(at))
    expect(guard, `the ${branch} branch has no ${param} guard`).not.toBeNull()
    return [...guard![1].matchAll(/'([^']*)'/g)].map((m) => m[1])
  }

  it('complete_run_request lets a holder fail a run only for the holder reasons, never an engine only one (F122)', () => {
    const failed = guardIn(functionBody(SQL, 'complete_run_request'), 'failed', 'p_reason')
    expect(sorted(failed)).toEqual(sorted(HOLDER_FAILED_REASONS))
    expect(sorted([...HOLDER_FAILED_REASONS, ...ENGINE_FAILED_REASONS])).toEqual(sorted(STATUS_REASONS.failed))
    for (const reason of ENGINE_FAILED_REASONS) expect(failed).not.toContain(reason)
  })

  it('complete_run_request suspends for every resume reason but retry, and a resource wait names one of its causes', () => {
    const body = functionBody(SQL, 'complete_run_request')
    expect(sorted(guardIn(body, 'suspend', 'p_reason'))).toEqual(sorted(RESUME_REASONS.filter((r) => r !== 'retry')))
    expect(sorted(guardIn(body, 'suspend', 'p_error'))).toEqual(sorted(RESOURCE_WAIT_CAUSES))
    expect(sorted(constraintValues(SQL, 'run_requests_resource_wait_cause_check'))).toEqual(sorted(RESOURCE_WAIT_CAUSES))
  })

  it('a resource wait\'s causes are acquire_sf_lease\'s refusals and an acquire error', () => {
    expect(sorted(RESOURCE_WAIT_CAUSES)).toEqual(sorted([...SF_LEASE_OUTCOMES.filter((o) => o !== 'granted'), 'acquire_error']))
  })

  it('reads the last definition of a constraint and of a function (seen red)', () => {
    const twice = "CONSTRAINT c CHECK (x IN ('a'))\nCONSTRAINT c CHECK (x IN ('a', 'b'))"
    expect(constraintValues(twice, 'c')).toEqual(['a', 'b'])
    const fns = "CREATE FUNCTION public.f(p int) AS $fn$ old $fn$;\nCREATE OR REPLACE FUNCTION public.f(p int) AS $fn$ new $fn$;"
    expect(functionBody(fns, 'f')).toContain('new')
    expect(functionBody(fns, 'f')).not.toContain('old')
    expect(() => functionBody(fns, 'g')).toThrow(/no function g/)
  })

  it('fails on a list that differs from its constraint (seen red)', () => {
    const planted = "CONSTRAINT run_requests_status_check CHECK (status IN ('queued', 'claimed'))"
    expect(sorted(constraintValues(planted, 'run_requests_status_check'))).not.toEqual(sorted(RUN_REQUEST_STATUSES))
    expect(() => constraintValues(planted, 'no_such_check')).toThrow(/no constraint no_such_check/)
  })
})
