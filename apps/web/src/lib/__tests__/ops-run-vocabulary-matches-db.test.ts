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
  ALL_STATUS_REASONS,
  EXECUTION_STATUSES,
  LEASED_RUN_REQUEST_STATUSES,
  LEDGER_METHODS,
  OVERLAP_RULES,
  RESUME_REASONS,
  RUN_REQUEST_STATUSES,
  SEND_LEDGER_STATUSES,
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

/** The quoted values of the first IN (...) list inside the named constraint. */
export function constraintValues(sql: string, name: string): string[] {
  const at = sql.indexOf(`CONSTRAINT ${name} CHECK`)
  if (at < 0) throw new Error(`no constraint ${name} in the ops migrations`)
  const list = /IN\s*\(([^)]*)\)/.exec(sql.slice(at))
  if (!list) throw new Error(`constraint ${name} has no IN list`)
  return [...list[1].matchAll(/'([^']*)'/g)].map((m) => m[1])
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
  ] as const)('%s', (name, values) => {
    expect(sorted(constraintValues(SQL, name))).toEqual(sorted(values))
  })

  it('every status that needs a reason has its reasons listed, and only those', () => {
    expect(sorted(constraintValues(SQL, 'run_requests_reason_required'))).toEqual(
      sorted(Object.keys(STATUS_REASONS).filter((s) => s !== 'failed')),
    )
  })

  it('no reason belongs to two statuses, so a reason names its status', () => {
    expect(new Set(ALL_STATUS_REASONS).size).toBe(ALL_STATUS_REASONS.length)
  })

  it('fails on a list that differs from its constraint (seen red)', () => {
    const planted = "CONSTRAINT run_requests_status_check CHECK (status IN ('queued', 'claimed'))"
    expect(sorted(constraintValues(planted, 'run_requests_status_check'))).not.toEqual(sorted(RUN_REQUEST_STATUSES))
    expect(() => constraintValues(planted, 'no_such_check')).toThrow(/no constraint no_such_check/)
  })
})
