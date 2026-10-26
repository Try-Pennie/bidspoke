/**
 * Applies a Main Flow port stage to the live workflow, and rolls one back
 * (#2171, #1680 plan points 11 and 12).
 *
 * `PUT /api/workflows/:id` overwrites the whole definition. Since #1947 and
 * #2599 it requires a save of a definition to name the version it was made from
 * (`expected_version`, the workflows.version column) and its press (`save_id`, a
 * UUID), answering 428 `reload_required` to a save naming neither and 409
 * `stale_version` to one whose version is no longer stored. So the apply:
 *
 *  1. reads the live definition, the row's version and its newest snapshot;
 *  2. runs the transform on THAT (a canvas edit to a part it rewrites makes the
 *     transform refuse, by name, and nothing is sent);
 *  3. re-reads all three immediately before the PUT and refuses when any moved;
 *  4. PUTs naming the row version of that re-read and a fresh save id, so a
 *     save landing after the re-read is refused by the route itself, which it
 *     answers as `refused_live_changed` like step 3;
 *  5. reads back: the stored definition must be the one sent and the newest
 *     version the one the PUT made, or it says what it found instead.
 *
 * It returns the versions before and after, which is the rollback record.
 * Rollback re-PUTs the version read before the change under the same check, and
 * refuses when the canvas has been saved since the port, because re-PUTting then
 * would discard that save too.
 *
 * It runs in Dan's logged in tab, built by scripts/main-flow-port-tab.ts, since
 * only a user of the production organization can PUT Main Flow. It imports only
 * transform.ts, which the builder bundles with it.
 */
import { MAIN_FLOW_WORKFLOW_ID, PORT_STAGES, portMainFlow, portStatus, sameJson, type Definition, type PortStage } from './transform'

export interface VersionRef { version_id: string; version_number: number }

/**
 * The body of one save, keyed exactly as `PUT /api/workflows/:id` reads it.
 * `expected_version` is the workflows.version column the save was made from
 * (never a snapshot's version_number); `save_id` is a UUID naming this one press.
 */
export interface SaveRequest { definition: unknown; message: string; expected_version: number; save_id: string }

export type SaveAnswer =
  | { kind: 'saved'; version_id?: string; deploy_errors?: Array<{ namespace: string; error: string }>; no_changes?: boolean }
  /** The route's 409 stale_version: the row moved past `expected_version`, and nothing was written. */
  | { kind: 'stale'; current_version: number | null; changed_by_name: string | null; changed_at: string | null }

