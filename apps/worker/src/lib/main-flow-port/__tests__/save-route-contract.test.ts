/**
 * The port's saves, sent through the real save route (#2174).
 *
 * On 2026-10-26 the `canary_send_salesforce` apply was refused 428
 * `reload_required` in Dan's tab and saved nothing: since #2599 a save of a
 * definition must name the version it was made from (`expected_version`, the
 * workflows.version column) and its press (`save_id`, a UUID), and the port sent
 * neither, while every test answered its PUT from a fake that took any body.
 * Here the port's own HTTP client talks to the worker's `/api` app
 * (save-route-backend.ts), so a body the route refuses fails these.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../jwt')
vi.mock('../../supabase')
vi.mock('../../../engine/definition-loader')
vi.mock('../../audit')
vi.mock('../../github')
vi.mock('../../github-backup-alert')
vi.mock('../../buyer-profile-loader', async () => {
  const actual = await vi.importActual<typeof import('../../buyer-profile-loader')>('../../buyer-profile-loader')
  return { ...actual, loadBuyerProfiles: vi.fn() }
})

// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import GATE_MAIN_FLOW_RAW from '../../../../money-gate/fixtures/definitions/60e2e0bc-5aa2-47db-b333-3a8fe1c62e09.json?raw'
import { applyPort, httpWorkflowApi, rollbackPort } from '../apply'
import { PORT_STAGES, portMainFlow, type Definition } from '../transform'
import { prepare, saveRouteBackend, WORKER_URL } from './save-route-backend'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/**
 * The next stage still to apply. canary_send_salesforce went live on 2026-10-26
 * (version 175, #2174), so the route contract is held on the stage after it,
 * over the same live definition; every stage sends the same save.
 */
const stage = 'outcome_posts' as const
/** Main Flow as the money gate holds it: the live version 175, the canary applied. */
const live = (): Definition => structuredClone((JSON.parse(GATE_MAIN_FLOW_RAW as string) as { definition: Definition }).definition)

let backend: ReturnType<typeof saveRouteBackend>
const client = () => httpWorkflowApi(WORKER_URL, 'session-jwt', backend.fetchFn)
const puts = () => backend.requests.filter((r) => r.method === 'PUT')

beforeEach(() => {
  prepare()
  backend = saveRouteBackend(live(), { versionNumber: 175 })
})

afterEach(async () => {
  await backend.settle()
})

describe('the apply, through PUT /api/workflows/:id', () => {
  it('is accepted, naming the version it re-read just before the PUT and a fresh press, and stores the transform', async () => {
    const result = await applyPort(client(), stage)
    expect(result).toMatchObject({ outcome: 'applied', before: { version_id: 'ver-175', version_number: 175 }, after: { version_id: 'ver-176', version_number: 176 } })
    const [put] = puts()
    expect(Object.keys(put.body ?? {}).sort()).toEqual(['definition', 'expected_version', 'message', 'save_id'])
    // The workflows.version column the route compares, never the snapshot number.
    expect(put.body?.expected_version).toBe(2310)
    expect(put.body?.save_id).toMatch(UUID)
    expect(backend.writes).toEqual([expect.objectContaining({ p_op: 'save', p_expected_version: 2310, p_save_id: put.body?.save_id })])
    expect(backend.row.definition).toEqual(portMainFlow(live(), PORT_STAGES[stage]))
  })

  it('answers refused_live_changed, never a throw, when a save lands between its re-read and its PUT, and writes nothing', async () => {
    const other = live()
    other.nodes[0].label = 'saved on the canvas meanwhile'
    backend.saveElsewhereBeforeNextPut(other)
    const result = await applyPort(client(), stage)
    expect(result).toMatchObject({ outcome: 'refused_live_changed', read: { version_number: 175 } })
    expect((result as { reason: string }).reason).toMatch(/stale: the workflow's row version is 2311, not 2310, saved by Someone.*nothing was written/)
    // The route asked write_workflow, which refused; the canvas save stands.
    expect(backend.writes).toEqual([expect.objectContaining({ p_expected_version: 2310 })])
    expect(backend.row.definition).toEqual(other)
  })
})

describe('every stage still to apply, over live Main Flow, through PUT /api/workflows/:id', () => {
  // The route's checks of a LIVE workflow's definition (lead validation, unfinished
  // steps, connections) run on each, so a stage the route would refuse fails here.
  it.each(['outcome_posts', 'inquiry', 'collections'] as const)('%s is accepted and stored as built', async (s) => {
    const result = await applyPort(client(), s)
    expect(result).toMatchObject({ outcome: 'applied' })
    expect(backend.row.definition).toEqual(portMainFlow(live(), PORT_STAGES[s]))
  })

  it.each(['canary_invalid_state', 'canary_send_salesforce'] as const)('%s, already live, answers nothing_to_do and sends no save', async (s) => {
    const result = await applyPort(client(), s)
    expect(result).toMatchObject({ outcome: 'nothing_to_do', live_version: { version_number: 175 } })
    expect(puts()).toEqual([])
    expect(backend.writes).toEqual([])
    expect(backend.row.definition).toEqual(live())
  })
})

describe('the rollback, through PUT /api/workflows/:id', () => {
  it('is accepted, naming the version it re-read just before the PUT and a press of its own', async () => {
    const applied = await applyPort(client(), stage)
    if (applied.outcome !== 'applied') throw new Error(applied.outcome)
    const result = await rollbackPort(client(), { before: applied.before, after: applied.after })
    expect(result).toMatchObject({ outcome: 'rolled_back', restored_from: { version_number: 175 }, after: { version_number: 177 } })
    const [applyPut, rollbackPut] = puts()
    expect(rollbackPut.body?.expected_version).toBe(2311)
    expect(rollbackPut.body?.save_id).toMatch(UUID)
    expect(rollbackPut.body?.save_id).not.toBe(applyPut.body?.save_id)
    expect(backend.row.definition).toEqual(live())
  })

  it('answers refused_live_changed, never a throw, when a save lands between its re-read and its PUT', async () => {
    const applied = await applyPort(client(), stage)
    if (applied.outcome !== 'applied') throw new Error(applied.outcome)
    const other = portMainFlow(live(), PORT_STAGES[stage])
    other.nodes[0].label = 'saved on the canvas meanwhile'
    backend.saveElsewhereBeforeNextPut(other)
    const result = await rollbackPort(client(), { before: applied.before, after: applied.after })
    expect(result).toMatchObject({ outcome: 'refused_live_changed' })
    expect((result as { reason: string }).reason).toMatch(/stale: the workflow's row version is 2312, not 2311, saved by Someone.*nothing was written/)
    expect(backend.row.definition).toEqual(other)
  })
})
