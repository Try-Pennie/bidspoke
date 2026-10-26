/**
 * The real workflow routes, served to the port's HTTP client (#2174).
 *
 * The tab script's PUT was refused 428 `reload_required` in Dan's tab on
 * 2026-10-26: the save route had started requiring `expected_version` and
 * `save_id` (#2599), and every test of the port answered its PUT from a fake
 * that took any body. So this hands the port's requests to the worker's own
 * `/api` app (jwt auth, the GET routes and `PUT /api/workflows/:id` with every
 * check it makes of a live workflow's definition), and only the database under
 * it is a stand in: one Main Flow row and its version history, kept here, with
 * `write_workflow` answered as the database function answers it, refusing a
 * save made from a version that is no longer stored (BP409 stale_version).
 *
 * A test file using it mocks what workflows.test.ts mocks (jwt, supabase,
 * definition-loader, audit, github, github-backup-alert, buyer-profile-loader),
 * since vi.mock only applies to the file that declares it, and calls `prepare`
 * in a beforeEach.
 */
import { vi } from 'vitest'
import api from '../../../routes/api/index'
import { makeSupabase } from '../../../routes/api/__tests__/_supabase-mock'
import { createSupabaseClient } from '../../supabase'
import { verifyJwt } from '../../jwt'
import { refreshWorkflowCaches } from '../../../engine/definition-loader'
import { writeAuditLog } from '../../audit'
import { pushWorkflowToGitHub } from '../../github'
import { recordBackupFailure, recordBackupSuccess } from '../../github-backup-alert'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'
import { MAIN_FLOW_WORKFLOW_ID } from '../transform'

export const WORKER_URL = 'https://worker.example.test'
const ORG = 'org-pennie'
const USER = { id: 'user-dan', organization_id: ORG, email: 'dan@example.com' }

/** The env the routes read; no Cloudflare account, so a save deploys no code node bundle. */
const env = {
  SUPABASE_JWKS_URL: 'https://jwks.example.test',
  WORKFLOW_CACHE: { delete: async () => undefined, get: async () => null, put: async () => undefined },
  IDEMPOTENCY: {},
  APP_URL: 'https://app.example.test',
} as unknown as Env

/** One call of write_workflow, as the route sends it. */
interface WriteArgs {
  p_op: string
  p_expected_version: number | null
  p_fields: Record<string, unknown>
  p_save_id: string | null
  p_actor_name: string
}

export interface SentRequest { method: string; path: string; auth: string | undefined; body?: Record<string, unknown> }

export function prepare() {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue({ sub: USER.id, email: USER.email, exp: 9999999999, iat: 1, aud: 'authenticated' })
  vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
  vi.mocked(writeAuditLog).mockResolvedValue(undefined)
  vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
  vi.mocked(recordBackupSuccess).mockResolvedValue(undefined)
  vi.mocked(recordBackupFailure).mockResolvedValue(false)
}

/**
 * Main Flow as production holds it: live, at row version `rowVersion` (the
 * workflows.version column write_workflow compares) with newest snapshot
 * `versionNumber`. The two differ in production, so a save naming the wrong one
 * is refused here as it would be there.
 */
