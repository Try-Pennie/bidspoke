/**
 * Child runs and inherited steps, when either end of the pair is archived
 * (#874, Phase A6 items 3 and 4).
 *
 * Two ways a run's history goes missing once the archive is in play, and both
 * of them are a WRONG STATEMENT rather than a gap:
 *
 *  - A replay or resume created days after its parent lands on a later archive
 *    day than the parent, so the parent's own narrow window never finds it and
 *    the parent renders as though nothing was ever re-run from it.
 *  - A live child that resumed from a parent which has since aged into the
 *    archive renders with its upstream steps absent, which reads as "those
 *    steps never ran".
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  findArchivedStep,
  readArchivedChildren,
  readArchivedParentSteps,
  type ArchiveReadDeps,
} from '../archive-read'
import { RETENTION_DAYS } from '../../archive/candidate-days'
import type { Env } from '../../index'
import type { SnowflakeStatementResponse } from '../snowflake'
import { encodeBundle } from '../../archive/bundle'

const PARENT_ID = '01a05cd7-2a00-7000-8000-000000000001'
const PARENT_DAY = '2026-09-01'
const ORG = '00000000-0000-4000-8000-00000000000a'
const READER = '00000000-0000-4000-8000-00000000000c'

const env = {
  ARCHIVE_READER_USER: 'reader',
  ARCHIVE_READER_PRIVATE_KEY: 'key',
  SNOWFLAKE_ACCOUNT: 'acct',
  SNOWFLAKE_WAREHOUSE: 'wh',
} as unknown as Env
const supabase = {} as unknown as SupabaseClient

function makeDeps(rows: unknown[][]): {
  deps: ArchiveReadDeps
  statements: Array<{ sql: string; bindings: unknown[] }>
} {
  const statements: Array<{ sql: string; bindings: unknown[] }> = []
  return {
    statements,
    deps: {
      execute: async (_c, sql, bindings) => {
        statements.push({ sql, bindings: bindings ?? [] })
        return { data: rows } as SnowflakeStatementResponse
      },
      sleep: () => new Promise<void>(() => {}),
      writeAudit: async () => {},
    },
  }
}

describe('readArchivedChildren', () => {
  it('returns the replay and resume runs created from this execution', async () => {
    const { deps } = makeDeps([
      ['child-1', '2026-09-02T10:00:00', 'completed', 'bid_won', 'replay'],
      ['child-2', '2026-09-03T11:00:00', 'failed', null, 'resume'],
    ])

    const result = await readArchivedChildren(
      env, { parentExecutionId: PARENT_ID, parentDay: PARENT_DAY, orgId: ORG }, deps
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.children).toHaveLength(2)
    expect(result.children[0]).toMatchObject({ id: 'child-1', status: 'completed', source: 'replay' })
    // A null column stays null rather than becoming the string "null", which
    // would render as a real outcome on the page.
    expect(result.children[1].outcome).toBeNull()
  })

  it('reports nothing for a cell that is not text, rather than "[object Object]"', async () => {
    // The SQL API's rows are typed unknown[][], and String() on an object
    // yields the literal "[object Object]", which then renders on the page as
    // though somebody had chosen it as a value.
    const { deps } = makeDeps([['child-1', { nested: true }, 'completed', null, 'replay']])

    const result = await readArchivedChildren(
      env, { parentExecutionId: PARENT_ID, parentDay: PARENT_DAY, orgId: ORG }, deps
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.children[0].started_at).toBeNull()
    expect(JSON.stringify(result.children[0])).not.toContain('object Object')
  })

  it('searches past the parent’s own day, out to the retention window', async () => {
    const { deps, statements } = makeDeps([])

    await readArchivedChildren(
      env, { parentExecutionId: PARENT_ID, parentDay: PARENT_DAY, orgId: ORG }, deps
    )

    // Derived from the shared retention constant, not written as a literal, so
    // changing retention moves the window with it.
    const lastDay = new Date(
      Date.parse(`${PARENT_DAY}T00:00:00.000Z`) + (RETENTION_DAYS + 1) * 86_400_000
    ).toISOString().slice(0, 10)

    expect(statements[0].bindings).toEqual([PARENT_ID, PARENT_DAY, lastDay, ORG])
    expect(lastDay > PARENT_DAY).toBe(true)
  })

  it('scopes to the caller’s organization in the query itself', async () => {
    const { deps, statements } = makeDeps([])
    await readArchivedChildren(
      env, { parentExecutionId: PARENT_ID, parentDay: PARENT_DAY, orgId: ORG }, deps
    )
    expect(statements[0].sql).toContain('organization_id = ?')
    expect(statements[0].bindings).toContain(ORG)
  })

  it('reports unavailable rather than an empty list when the archive fails', async () => {
    const deps: ArchiveReadDeps = {
      execute: async () => { throw new Error('warehouse suspended') },
      sleep: () => new Promise<void>(() => {}),
      writeAudit: async () => {},
    }

    const result = await readArchivedChildren(
      env, { parentExecutionId: PARENT_ID, parentDay: PARENT_DAY, orgId: ORG }, deps
    )

    // An empty list would say "nothing was ever re-run from this", which is a
    // claim the read never established (L98).
    expect(result.kind).toBe('unavailable')
  })
})

describe('readArchivedParentSteps', () => {
  async function parentBundle(steps: unknown[]) {
    const encoded = await encodeBundle({ execution: { id: PARENT_ID }, steps })
    return [[ORG, PARENT_DAY, 'false', encoded.wire]]
  }

  it('returns only the parent’s completed steps, marked as inherited', async () => {
    const { deps } = makeDeps(
      await parentBundle([
        { id: 's1', step_namespace: 'validate', status: 'completed', step_order: 1 },
        { id: 's2', step_namespace: 'credit_pull', status: 'failed', step_order: 2 },
      ])
    )

    const result = await readArchivedParentSteps(
      env, supabase, { parentExecutionId: PARENT_ID, orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    // The failed step is the one the resume re-ran, so the child has its own
    // row for it and inheriting the parent's would show it twice.
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).toMatchObject({
      step_namespace: 'validate',
      inherited_from_execution_id: PARENT_ID,
    })
  })

  it('reports unavailable, not an empty step list, when the parent cannot be read', async () => {
    const deps: ArchiveReadDeps = {
      execute: async () => { throw new Error('warehouse suspended') },
      sleep: () => new Promise<void>(() => {}),
      writeAudit: async () => {},
    }

    const result = await readArchivedParentSteps(
      env, supabase, { parentExecutionId: PARENT_ID, orgId: ORG, readBy: READER }, deps
    )

    // Answering with no steps would render the resumed run as though its
    // upstream work never happened.
    expect(result.kind).toBe('unavailable')
  })

  it('reports not-found when the archive genuinely has no such parent', async () => {
    const { deps } = makeDeps([])

    const result = await readArchivedParentSteps(
      env, supabase, { parentExecutionId: PARENT_ID, orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('not-found')
  })

  it('does not hand over another organization’s parent', async () => {
    const encoded = await encodeBundle({
      execution: { id: PARENT_ID },
      steps: [{ id: 's1', status: 'completed', step_namespace: 'validate' }],
    })
    const { deps } = makeDeps([['some-other-org', PARENT_DAY, 'false', encoded.wire]])

    const result = await readArchivedParentSteps(
      env, supabase, { parentExecutionId: PARENT_ID, orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('not-found')
  })
})

describe('findArchivedStep', () => {
  const CHILD_ID = '01a05cd7-2a00-7000-8000-0000000000c1'

  /**
   * Answers each execution_id with its own bundle, so the two-bundle walk is
   * exercised for real rather than simulated: the double does not know which
   * lookup is "the parent", it only answers what it is asked for.
   */
  function bundleDouble(bundles: Record<string, { execution: unknown; steps: unknown[] }>) {
    const asked: string[] = []
    const deps: ArchiveReadDeps = {
      execute: async (_c, _sql, bindings) => {
        const id = String((bindings ?? []).at(-1))
        asked.push(id)
        const bundle = bundles[id]
        if (!bundle) return { data: [] } as SnowflakeStatementResponse
        const encoded = await encodeBundle(bundle)
        return { data: [[ORG, PARENT_DAY, 'false', encoded.wire]] } as SnowflakeStatementResponse
      },
      sleep: () => new Promise<void>(() => {}),
      writeAudit: async () => {},
    }
    return { deps, asked }
  }

  it('returns a step that lives on the execution named in the path', async () => {
    const { deps } = bundleDouble({
      [CHILD_ID]: {
        execution: { id: CHILD_ID },
        steps: [{ id: 'step-a', step_namespace: 'validate', output: { ok: true } }],
      },
    })

    const result = await findArchivedStep(
      env, supabase, { executionId: CHILD_ID, stepId: 'step-a', orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('found')
    if (result.kind !== 'found') return
    expect(result.step).toMatchObject({ step_namespace: 'validate' })
  })

  it('follows the resume link to find a step that lives on the parent', async () => {
    const { deps, asked } = bundleDouble({
      [CHILD_ID]: {
        execution: { id: CHILD_ID, resumed_from_execution_id: PARENT_ID },
        steps: [{ id: 'step-own', step_namespace: 'credit_pull' }],
      },
      [PARENT_ID]: {
        execution: { id: PARENT_ID },
        steps: [{ id: 'step-inherited', step_namespace: 'validate', output: { ok: true } }],
      },
    })

    const result = await findArchivedStep(
      env, supabase,
      { executionId: CHILD_ID, stepId: 'step-inherited', orgId: ORG, readBy: READER },
      deps
    )

    expect(result.kind).toBe('found')
    if (result.kind !== 'found') return
    expect(result.step).toMatchObject({
      step_namespace: 'validate',
      inherited_from_execution_id: PARENT_ID,
    })
    expect(asked).toEqual([CHILD_ID, PARENT_ID])
  })

  it('never returns the execution_id the route does not expose', async () => {
    const { deps } = bundleDouble({
      [CHILD_ID]: {
        execution: { id: CHILD_ID },
        steps: [{ id: 'step-a', step_namespace: 'validate', execution_id: CHILD_ID }],
      },
    })

    const result = await findArchivedStep(
      env, supabase, { executionId: CHILD_ID, stepId: 'step-a', orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('found')
    if (result.kind !== 'found') return
    expect(result.step).not.toHaveProperty('execution_id')
  })

  it('answers not-found for a step that is on neither bundle', async () => {
    const { deps } = bundleDouble({
      [CHILD_ID]: {
        execution: { id: CHILD_ID, resumed_from_execution_id: PARENT_ID },
        steps: [{ id: 'step-own' }],
      },
      [PARENT_ID]: { execution: { id: PARENT_ID }, steps: [{ id: 'step-other' }] },
    })

    const result = await findArchivedStep(
      env, supabase, { executionId: CHILD_ID, stepId: 'nope', orgId: ORG, readBy: READER }, deps
    )

    expect(result.kind).toBe('not-found')
  })

  it('does not walk to a parent when the run resumed from nothing', async () => {
    const { deps, asked } = bundleDouble({
      [CHILD_ID]: { execution: { id: CHILD_ID }, steps: [{ id: 'step-own' }] },
    })

    await findArchivedStep(
      env, supabase, { executionId: CHILD_ID, stepId: 'nope', orgId: ORG, readBy: READER }, deps
    )

    expect(asked).toEqual([CHILD_ID])
  })

  it('says the parent could not be reached rather than that the step does not exist', async () => {
    let call = 0
    const deps: ArchiveReadDeps = {
      execute: async (_c, _sql, bindings) => {
        call += 1
        if (call === 1) {
          const encoded = await encodeBundle({
            execution: { id: CHILD_ID, resumed_from_execution_id: PARENT_ID },
            steps: [{ id: 'step-own' }],
          })
          return { data: [[ORG, PARENT_DAY, 'false', encoded.wire]] } as SnowflakeStatementResponse
        }
        void bindings
        throw new Error('warehouse suspended')
      },
      sleep: () => new Promise<void>(() => {}),
      writeAudit: async () => {},
    }

    const result = await findArchivedStep(
      env, supabase,
      { executionId: CHILD_ID, stepId: 'step-inherited', orgId: ORG, readBy: READER },
      deps
    )

    // The page has already drawn this step as completed. Telling the reader it
    // does not exist would contradict what is on their screen.
    expect(result.kind).toBe('unavailable')
  })
})
