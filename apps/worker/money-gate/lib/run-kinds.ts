/**
 * The kinds of run the money gate replays a lead as (#1730).
 *
 *   live            a lead arriving at the bidding Worker: the trigger alone, as
 *                   the replay has always run it.
 *   test            the canvas Test Runner, POST /api/workflows/:id/test. Live in
 *                   everything it sends: it makes its real outbound calls into the
 *                   money namespace (Dan, 2026-10-02, on #1708).
 *   shadow_dry_run  the shadow mirror, POST /shadow/:workflow_id: every outbound
 *                   submission is stubbed. #1708 part B moves these to a compare
 *                   namespace with deny mode egress.
 *
 * Each kind's options are what its route hands executeWorkflow, field for field;
 * lib/__tests__/run-kinds.test.ts drives both routes and holds these to them. The
 * engine decides what a kind means from those options alone (engine/run-reality.ts),
 * so the gate passes them and reaches past nothing.
 */

export const RUN_KINDS = ['live', 'test', 'shadow_dry_run'] as const
export type RunKind = (typeof RUN_KINDS)[number]

/** The kinds a variant opts into on top of its live run. */
export type ExtraRunKind = Exclude<RunKind, 'live'>
export const EXTRA_RUN_KINDS: readonly ExtraRunKind[] = ['test', 'shadow_dry_run']

/** How the coverage report and fixture ids name a kind. */
export const RUN_KIND_LABEL: Record<RunKind, string> = { live: 'live', test: 'test run', shadow_dry_run: 'shadow dry_run' }

/** The trigger, as the live replay builds it. */
export interface RunStart { workflowId: string; payload: unknown; source: string }

/** What a test run carries that only the Test Runner supplies. */
export interface TestRunExtras {
  /** The id the canvas mints in the browser before the run, a UUIDv7. */
  executionId?: string
  /** The test code bundle deployTestCodeBundle returned; null when none was deployed. */
  codeBundleName?: string | null
  /** The canvas's current definition, sent with every Test Runner run. */
  definitionOverride?: unknown
}

export interface RunOptions {
  workflowId: string
  payload: unknown
  source: string
  isTest?: boolean
  shadowMode?: 'dry_run'
  enforceSourceAssignment?: boolean
  executionId?: string
  codeBundleName?: string
  definitionOverride?: unknown
}

export function runOptions(kind: RunKind, start: RunStart, extras: TestRunExtras = {}): RunOptions {
  const { workflowId, payload, source } = start
  switch (kind) {
    case 'live':
      return { workflowId, payload, source }
    case 'test':
      // routes/api/workflows.ts, POST /:id/test: the source is always test_runner.
      return {
        workflowId,
        payload,
        source: 'test_runner',
        isTest: true,
        executionId: extras.executionId,
        ...(extras.codeBundleName ? { codeBundleName: extras.codeBundleName } : {}),
        ...(extras.definitionOverride ? { definitionOverride: extras.definitionOverride } : {}),
      }
    case 'shadow_dry_run':
      // routes/shadow.ts: the caller's source with a __shadow suffix, marked a test.
      return { workflowId, payload, source: `${source}__shadow`, isTest: true, shadowMode: 'dry_run', enforceSourceAssignment: false }
    default: {
      const never: never = kind
      throw new Error(`money gate: no options for run kind ${String(never)}`)
    }
  }
}

/** A live fixture keeps the id it always had; every other kind names itself. */
export function fixtureId(workflowName: string, variantName: string, kind: RunKind): string {
  const id = `${workflowName}/${variantName}`
  return kind === 'live' ? id : `${id} as ${RUN_KIND_LABEL[kind]}`
}
