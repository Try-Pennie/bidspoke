import { describe, expect, it } from 'vitest'
import { INVENTORY_COLUMNS, planLoad, type StoredRow } from '../plan-load.ts'
import { readExport } from '../read-export.ts'
import { registryStep, workflowFile, writeExport } from './fixture.ts'

const ORG = '11111111-1111-4111-8111-111111111111'
const SEPT = '2026-09-30T19:26:13Z'
const OCT = '2026-10-20T12:00:00Z'

const stored = (over: Partial<StoredRow> & { pipedream_hashid: string }): StoredRow => ({
  organization_id: ORG,
  project_hashid: 'proj_A',
  name: 'Old name',
  pipedream_state: 'on',
  definition_sha256: 'a'.repeat(64),
  trigger_types: ['http'],
  step_count: 0,
  deployment_count: 0,
  first_seen_export_at: SEPT,
  last_seen_export_at: SEPT,
  absent_since_export_at: null,
  ...over,
})

describe('planLoad (#1710)', () => {
  it('writes one row per workflow with its state from the export, never porting_stage', () => {
    const projects = readExport(writeExport([{
      projectHashid: 'proj_A',
      workflows: [
        { hashid: 'p_on', file: workflowFile('p_on', { steps: [registryStep('a', 'http-custom-request')], deployments: { d1: { steps: [registryStep('b', 'end-end-workflow')] } } }) },
        { hashid: 'p_off', file: workflowFile('p_off', { inactive: true, triggers: [{ type: 'timer' }, { type: 'http' }, { type: 'http', disabled: true }] }) },
        { hashid: 'p_never', status: 'skipped_never_deployed' },
      ],
    }]))
    const plan = planLoad([], projects, ORG)
    expect(plan.rows.map((r) => [r.pipedream_hashid, r.pipedream_state])).toEqual([['p_never', 'never_deployed'], ['p_off', 'off'], ['p_on', 'on']])
    const on = plan.rows.find((r) => r.pipedream_hashid === 'p_on')!
    expect(on).toMatchObject({ organization_id: ORG, project_hashid: 'proj_A', step_count: 2, deployment_count: 1, trigger_types: ['http'], first_seen_export_at: SEPT, last_seen_export_at: SEPT, absent_since_export_at: null })
    expect(on.definition_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(plan.rows.find((r) => r.pipedream_hashid === 'p_off')!.trigger_types).toEqual(['http', 'timer'])
    expect(plan.rows.find((r) => r.pipedream_hashid === 'p_never')!.definition_sha256).toBeNull()
    expect(plan.inserted).toEqual(['p_never', 'p_off', 'p_on'])
    for (const r of plan.rows) {
      expect(Object.keys(r).sort()).toEqual([...INVENTORY_COLUMNS].sort())
      expect('porting_stage' in r).toBe(false)
    }
  })

  it('keeps first seen, moves last seen, and reports a state change', () => {
    const projects = readExport(writeExport([{ projectHashid: 'proj_A', exportedAt: OCT, workflows: [{ hashid: 'p_one', file: workflowFile('p_one', { inactive: true }) }] }]))
    const plan = planLoad([stored({ pipedream_hashid: 'p_one' })], projects, ORG)
    expect(plan.rows[0]).toMatchObject({ first_seen_export_at: SEPT, last_seen_export_at: OCT, pipedream_state: 'off' })
    expect(plan.stateChanged).toEqual([{ hashid: 'p_one', from: 'on', to: 'off' }])
    expect(plan.inserted).toEqual([])
  })

  it('marks a workflow a newer export of its project no longer lists, and keeps everything else about it', () => {
    const projects = readExport(writeExport([{ projectHashid: 'proj_A', exportedAt: OCT, workflows: [{ hashid: 'p_kept' }] }]))
    const gone = stored({ pipedream_hashid: 'p_gone', name: 'Gone', step_count: 7 })
    const plan = planLoad([stored({ pipedream_hashid: 'p_kept' }), gone], projects, ORG)
    expect(plan.newlyAbsent).toEqual(['p_gone'])
    expect(plan.rows.find((r) => r.pipedream_hashid === 'p_gone')).toEqual({ ...gone, absent_since_export_at: OCT })
  })

  it('judges absence only inside the projects this export holds', () => {
    const projects = readExport(writeExport([{ projectHashid: 'proj_A', exportedAt: OCT, workflows: [{ hashid: 'p_kept' }] }]))
    const plan = planLoad([stored({ pipedream_hashid: 'p_other', project_hashid: 'proj_B' })], projects, ORG)
    expect(plan.newlyAbsent).toEqual([])
    expect(plan.rows.map((r) => r.pipedream_hashid)).toEqual(['p_kept'])
  })

  it('does not mark absent a workflow that moved to another project in the same export', () => {
    const projects = readExport(writeExport([
      { projectHashid: 'proj_A', exportedAt: OCT, workflows: [] },
      { projectHashid: 'proj_B', exportedAt: OCT, workflows: [{ hashid: 'p_moved' }] },
    ]))
    const plan = planLoad([stored({ pipedream_hashid: 'p_moved', project_hashid: 'proj_A' })], projects, ORG)
    expect(plan.newlyAbsent).toEqual([])
    expect(plan.rows[0]).toMatchObject({ project_hashid: 'proj_B', absent_since_export_at: null })
  })

  it('clears absence when a workflow reappears, and says so', () => {
    const projects = readExport(writeExport([{ projectHashid: 'proj_A', exportedAt: OCT, workflows: [{ hashid: 'p_back' }] }]))
    const plan = planLoad([stored({ pipedream_hashid: 'p_back', absent_since_export_at: '2026-10-10T00:00:00Z' })], projects, ORG)
    expect(plan.reappeared).toEqual(['p_back'])
    expect(plan.rows[0].absent_since_export_at).toBeNull()
  })

  it('leaves an already absent workflow at the export that first missed it', () => {
    const projects = readExport(writeExport([{ projectHashid: 'proj_A', exportedAt: OCT, workflows: [] }]))
    const plan = planLoad([stored({ pipedream_hashid: 'p_gone', absent_since_export_at: '2026-10-10T00:00:00Z' })], projects, ORG)
    expect(plan.newlyAbsent).toEqual([])
    expect(plan.rows).toEqual([])
  })

  it('refuses an export older than what is stored for its project, which would turn back the clock', () => {
    const projects = readExport(writeExport([{ projectHashid: 'proj_A', exportedAt: SEPT, workflows: [{ hashid: 'p_one' }] }]))
    expect(() => planLoad([stored({ pipedream_hashid: 'p_one', last_seen_export_at: OCT })], projects, ORG)).toThrow(/proj_A.*older/)
  })

  it('reloading the same export changes nothing it reports', () => {
    const projects = readExport(writeExport([{ projectHashid: 'proj_A', workflows: [{ hashid: 'p_one' }] }]))
    const first = planLoad([], projects, ORG)
    const second = planLoad(first.rows.map((r) => ({ ...r })), projects, ORG)
    expect(second).toMatchObject({ inserted: [], newlyAbsent: [], reappeared: [], stateChanged: [] })
    expect(second.rows).toEqual(first.rows)
  })

  it('refuses a stored row of another organization rather than writing over it', () => {
    const projects = readExport(writeExport([{ projectHashid: 'proj_A', workflows: [{ hashid: 'p_one' }] }]))
    expect(() => planLoad([stored({ pipedream_hashid: 'p_one', organization_id: '22222222-2222-4222-8222-222222222222' })], projects, ORG)).toThrow(/p_one.*organization/)
  })
})