export interface WorkflowApi {
  /** `version` is the workflows.version column a save names as its expected_version. */
  getWorkflow(id: string): Promise<{ definition: unknown; updated_at: string; version: number }>
  /** Newest first, as the route lists them. */
  listVersions(id: string): Promise<Array<{ id: string; version_number: number }>>
  getVersion(id: string, versionId: string): Promise<{ definition: unknown; version_number: number }>
  putDefinition(id: string, save: SaveRequest): Promise<SaveAnswer>
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>

interface ConflictBody { code?: unknown; current?: { version?: unknown } | null; changed_by_name?: unknown; changed_at?: unknown }

/** A 409's body, or null when it is not a JSON object, which is then thrown as any other non 2xx. */
function staleAnswerOf(text: string): ConflictBody | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * The workflow routes over HTTP, as the signed in user. Any non 2xx throws with
 * the route, the status and the answer, except the save route's 409
 * stale_version, which is an answer the apply reports by name.
 */
export function httpWorkflowApi(workerUrl: string, accessToken: string, fetchFn: FetchLike): WorkflowApi {
  const base = workerUrl.replace(/\/+$/, '')
  const send = async (method: string, path: string, body?: unknown): Promise<{ url: string; status: number; ok: boolean; text: string }> => {
    const url = `${base}${path}`
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetchFn(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    return { url, status: res.status, ok: res.ok, text: await res.text() }
  }
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const { url, status, ok, text } = await send(method, path, body)
    if (!ok) throw new Error(`${method} ${url} answered ${status}: ${text.slice(0, 300)}`)
    return JSON.parse(text) as unknown
  }
  return {
    getWorkflow: async (id) => (await call('GET', `/api/workflows/${id}`)) as { definition: unknown; updated_at: string; version: number },
    listVersions: async (id) => (await call('GET', `/api/workflows/${id}/versions`)) as Array<{ id: string; version_number: number }>,
    getVersion: async (id, versionId) => (await call('GET', `/api/workflows/${id}/versions/${versionId}`)) as { definition: unknown; version_number: number },
    putDefinition: async (id, save) => {
      const { url, status, ok, text } = await send('PUT', `/api/workflows/${id}`, save)
      if (status === 409) {
        const answer = staleAnswerOf(text)
        if (answer?.code === 'stale_version') {
          const current = answer.current?.version
          return {
            kind: 'stale',
            current_version: typeof current === 'number' ? current : null,
            changed_by_name: typeof answer.changed_by_name === 'string' ? answer.changed_by_name : null,
            changed_at: typeof answer.changed_at === 'string' ? answer.changed_at : null,
          }
        }
      }
      if (!ok) throw new Error(`PUT ${url} answered ${status}: ${text.slice(0, 300)}`)
      const saved = JSON.parse(text) as { version_id?: string; deploy_errors?: Array<{ namespace: string; error: string }>; no_changes?: boolean }
      return { kind: 'saved', version_id: saved.version_id, deploy_errors: saved.deploy_errors, no_changes: saved.no_changes }
    },
  }
}

/**
 * The signed in user's access token from the tab's cookies. The web app's
 * Supabase client (@supabase/ssr createBrowserClient) keeps the session in the
 * `sb-<project>-auth-token` cookie, split into `.0`, `.1` ... chunks when long,
 * each URI encoded, the whole either JSON or `base64-` and base64url JSON. Null
 * when no session is there. The token is used for the calls and never returned.
 */
export function accessTokenFromCookies(cookie: string): string | null {
  const jar = new Map<string, string>()
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    try {
      jar.set(part.slice(0, eq).trim(), decodeURIComponent(part.slice(eq + 1).trim()))
    } catch {
      // A cookie of some other app that is not URI encoded: not ours.
    }
  }
  const key = [...jar.keys()].map((k) => /^(sb-.+-auth-token)(?:\.\d+)?$/.exec(k)?.[1]).find((k): k is string => !!k)
  if (!key) return null
  let value = jar.get(key) ?? ''
  if (!value) {
    const chunks: string[] = []
    for (let i = 0; jar.has(`${key}.${i}`); i++) chunks.push(jar.get(`${key}.${i}`) as string)
    value = chunks.join('')
  }
  try {
    // Inside the try: a truncated chunk or bad base64 is no session, not a throw.
    if (value.startsWith('base64-')) {
      const b64 = value.slice('base64-'.length).replace(/-/g, '+').replace(/_/g, '/')
      const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))
      value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    }
    const session = JSON.parse(value) as { access_token?: unknown } | null
    return typeof session?.access_token === 'string' ? session.access_token : null
  } catch {
    return null
  }
}

/**
 * `row_version` is the workflows.version column, which a save names as its
 * expected_version; `version` is the newest snapshot, which the rollback
 * record names.
 */
interface LiveRead { definition: unknown; updated_at: string; row_version: number; version: VersionRef }

async function readLive(api: WorkflowApi): Promise<LiveRead> {
  const wf = await api.getWorkflow(MAIN_FLOW_WORKFLOW_ID)
  if (typeof wf.version !== 'number' || !Number.isInteger(wf.version) || wf.version < 0) {
    throw new Error(`the workflow read carries no version (it answered ${JSON.stringify(wf.version)}), so a save cannot name the version it was made from; nothing was sent`)
  }
  const [newest] = await api.listVersions(MAIN_FLOW_WORKFLOW_ID)
  if (!newest) throw new Error('Main Flow has no saved version to build on')
  return { definition: wf.definition, updated_at: wf.updated_at, row_version: wf.version, version: { version_id: newest.id, version_number: newest.version_number } }
}

