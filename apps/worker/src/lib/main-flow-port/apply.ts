/**
 * Applies a Main Flow port stage to the live workflow, and rolls one back
 * (#2171, #1680 plan points 11 and 12).
 *
 * `PUT /api/workflows/:id` overwrites the whole definition and checks no
 * version, so a definition built from an older read would silently undo any
 * canvas save made since. So the apply:
 *
 *  1. reads the live definition and its newest version;
 *  2. runs the transform on THAT (a canvas edit to a part it rewrites makes the
 *     transform refuse, by name, and nothing is sent);
 *  3. re-reads both immediately before the PUT and refuses when either moved;
 *  4. PUTs, then reads back: the stored definition must be the one sent and the
 *     newest version the one the PUT made, or it says what it found instead.
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

export interface WorkflowApi {
  getWorkflow(id: string): Promise<{ definition: unknown; updated_at: string }>
  /** Newest first, as the route lists them. */
  listVersions(id: string): Promise<Array<{ id: string; version_number: number }>>
  getVersion(id: string, versionId: string): Promise<{ definition: unknown; version_number: number }>
  putDefinition(id: string, definition: unknown, message: string): Promise<{ version_id?: string; deploy_errors?: Array<{ namespace: string; error: string }>; no_changes?: boolean }>
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>

/** The workflow routes over HTTP, as the signed in user. Any non 2xx throws with the route, the status and the answer. */
export function httpWorkflowApi(workerUrl: string, accessToken: string, fetchFn: FetchLike): WorkflowApi {
  const base = workerUrl.replace(/\/+$/, '')
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const url = `${base}${path}`
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetchFn(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${url} answered ${res.status}: ${text.slice(0, 300)}`)
    return JSON.parse(text) as unknown
  }
  return {
    getWorkflow: async (id) => (await call('GET', `/api/workflows/${id}`)) as { definition: unknown; updated_at: string },
    listVersions: async (id) => (await call('GET', `/api/workflows/${id}/versions`)) as Array<{ id: string; version_number: number }>,
    getVersion: async (id, versionId) => (await call('GET', `/api/workflows/${id}/versions/${versionId}`)) as { definition: unknown; version_number: number },
    putDefinition: async (id, definition, message) =>
      (await call('PUT', `/api/workflows/${id}`, { definition, message })) as { version_id?: string; deploy_errors?: Array<{ namespace: string; error: string }>; no_changes?: boolean },
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
  if (value.startsWith('base64-')) {
    const b64 = value.slice('base64-'.length).replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))
    value = new TextDecoder().decode(bytes)
  }
  try {
    const session = JSON.parse(value) as { access_token?: unknown } | null
    return typeof session?.access_token === 'string' ? session.access_token : null
  } catch {
    return null
  }
}

interface LiveRead { definition: unknown; updated_at: string; version: VersionRef }

async function readLive(api: WorkflowApi): Promise<LiveRead> {
  const wf = await api.getWorkflow(MAIN_FLOW_WORKFLOW_ID)
  const [newest] = await api.listVersions(MAIN_FLOW_WORKFLOW_ID)
  if (!newest) throw new Error('Main Flow has no saved version to build on')
  return { definition: wf.definition, updated_at: wf.updated_at, version: { version_id: newest.id, version_number: newest.version_number } }
}

/** Why `now` is not the state `read` saw, or null when nothing moved. */
function movedSince(read: LiveRead, now: LiveRead): string | null {
  if (now.version.version_id !== read.version.version_id) return `the newest version is now ${now.version.version_number}, not ${read.version.version_number}`
  if (now.updated_at !== read.updated_at) return `the workflow was saved at ${now.updated_at}, after the read at ${read.updated_at}`
  if (!sameJson(now.definition, read.definition)) return 'the live definition differs from the one read'
  return null
}

export type ApplyResult =
  | { outcome: 'nothing_to_do'; stage: PortStage; live_version: VersionRef }
  | { outcome: 'refused_live_changed'; stage: PortStage; read: VersionRef; reason: string }
  | {
      outcome: 'applied' | 'applied_with_deploy_errors' | 'stored_differs'
      stage: PortStage
      /** The version read before the change: what a rollback restores. */
      before: VersionRef
      /** The version this PUT made. */
      after: VersionRef
      deploy_errors?: Array<{ namespace: string; error: string }>
      /** For stored_differs: what is live instead. */
      found?: string
      status: ReturnType<typeof portStatus>
    }

const versionAfterPut = async (api: WorkflowApi, versionId: string | undefined): Promise<VersionRef> => {
  const versions = await api.listVersions(MAIN_FLOW_WORKFLOW_ID)
  const made = versions.find((v) => v.id === versionId) ?? versions[0]
  return { version_id: made.id, version_number: made.version_number }
}

export async function applyPort(api: WorkflowApi, stage: PortStage): Promise<ApplyResult> {
  const read = await readLive(api)
  const ported = portMainFlow(read.definition, PORT_STAGES[stage])
  if (sameJson(ported, read.definition)) return { outcome: 'nothing_to_do', stage, live_version: read.version }

  const now = await readLive(api)
  const moved = movedSince(read, now)
  if (moved) return { outcome: 'refused_live_changed', stage, read: read.version, reason: `${moved}; nothing was sent, run the apply again` }

  const put = await api.putDefinition(MAIN_FLOW_WORKFLOW_ID, ported, `#1680 relay port, stage ${stage}, built from version ${read.version.version_number}`)
  if (put.no_changes) throw new Error('the save route answered no_changes for a definition that differs from the live one')
  const after = await versionAfterPut(api, put.version_id)
  const stored = await readLive(api)
  const status = portStatus(stored.definition as Definition)
  const base = { stage, before: read.version, after, status }
  if (stored.version.version_id !== after.version_id || !sameJson(stored.definition, ported)) {
    return { ...base, outcome: 'stored_differs', found: `the newest version is ${stored.version.version_number}; the live definition is ${sameJson(stored.definition, ported) ? '' : 'not '}the one sent` }
  }
  if (put.deploy_errors && put.deploy_errors.length > 0) return { ...base, outcome: 'applied_with_deploy_errors', deploy_errors: put.deploy_errors }
  return { ...base, outcome: 'applied' }
}

export type RollbackResult =
  | { outcome: 'refused_live_changed'; reason: string }
  | { outcome: 'rolled_back' | 'rolled_back_with_deploy_errors' | 'stored_differs'; restored_from: VersionRef; after: VersionRef; deploy_errors?: Array<{ namespace: string; error: string }> }

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

  const put = await api.putDefinition(MAIN_FLOW_WORKFLOW_ID, restore.definition, `#1680 relay port rollback to version ${record.before.version_number}`)
  const after = await versionAfterPut(api, put.version_id)
  const stored = await readLive(api)
  if (stored.version.version_id !== after.version_id || !sameJson(stored.definition, restore.definition)) {
    return { outcome: 'stored_differs', restored_from: record.before, after }
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
    adds: [...portedNamespaces].filter((ns) => !liveNamespaces.has(ns)),
    removes: [...liveNamespaces].filter((ns) => !portedNamespaces.has(ns)),
    unchanged: sameJson(ported, live),
  }
}