export function saveRouteBackend(definition: unknown, opts: { rowVersion?: number; versionNumber?: number } = {}) {
  let clock = 0
  const stamp = () => `2026-10-26T15:00:${String(clock++).padStart(2, '0')}Z`
  const row = {
    id: MAIN_FLOW_WORKFLOW_ID,
    organization_id: ORG,
    name: 'Main Flow',
    description: null,
    definition: structuredClone(definition) as unknown,
    is_active: true,
    lane: 'money',
    slack_channel: null,
    folder_id: null,
    deleted_at: null,
    definition_schema_version: null,
    last_save_id: null as string | null,
    updated_by_name: 'Dan',
    version: opts.rowVersion ?? 2310,
    updated_at: stamp(),
  }
  const firstNumber = opts.versionNumber ?? 174
  const versions = [{ id: `ver-${firstNumber}`, workflow_id: MAIN_FLOW_WORKFLOW_ID, version_number: firstNumber, definition: structuredClone(definition) as unknown, created_at: row.updated_at, message: null as string | null }]
  const writes: WriteArgs[] = []
  const requests: SentRequest[] = []
  const ctx = recordingContext()
  /** Runs once, as the next PUT reaches the route: a save landing between the port's re-read and its PUT. */
  let beforeNextPut: (() => void) | null = null

  /** A save made elsewhere (the canvas), moving both versions as write_workflow does. */
  function saveElsewhere(next: unknown, by = 'Someone') {
    row.definition = structuredClone(next)
    row.version += 1
    row.updated_at = stamp()
    row.updated_by_name = by
    versions.push({ id: `ver-${versions.at(-1)!.version_number + 1}`, workflow_id: MAIN_FLOW_WORKFLOW_ID, version_number: versions.at(-1)!.version_number + 1, definition: structuredClone(next), created_at: row.updated_at, message: null })
  }

  /** write_workflow's save, as the function decides it (migration 20261023120000). */
  function writeWorkflow(args: WriteArgs): { data: unknown; error: unknown } {
    writes.push(args)
    if (args.p_op !== 'save') return { data: null, error: { code: 'BP422', message: `unexpected op ${args.p_op}` } }
    if (args.p_expected_version === null) return { data: null, error: { code: 'BP422', message: 'expected_version_required' } }
    if (args.p_expected_version !== row.version) {
      const details = JSON.stringify({ current: { ...row }, last_save_id: row.last_save_id, changed_by_name: row.updated_by_name, changed_at: row.updated_at })
      return { data: null, error: { code: 'BP409', message: 'stale_version', details } }
    }
    const before = structuredClone(row)
    saveElsewhere(Object.hasOwn(args.p_fields, 'definition') ? args.p_fields.definition : before.definition, args.p_actor_name)
    if (typeof args.p_fields.message === 'string') versions.at(-1)!.message = args.p_fields.message
    row.last_save_id = args.p_save_id
    const made = versions.at(-1)!
    return { data: { workflow: { ...row }, version_id: made.id, version_number: made.version_number }, error: null }
  }

  /** The database as it stands for this one request. */
  function databaseFor(path: string) {
    const one = /\/versions\/([^/]+)$/.exec(path)?.[1]
    const newestFirst = [...versions].reverse()
    return makeSupabase(
      {
        users: { single: USER },
        workflows: { single: { ...row } },
        workflow_versions: one
          ? { single: versions.find((v) => v.id === one) ?? null }
          : { list: newestFirst.map(({ id, version_number, created_at, message }) => ({ id, version_number, commit_sha: null, created_by: USER.id, created_at, message })) },
      },
      {
        rpc: async (name, args) => {
          if (name === 'write_workflow') return writeWorkflow(args as WriteArgs)
          if (name === 'definition_connection_problems') return { data: [], error: null }
          return { data: null, error: { message: `rpc ${name} is not served by this backend` } }
        },
      },
    )
  }

  /** The fetch the port's HTTP client is given: every call goes to the worker's own /api app. */
  const fetchFn = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    if (!url.startsWith(`${WORKER_URL}/api/`)) throw new Error(`the port called ${url}, outside the worker's /api`)
    const method = init.method ?? 'GET'
    const path = url.slice(`${WORKER_URL}/api`.length)
    requests.push({ method, path, auth: init.headers?.Authorization, ...(init.body ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) })
    if (method === 'PUT' && beforeNextPut) {
      const run = beforeNextPut
      beforeNextPut = null
      run()
    }
    vi.mocked(createSupabaseClient).mockReturnValue(databaseFor(path) as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await api.request(path, { method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) }, env, ctx)
    return res
  }

  return {
    fetchFn,
    row,
    versions,
    writes,
    requests,
    saveElsewhere,
    /** Lands a save made elsewhere just as the next PUT arrives, after every read the port makes before it. */
    saveElsewhereBeforeNextPut(next: unknown) {
      beforeNextPut = () => saveElsewhere(next)
    },
    settle: () => ctx.settle(),
  }
}