/** Why `now` is not the state `read` saw, or null when nothing moved. */
function movedSince(read: LiveRead, now: LiveRead): string | null {
  if (now.version.version_id !== read.version.version_id) return `the newest version is now ${now.version.version_number}, not ${read.version.version_number}`
  if (now.row_version !== read.row_version) return `the workflow's row version is now ${now.row_version}, not ${read.row_version}`
  if (now.updated_at !== read.updated_at) return `the workflow was saved at ${now.updated_at}, after the read at ${read.updated_at}`
  if (!sameJson(now.definition, read.definition)) return 'the live definition differs from the one read'
  return null
}

export type ApplyResult =
  | { outcome: 'nothing_to_do'; stage: PortStage; live_version: VersionRef }
  | { outcome: 'refused_live_changed'; stage: PortStage; read: VersionRef; reason: string }
  | {
      outcome: 'applied' | 'applied_with_deploy_errors'
      stage: PortStage
      /** The version read before the change: what a rollback restores. */
      before: VersionRef
      /** The version this PUT made: with `before`, the rollback record. */
      after: VersionRef
      deploy_errors?: Array<{ namespace: string; error: string }>
      status: ReturnType<typeof portStatus>
    }
  | {
      outcome: 'stored_differs'
      stage: PortStage
      before: VersionRef
      /**
       * The version this PUT made, or null when the save's answer named no version
       * that is listed, so it cannot be told from a canvas save landing at the same
       * moment; then there is no rollback record to trust.
       */
      after: VersionRef | null
      /** What is live instead. */
      found: string
      status: ReturnType<typeof portStatus>
    }

/** The version the PUT's answer names, or null: never the newest one in its place, which may be a canvas save. */
const versionAfterPut = async (api: WorkflowApi, versionId: string | undefined): Promise<VersionRef | null> => {
  if (!versionId) return null
  const made = (await api.listVersions(MAIN_FLOW_WORKFLOW_ID)).find((v) => v.id === versionId)
  return made ? { version_id: made.id, version_number: made.version_number } : null
}

const unpinned = (versionId: string | undefined) =>
  versionId ? `the save answered version id ${versionId}, which the version list does not hold` : 'the save answered no version id'

/**
 * The save of `definition` made from `from`, the read made immediately before
 * the PUT: its row version, and a fresh press, so the route refuses it as stale
 * if anything was saved after that read.
 */
const saveFrom = (from: LiveRead, definition: unknown, message: string): SaveRequest => ({
  definition,
  message,
  expected_version: from.row_version,
  save_id: crypto.randomUUID(),
})

const staleReason = (answer: Extract<SaveAnswer, { kind: 'stale' }>, expected: number) =>
  `the save route refused it as stale: the workflow's row version is ${answer.current_version ?? 'unknown'}, not ${expected}, saved by ${answer.changed_by_name ?? 'someone'} at ${answer.changed_at ?? 'an unknown time'}; nothing was written`

export async function applyPort(api: WorkflowApi, stage: PortStage): Promise<ApplyResult> {
  const read = await readLive(api)
  const ported = portMainFlow(read.definition, PORT_STAGES[stage])
  if (sameJson(ported, read.definition)) return { outcome: 'nothing_to_do', stage, live_version: read.version }

  const now = await readLive(api)
  const moved = movedSince(read, now)
  if (moved) return { outcome: 'refused_live_changed', stage, read: read.version, reason: `${moved}; nothing was sent, run the apply again` }

  const save = saveFrom(now, ported, `#1680 relay port, stage ${stage}, built from version ${read.version.version_number}`)
  const put = await api.putDefinition(MAIN_FLOW_WORKFLOW_ID, save)
  if (put.kind === 'stale') return { outcome: 'refused_live_changed', stage, read: read.version, reason: `${staleReason(put, save.expected_version)}, run the apply again` }
  if (put.no_changes) throw new Error('the save route answered no_changes for a definition that differs from the live one')
  const after = await versionAfterPut(api, put.version_id)
  const stored = await readLive(api)
  const status = portStatus(stored.definition as Definition)
  const base = { stage, before: read.version, after, status }
  if (after === null) {
    return { ...base, outcome: 'stored_differs', found: `${unpinned(put.version_id)}, so the version it made is unknown; the newest is ${stored.version.version_number} and the live definition is ${sameJson(stored.definition, ported) ? '' : 'not '}the one sent` }
  }
  if (stored.version.version_id !== after.version_id || !sameJson(stored.definition, ported)) {
    return { ...base, outcome: 'stored_differs', found: `the newest version is ${stored.version.version_number}; the live definition is ${sameJson(stored.definition, ported) ? '' : 'not '}the one sent` }
  }
  if (put.deploy_errors && put.deploy_errors.length > 0) return { ...base, after, outcome: 'applied_with_deploy_errors', deploy_errors: put.deploy_errors }
  return { ...base, after, outcome: 'applied' }
}

export type RollbackResult =
  | { outcome: 'refused_live_changed'; reason: string }
  | { outcome: 'rolled_back' | 'rolled_back_with_deploy_errors'; restored_from: VersionRef; after: VersionRef; deploy_errors?: Array<{ namespace: string; error: string }> }
  | { outcome: 'stored_differs'; restored_from: VersionRef; after: VersionRef | null; found: string }

export async function rollbackPort(api: WorkflowApi, record: { before: VersionRef; after: VersionRef }): Promise<RollbackResult> {
  const read = await readLive(api)
  if (read.version.version_id !== record.after.version_id) {
    return {
      outcome: 'refused_live_changed',
      reason: `the newest version is ${read.version.version_number}, not ${record.after.version_number} which the port made, so re-PUTting version ${record.before.version_number} would also discard the saves since; nothing was sent`,
    }
  }
  const restore = await api.getVersion(MAIN_FLOW_WORKFLOW_ID, record.before.version_id)
  if (restore.version_number !== record.before.version_number) throw new Error(`version ${record.before.version_id} is number ${restore.version_number}, not ${record.before.version_number}`)

  const now = await readLive(api)
  const moved = movedSince(read, now)
  if (moved) return { outcome: 'refused_live_changed', reason: `${moved}; nothing was sent` }

  const save = saveFrom(now, restore.definition, `#1680 relay port rollback to version ${record.before.version_number}`)
  const put = await api.putDefinition(MAIN_FLOW_WORKFLOW_ID, save)
  if (put.kind === 'stale') return { outcome: 'refused_live_changed', reason: staleReason(put, save.expected_version) }
  const after = await versionAfterPut(api, put.version_id)
  const stored = await readLive(api)
  if (after === null) {
    return { outcome: 'stored_differs', restored_from: record.before, after, found: `${unpinned(put.version_id)}, so the version it made is unknown; the newest is ${stored.version.version_number}` }
  }
  if (stored.version.version_id !== after.version_id || !sameJson(stored.definition, restore.definition)) {
    return { outcome: 'stored_differs', restored_from: record.before, after, found: `the newest version is ${stored.version.version_number}; the live definition is ${sameJson(stored.definition, restore.definition) ? '' : 'not '}the one restored` }
  }
  if (put.deploy_errors && put.deploy_errors.length > 0) return { outcome: 'rolled_back_with_deploy_errors', restored_from: record.before, after, deploy_errors: put.deploy_errors }
  return { outcome: 'rolled_back', restored_from: record.before, after }
}

/** What a stage would change on the live definition, read only. */
export async function previewPort(api: WorkflowApi, stage: PortStage) {
  const read = await readLive(api)
  const live = read.definition as Definition
  const ported = portMainFlow(read.definition, PORT_STAGES[stage])
  const liveStatus = portStatus(live)
  const portedStatus = portStatus(ported)
  const liveNamespaces = new Set(live.nodes.map((n) => n.namespace))
  const portedNamespaces = new Set(ported.nodes.map((n) => n.namespace))
  return {
    stage,
    live_version: read.version,
    ports: portedStatus.ported.filter((p) => !liveStatus.ported.includes(p)),
    moves_inquiry: portedStatus.inquiryMoved && !liveStatus.inquiryMoved,
    adds_collections: portedStatus.collections && !liveStatus.collections,
    adds: [...portedNamespaces].filter((ns) => !liveNamespaces.has(ns)),
    removes: [...liveNamespaces].filter((ns) => !portedNamespaces.has(ns)),
    unchanged: sameJson(ported, live),
  }
}
