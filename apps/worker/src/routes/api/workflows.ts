import { Hono, type Context } from 'hono'
import { isUuidV7 } from '@bidspoke/uuidv7'
import { sanitizeCodeNodeScripts } from '@bidspoke/script-hygiene'
import { dbError, dbErrorUnlessNotFound, isNotFoundError } from '../../lib/api-error'
import { formatErr } from '../../lib/format-error'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { refreshWorkflowCaches } from '../../engine/definition-loader'
import { definitionShapeProblems, findWorkflowCycle, findSalesforceConfigProblems, findLeadValidationProblems, findLeadValidationPlacementProblems, unfinishedAppActionSteps } from '@bidspoke/workflow-definition'
import { reportDefinition } from '../../lib/definition-report'
import { pushWorkflowToGitHub } from '../../lib/github'
import { recordBackupSuccess, recordBackupFailure } from '../../lib/github-backup-alert'
import { writeAuditLog } from '../../lib/audit'
import { copyCleared, copyWarning } from '../../lib/stored-copy'
import { executeWorkflow, moneyRuntime, nodeExecutorForLane } from '../../engine/index'
import { dashboardLaneRefusal, refuseRowOutsideLane } from '../lane-refusal'
import { buildContext } from '../../engine/context'
import { formatCodeErrorMessage } from '../../engine/error-classifier'
import { loadEnvVars } from '../../lib/env-loader'
import { deployCodeNodes, deployTestCodeBundle, deleteTestBundles } from '../../lib/code-node-deployer'
import { computeDiff, diffIsEmpty, draftChangelog, getAnthropicKey, hashDefinition } from '../../lib/changelog-drafter'
import { DEFAULT_RETRIES, SUGGESTION_MIN_SAMPLE, suggestedTimeoutMs } from '../../lib/timeout-suggestion'
import { collectWorkflowDurationStats } from '../../lib/timeout-audit'
import type { WorkflowDefinition, StepOutput } from '../../types'
import { asJson } from '../../lib/json'
import { fetchAllPaged, fetchUpTo } from '../../lib/paginate'
import { CONFIG_LIST_BOUNDS } from '../../lib/config-list-bounds'
import { jsonEqual } from '../../lib/stable-json'
import { isNoRowMatchedError, requireRowsAffected } from '../../lib/db-retry'
import { loadBuyerProfiles } from '../../lib/buyer-profile-loader'
import { hasBuyerStep, inputGapsForWorkflowSave } from '../../lib/buyer-input-coverage'
import { pricedPartnersByPopulation } from '../../lib/priced-partners'
import { workflowsUsingPartner as workflowsUsingPartnerShared } from '../../lib/partner-workflow-finder'
import { readOrgWorkflows } from '../../lib/org-workflows'
import { secretKeys } from '../../lib/secret-crypto'
import { retirePartnerLastGood } from '../../lib/partner-last-good'
import { checkDefinitionConnections, type ConnectionCheckedAction } from '../../lib/workflow-connection-check'
import { copiedDefinitionStamp, writtenDefinitionStamp } from '../../lib/definition-stamp'
import { writeWorkflow, type WriteWorkflowResult } from '../../lib/write-workflow'
import { stampAppActionBinders } from '../../lib/app-action-binders'
import { readOpsStepTest, testOpsStep } from './ops-step-test'
import { assertNever } from '@bidspoke/node-types'

type Variables = AuthVariables

const workflows = new Hono<{ Bindings: Env; Variables: Variables }>()

// GET /api/workflows
workflows.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  // Read whole or refused, never cut at the row cap (#1437).
  try {
    return c.json(await fetchUpTo((limit) => supabase
      .from('workflows')
      .select('id, name, description, is_active, folder_id, created_at, updated_at, updated_by_email, updated_by_name')
      .eq('organization_id', orgId)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
      .limit(limit), CONFIG_LIST_BOUNDS.workflows, 'workflows list'))
  } catch (err) {
    return dbError(c, err)
  }
})

/**
 * Every definition this file writes goes through here first (#1117): code node scripts are
 * stripped of trailing whitespace outside template literals. The canvas already does this
 * on its own save path; doing it again on every write means a restore, a duplicate, an API
 * caller or a future importer cannot put the padding back. Anything that is not a definition
 * shaped object passes through untouched for the existing validation to refuse.
 */
function sanitizeDefinition<T>(definition: T): T {
  if (!definition || typeof definition !== 'object') return definition
  return sanitizeCodeNodeScripts(definition as T & { nodes?: unknown })
}

/**
 * The named 400 for a definition the rules cannot read (#2190): not an object,
 * a step or connection list that is not a list, or an entry without the
 * strings every rule reads. It is validateDefinition's own parse
 * (definitionShapeProblems), asked first on both routes a caller's definition
 * enters by, so a null step reaches no check that would answer 500 for it.
 * Every stored definition reachable by a save or restore had this shape when
 * measured (2026-10-22), so it refuses only what could never have run.
 */
function malformedDefinitionRefusal(c: Context<{ Bindings: Env; Variables: Variables }>, definition: unknown): Response | null {
  const problems = definitionShapeProblems(definition)
  if (problems.length === 0) return null
  return c.json(
    { error: `Nothing was saved. The workflow definition is malformed: ${problems.map((p) => p.message).join('; ')}.`, reason: 'definition_malformed', problems },
    400,
  )
}

/**
 * A definition with a loop is refused on create and save alike (#334, #2190):
 * an edge path back to an earlier node would loop at run time until the #260
 * step ceiling aborts it. Asked after the shape check, which it depends on.
 */
function loopRefusal(c: Context<{ Bindings: Env; Variables: Variables }>, definition: unknown): Response | null {
  const def = definition as WorkflowDefinition
  const cycle = findWorkflowCycle(def.nodes ?? [], def.edges ?? [])
  if (!cycle) return null
  return c.json({ error: `Workflow has a loop: ${cycle.join(' → ')}. Remove the edge that returns to an earlier node before saving.` }, 400)
}

/**
 * The refusal for a definition whose Salesforce write options are malformed
 * (#2170), naming the step, or null. One function for create and save, the two
 * routes a caller's definition enters by. Restore replays a version that was
 * itself saved, and duplicate copies a saved definition, so both carry only
 * definitions this check already passed or that predate the options.
 */
function salesforceOptionRefusal(definition: unknown): string | null {
  const nodes = (definition as { nodes?: unknown } | null | undefined)?.nodes
  if (!Array.isArray(nodes)) return null
  const problem = findSalesforceConfigProblems(nodes as WorkflowDefinition['nodes'])[0]
  return problem ? `${problem.namespace}: ${problem.message}` : null
}

/**
 * A lead validation step that may not be written (#2589, #2590), or null.
 *
 * Its placement is judged at every write: one inside a parallel block is
 * refused live or not, like a loop, because a lead it rejects there cannot be
 * answered (Dan's decision on #2590).
 *
 * Its configuration, the rules its executor needs (no checks, a half filled
 * row, an empty value, a reason outside the one list, no lead id field, a
 * reference to a step that does not run before it or to a Constants key its
 * Constants step does not hold), is judged only when the write makes the
 * definition live (`live`): a save of a switched on workflow, the switch on,
 * and a restore onto a switched on workflow. Like every other unconfigured step
 * (the canvas's liveSaveBlocker), a switched off draft with a half built check
 * saves (Dan's decision on #2590). Both rules are the canvas's own
 * (packages/workflow-definition), so one PUT from a file meets what the canvas does.
 */
function leadValidationRefusal(definition: unknown, live: boolean): string | null {
  const def = definition as { nodes?: unknown; edges?: unknown } | null | undefined
  if (!Array.isArray(def?.nodes)) return null
  const nodes = (def.nodes as unknown[]).filter((n): n is WorkflowDefinition['nodes'][number] => typeof n === 'object' && n !== null)
  const edges = Array.isArray(def.edges) ? (def.edges as WorkflowDefinition['edges']) : []
  const problem = findLeadValidationPlacementProblems(nodes, edges)[0] ?? (live ? findLeadValidationProblems(nodes, edges)[0] : undefined)
  return problem ? `${problem.namespace}: ${problem.message}` : null
}

/**
 * An App Action step that is not finished, on a write that makes the
 * definition live (#2338, plan section 3.3 of #1689): a step is incomplete
 * until what it runs, its connection and its required fields are set, and a
 * workflow holding one cannot be switched on. Judged by validateDefinition at
 * the stamp the definition is stored under (unfinishedAppActionSteps), and asked
 * by the save of a switched on workflow, the switch on and a restore onto a
 * switched on workflow. A switched off draft saves half built, as every other
 * unconfigured step does. A stamp this build cannot judge refuses rather than
 * passing as finished.
 */
function unfinishedStepRefusal(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  definition: unknown,
  lane: unknown,
  schemaVersion: unknown,
): Response | null {
  const judged = unfinishedAppActionSteps(definition, { lane: lane === 'ops' ? 'ops' : 'money', schemaVersion })
  if (judged.kind !== 'judged') {
    return c.json({ error: 'step_unjudged', message: 'Nothing was saved. This server cannot judge the workflow\'s steps at the version they were saved under, so it cannot be switched on yet.' }, 422)
  }
  const first = judged.steps[0]
  if (!first) return null
  return c.json({
    error: 'step_unfinished',
    message: `Nothing was saved. Step ${first.namespace} is not finished: ${first.message}. A workflow with an unfinished step cannot be switched on.`,
    steps: judged.steps,
  }, 422)
}

/**
 * A live workflow whose buyer steps cannot read a rule of an enabled buyer
 * profile they judge (#2149) is refused, naming the step, the buyer and the
 * rule: saved, the step would refuse every lead that buyer is offered as
 * missing_lead_field, as the Engine live share did for 45 hours from
 * 2026-10-13. Asked by every route that makes a definition live: a save of an
 * active workflow, the switch on, and a restore onto an active workflow. The
 * profiles are those the nodes read (loadBuyerProfiles); a read that fails
 * refuses the save with 503 rather than letting it through as if no buyer were
 * enabled (L42). A definition with no buyer step never reads them. The profile
 * save asks the same finder from the other side (routes/api/buyer-profiles.ts).
 */
async function unreadBuyerRuleRefusal(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  supabase: ReturnType<typeof createSupabaseClient>,
  orgId: string,
  workflow: { id: string; name: string; definition: unknown },
): Promise<Response | null> {
  if (!hasBuyerStep(workflow.definition)) return null
  let snapshot
  try {
    snapshot = await loadBuyerProfiles(orgId, c.env.WORKFLOW_CACHE, supabase)
  } catch (err) {
    console.error(`[workflows] buyer profiles unreadable while checking workflow ${workflow.id}: ${formatErr(err)}`)
    return c.json({ error: 'Nothing was saved. The buyer profiles could not be read, so whether the buyer steps can read every rule they judge is unknown. Try again.' }, 503)
  }
  const buyers = snapshot.buyers.map((b) => ({ partnerId: b.partner.id, name: b.partner.name, profile: b.profile }))
  const problems = inputGapsForWorkflowSave(workflow, buyers)
  if (problems.length === 0) return null
  return c.json({ error: `Nothing was saved. ${problems.join(' ')}`, problems }, 422)
}

/**
 * Every route here that writes a definition (create, save, duplicate, version
 * restore) asks this before its first write (#2338, build PR 7): a definition
 * naming a connection that was removed, or one of another organization, is
 * refused by name and nothing is written. A check that cannot be made refuses
 * too (lib/workflow-connection-check.ts). The database trigger
 * workflows_refuse_missing_connections enforces the same answer at the write
 * itself; __guards__/worker/workflow-connection-check-guard.test.ts fails on a
 * definition writer that does not ask. The switch on (PATCH, #2576) asks it
 * too, about the stored definition it makes live, worded as a switch on.
 */
async function connectionRefusal(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  supabase: ReturnType<typeof createSupabaseClient>,
  orgId: string,
  definition: unknown,
  action: ConnectionCheckedAction = 'save',
): Promise<Response | null> {
  const refusal = await checkDefinitionConnections(supabase, orgId, definition, action)
  return refusal ? c.json(refusal.body, refusal.status) : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A version a caller names must be a whole number from 0; absent is allowed here and decided by each route. */
function expectedVersionRefusal(c: Context<{ Bindings: Env; Variables: Variables }>, value: unknown): Response | null {
  if (value === undefined) return null
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return null
  return c.json({ error: 'expected_version_invalid', message: 'expected_version must be a whole number, 0 or more.' }, 400)
}

/** The actor writeWorkflow records on the row. */
function actorOf(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const { userId, email, name } = c.get('user')
  return { id: userId, email, name }
}

/**
 * A save of a definition from a canvas opened before every canvas save named
 * the version it was loaded from and its press (#2599). Its save would be made
 * from whatever version the request read, writing over a newer save, so it is
 * refused before anything is read, with its edits left on the canvas (L598).
 */
export const RELOAD_REQUIRED_WORKFLOW_MESSAGE =
  'Not saved. This page was opened before an update to how workflows are saved. Your changes are still on the canvas: copy the steps you changed, reload the page, and paste them back. A release can take a few minutes to reach your browser, so if this comes back after reloading, wait a few minutes and try again.'

/**
 * A save made from a version that is no longer stored (#1947). Nothing was
 * written, and the caller's edits are its own. It is the `error` a page shows
 * as it stands (this route's sentences are its errors), with `code` naming it
 * and the current row, the press that won and who made it beside it.
 */
export const STALE_WORKFLOW_MESSAGE =
  'Not saved. This workflow was saved by someone else after you opened it, and saving yours would undo their change. Your changes are still on screen.'

/**
 * Every answer of writeWorkflow other than written, as a response: a lost
 * race is a 409 carrying the current row, the save that won and who made it;
 * a missing workflow, version or folder is a 404 naming which; the connection
 * trigger's refusal is answered by name (#2338); a call the function refused
 * is a 400 with its reason; anything else is a database error. Nothing was
 * written in any of them, snapshot included: the function writes both or
 * neither.
 */
function answerUnwritten(c: Context<{ Bindings: Env; Variables: Variables }>, result: Exclude<WriteWorkflowResult, { kind: 'written' }>, staleMessage = STALE_WORKFLOW_MESSAGE): Response {
  switch (result.kind) {
    case 'stale':
      return c.json({ error: staleMessage, code: 'stale_version', current: result.current, last_save_id: result.lastSaveId, changed_by_name: result.changedByName, changed_at: result.changedAt }, 409)
    case 'not_found':
      return c.json({ error: result.what === 'version' ? 'Version not found' : result.what === 'folder' ? 'folder not found' : 'Workflow not found' }, 404)
    case 'connection_refused':
      return c.json(result.refusal.body, result.refusal.status)
    case 'refused':
      return c.json({ error: result.reason, detail: result.detail }, 400)
    case 'failed':
      return dbError(c, result.error)
    default:
      return assertNever(result, 'write_workflow answer')
  }
}

// POST /api/workflows
workflows.post('/', async (c) => {
  const { orgId, userId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ name: string; description?: string; definition?: unknown; folder_id?: string | null }>()

  if (!body.name) return c.json({ error: 'name is required' }, 400)

  // A caller's definition is held to the shape and loop checks save applies (#2190).
  if (body.definition !== undefined) {
    const malformed = malformedDefinitionRefusal(c, body.definition)
    if (malformed) return malformed
    const loop = loopRefusal(c, body.definition)
    if (loop) return loop
  }

  // A definition can enter here as well as by save, so it meets the same
  // Salesforce write option rule the save route applies (#2170).
  const sfProblem = salesforceOptionRefusal(body.definition)
  if (sfProblem) return c.json({ error: sfProblem }, 400)
  // A created workflow is switched off (below), so only the placement rule applies.
  const validationProblem = leadValidationRefusal(body.definition, false)
  if (validationProblem) return c.json({ error: validationProblem }, 400)

  if (body.folder_id) {
    const { data: folder, error: folderError } = await supabase
      .from('folders')
      .select('id')
      .eq('id', body.folder_id)
      .eq('organization_id', orgId)
      .single()
    if (folderError && !isNotFoundError(folderError)) return dbError(c, folderError)
    if (!folder) return c.json({ error: 'folder not found' }, 404)
  }

  const definition = sanitizeDefinition(body.definition ?? { nodes: [], edges: [], trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } } })
  const missing = await connectionRefusal(c, supabase, orgId, definition)
  if (missing) return missing

  // Report only (#1947): a new workflow is a switched off money workflow.
  reportDefinition(definition, { writer: 'create', workflowId: null, lane: 'money', live: false, schemaVersion: writtenDefinitionStamp() })

  // A new workflow starts switched off (#1706), which write_workflow decides:
  // nothing a caller sends can create one that takes traffic before a person
  // has switched it on through PATCH, where the safeguards live. The stamp is
  // never the caller's: the Worker says which rules this definition is judged by.
  const result = await writeWorkflow(supabase, {
    op: 'create',
    orgId,
    workflowId: null,
    expectedVersion: null,
    fields: {
      name: body.name,
      description: body.description ?? null,
      folder_id: body.folder_id ?? null,
      definition,
      definition_schema_version: writtenDefinitionStamp(),
    },
    saveId: null,
    actor: actorOf(c),
    storedDefinition: null,
  })
  if (result.kind !== 'written') return answerUnwritten(c, result)

  await writeAuditLog(supabase, orgId, 'workflow', result.workflow.id, 'created', userId)
  return c.json(result.workflow, 201)
})

// POST /api/workflows/:id/duplicate — clone a workflow with its full version history
//
// Unlike a client-side "GET then create", this copies every workflow_versions row
// so the clone is a faithful starting point: the revision timeline reads identically
// and the next save continues from the right version number (rather than restarting
// at v1). The workflow's current `definition` is always the latest saved state, so
// copying it carries the most recent edits too. (A separate draft/undeployed concept
// doesn't exist yet — see the staging-vs-prod issue — so there's nothing more to carry.)
workflows.post('/:id/duplicate', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  // Load source (org-scoped)
  const { data: source, error: sourceErr } = await supabase
    .from('workflows')
    .select('name, description, definition, folder_id, definition_schema_version, lane, version')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()

  if (sourceErr || !source) return c.json({ error: 'Workflow not found' }, 404)

  // The copy's definition is a new write: a connection removed since the source
  // was saved stops it here, before anything is written (#2338). Older snapshots
  // copied into its history below are history only and are not judged.
  const cloneDefinition = sanitizeDefinition(source.definition)
  const missing = await connectionRefusal(c, supabase, orgId, cloneDefinition)
  if (missing) return missing

  // Report only (#1947): the clone is a switched off copy under the source's stamp.
  reportDefinition(cloneDefinition, { writer: 'duplicate', workflowId: id, lane: source.lane, live: false, schemaVersion: copiedDefinitionStamp(source) })

  // The clone, always switched off (#1706) whatever the source's state, on the
  // source's lane, with the source's stamp and its whole version history, or a
  // first version of it when it was never saved: one write_workflow call, so a
  // copy never lands without its history (#1947). A copy of a live workflow is
  // a second definition that could take traffic the moment anything routes to
  // it, so a person switches it on deliberately. History is copied as stored;
  // a restore of a copied version cleans its scripts as every restore does.
  const result = await writeWorkflow(supabase, {
    op: 'duplicate',
    orgId,
    workflowId: id,
    // The version the copied definition was read from: a save landing since is
    // refused, so the copy never pairs one definition with another's history.
    expectedVersion: source.version,
    fields: { name: `${source.name} (copy)`, definition: cloneDefinition },
    saveId: null,
    actor: actorOf(c),
    // The copy has no stored definition of its own: every step is bound by whoever duplicated it (#2339).
    storedDefinition: null,
  })
  if (result.kind !== 'written') {
    return answerUnwritten(c, result, 'Not duplicated. This workflow was saved by someone else while it was being copied. Nothing was created. Try again.')
  }
  const clone = result.workflow

  // Deploy the clone's code-node bundle. Bundles are keyed per workflow id, so
  // the source's bundle doesn't cover the clone — without this, a cloned workflow
  // with Code nodes would 500 on them until its first save. Awaited so the clone
  // is runnable on return; no-op (returns []) when the definition has no code nodes.
  const deployErrors: { namespace: string; error: string }[] = []
  const results = await deployCodeNodes(
    clone.id,
    source.definition as unknown as WorkflowDefinition,
    c.env.CLOUDFLARE_ACCOUNT_ID,
    c.env.CLOUDFLARE_API_TOKEN,
    c.env.WORKFLOW_CACHE
  ).catch((e) => { console.error('[duplicate] code-node deploy failed:', e); return [] })
  for (const r of results) {
    if (r.error) deployErrors.push({ namespace: r.namespace, error: r.error })
  }

  await writeAuditLog(supabase, orgId, 'workflow', clone.id, 'created', userId, { duplicated_from: id })
  return c.json({ ...clone, history_copied: true, deploy_errors: deployErrors.length ? deployErrors : undefined }, 201)
})

// GET /api/workflows/:id
workflows.get('/:id', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('workflows')
    .select('*')
    .eq('id', c.req.param('id'))
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()

  const blocked = dbErrorUnlessNotFound(c, error)
  if (blocked) return blocked
  if (!data) return c.json({ error: 'Workflow not found' }, 404)
  return c.json(data)
})

// GET /api/workflows/:id/timeout-suggestions
//
// Batched timeout suggestions for every node in one workflow, so the canvas can
// badge nodes whose configured timeout sits below the suggested value without a
// per-node step-duration-stats round-trip. One grouped percentile RPC per
// window instead of N: step_duration_percentiles_by_workflow returns all
// namespaces at once.
//
// Sampling comes from collectWorkflowDurationStats — the shared adaptive
// window with per-namespace lock-in, so the badge, the config panel, and the
// audit all see the same stats for the same node.
//
// Cached in KV for 30 minutes, keyed on updated_at so a save (which can change
// per-node retries, and with them the suggestion math) busts it immediately.
workflows.get('/:id/timeout-suggestions', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const { data: wf, error: wfError } = await supabase
    .from('workflows')
    .select('id, updated_at, definition')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()
  if (wfError && !isNotFoundError(wfError)) return dbError(c, wfError)
  if (!wf) return c.json({ error: 'Workflow not found' }, 404)

  // v3: added p50 + per-node window_days (panel and badge share this payload)
  const cacheKey = `timeout-suggestions:v3:${id}:${wf.updated_at}`
  const cached = await c.env.WORKFLOW_CACHE.get(cacheKey)
  if (cached) return c.json(JSON.parse(cached))

  const definition = wf.definition as WorkflowDefinition | null
  const defNodes = Array.isArray(definition?.nodes) ? definition.nodes : []

  const { stats, windowDays } = await collectWorkflowDurationStats(
    supabase,
    id,
    defNodes.map((n) => n.namespace)
  )

  const nodes = defNodes.flatMap((node) => {
    const row = stats.get(node.namespace)
    if (!row || row.p99 == null || row.max_ms == null) return []
    const sampleSize = Number(row.sample_size)
    if (sampleSize < SUGGESTION_MIN_SAMPLE) return []
    const retries = typeof node.config?.retries === 'number' ? node.config.retries : DEFAULT_RETRIES
    return [{
      node_id: node.id,
      namespace: node.namespace,
      type: node.type,
      configured_ms: typeof node.config?.timeout_ms === 'number' ? node.config.timeout_ms : null,
      retries,
      suggested_ms: suggestedTimeoutMs(node.type, row.p99, row.max_ms, retries),
      p50: row.p50 ?? null,
      p99: row.p99,
      max_ms: row.max_ms,
      sample_size: sampleSize,
      window_days: row.window_days ?? 7,
    }]
  })

  const payload = { window_days: windowDays, nodes }
  await c.env.WORKFLOW_CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 1800 })
  return c.json(payload)
})

// PUT /api/workflows/:id — save definition, create version snapshot, invalidate KV cache
workflows.put('/:id', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ name?: string; description?: string; definition?: unknown; message?: string; slack_channel?: string | null; expected_version?: unknown; save_id?: unknown }>()

  // A save names the version it was edited from and the press that made it
  // (#1947); write_workflow refuses it as stale when that version is no longer
  // stored. A save of a definition must name both (#2599): one naming neither
  // comes from a canvas opened before the canvas sent them. A save sending no
  // definition (a rename from the list) may name none, and is then made from
  // the version read below, so a write landing during this request is still
  // caught.
  if (body.definition !== undefined && (body.expected_version === undefined || body.save_id === undefined)) {
    return c.json({ code: 'reload_required', error: RELOAD_REQUIRED_WORKFLOW_MESSAGE }, 428)
  }
  const versionRefusal = expectedVersionRefusal(c, body.expected_version)
  if (versionRefusal) return versionRefusal
  if (body.save_id !== undefined && (typeof body.save_id !== 'string' || !UUID.test(body.save_id))) {
    return c.json({ error: 'save_id_invalid', message: 'save_id must be a UUID.' }, 400)
  }
  // Before the cycle check and the no-op compare, so a save that only re-pads a clean
  // script reads as no_changes rather than minting a version row (#1117).
  if (body.definition !== undefined) body.definition = sanitizeDefinition(body.definition)

  // Verify ownership
  const { data: existing, error: fetchError } = await supabase
    .from('workflows')
    .select('id, definition, name, slack_channel, is_active, definition_schema_version, lane, version')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()

  const blocked = dbErrorUnlessNotFound(c, fetchError)
  if (blocked) return blocked
  if (!existing) return c.json({ error: 'Workflow not found' }, 404)

  // A definition the rules cannot read is refused by name first (#2190), then a
  // cyclic one (#334). Only checked when a new definition is sent.
  if (body.definition !== undefined) {
    const malformed = malformedDefinitionRefusal(c, body.definition)
    if (malformed) return malformed
    const loop = loopRefusal(c, body.definition)
    if (loop) return loop
    const def = body.definition as WorkflowDefinition
    // A Salesforce step's write options (#2170), judged by the rule its executor
    // applies, so a definition PUT from a file is held to what the canvas is.
    const sfProblem = salesforceOptionRefusal(def)
    if (sfProblem) return c.json({ error: sfProblem }, 400)
    const validationProblem = leadValidationRefusal(def, existing.is_active === true)
    if (validationProblem) return c.json({ error: validationProblem }, 400)
    if (existing.is_active === true) {
      const unfinished = unfinishedStepRefusal(c, def, existing.lane, writtenDefinitionStamp())
      if (unfinished) return unfinished
    }
    // A live workflow's buyer steps must read every rule they judge (#2149).
    if (existing.is_active === true) {
      const unread = await unreadBuyerRuleRefusal(c, supabase, orgId, { id, name: body.name ?? existing.name, definition: body.definition })
      if (unread) return unread
    }
  }

  // #569: short-circuit a no-op save. If the incoming definition is structurally
  // identical to what's stored (jsonb reorders object keys, so this must be a
  // key-order-independent compare, not a string compare) and no other field is
  // changing, nothing would actually be written. The old code still inserted a
  // redundant version row and returned a plain 200 (indistinguishable from a
  // real save), so a client edit that silently failed to reach the payload
  // looked "Saved" with an unchanged DB (the reported bug). Report `no_changes`
  // instead and skip the snapshot / cache churn / audit entry so the UI can flag
  // the discrepancy loudly ("fail loud, not silent"). The stored copies are still
  // refreshed (#1845): a save whose refresh failed tells the person to save
  // again, and that second save is unchanged, so skipping the refresh here would
  // make the remedy do nothing.
  const nameUnchanged = body.name === undefined || body.name === existing.name
  const slackUnchanged =
    body.slack_channel === undefined ||
    (body.slack_channel ?? null) === (existing.slack_channel ?? null)
  const descriptionNotTouched = body.description === undefined
  if (
    body.definition !== undefined &&
    nameUnchanged &&
    slackUnchanged &&
    descriptionNotTouched &&
    // Compared as writeWorkflow would write it: a canvas that never saw a step's binder stamp (#2339)
    // still sends the definition unchanged.
    jsonEqual(stampAppActionBinders(body.definition, existing.definition, actorOf(c).id), existing.definition)
  ) {
    const copyRefreshed = await copyCleared(async () => {
      await refreshWorkflowCaches(id, c.env.WORKFLOW_CACHE, supabase)
    }, `workflow ${id} caches`)
    return c.json({ id, no_changes: true, version: existing.version, ...copyWarning(copyRefreshed) })
  }

  // A new definition names only live connections of this organization (#2338),
  // asked before the snapshot below, so a refusal writes nothing. A save that
  // sends no definition writes none, and the trigger judges only a definition
  // that changes.
  if (body.definition !== undefined) {
    const missing = await connectionRefusal(c, supabase, orgId, body.definition)
    if (missing) return missing
  }

  // The snapshot and the row in one write_workflow call (#1947): from the
  // version the canvas was edited from, numbered under the row lock, the stamp
  // the Worker checked by when a definition is sent (the stored one's when not),
  // and what validateDefinition found in it, reported only. A save that lost
  // the race to someone else's writes nothing and answers 409 with theirs.
  // A sent definition is stamped with this build's version; a save sending none
  // snapshots the stored one, whose stamp write_workflow copies itself.
  const savedStamp = writtenDefinitionStamp()
  const report = body.definition !== undefined
    ? reportDefinition(body.definition, { writer: 'save', workflowId: id, lane: existing.lane, live: existing.is_active === true, schemaVersion: savedStamp })
    : null
  const fields: Record<string, unknown> = {}
  if (body.name !== undefined) fields.name = body.name
  if (body.description !== undefined) fields.description = body.description
  if (body.slack_channel !== undefined) fields.slack_channel = body.slack_channel
  if (body.message !== undefined) fields.message = body.message
  if (body.definition !== undefined) {
    fields.definition = body.definition
    fields.definition_schema_version = savedStamp
    fields.definition_report = report
  }
  const result = await writeWorkflow(supabase, {
    op: 'save',
    orgId,
    workflowId: id,
    expectedVersion: typeof body.expected_version === 'number' ? body.expected_version : existing.version,
    fields,
    saveId: typeof body.save_id === 'string' ? body.save_id : null,
    actor: actorOf(c),
    storedDefinition: existing.definition,
  })
  if (result.kind !== 'written') return answerUnwritten(c, result)
  const updated = result.workflow
  const versionId = result.versionId
  const nextVersion = result.versionNumber

  // Drop the KV cache and bring the last-good copy up to this save (#1845), so
  // a database outage straight after it runs the definition just saved. Right
  // after the commit and never throwing, so the deploy and the audit below
  // always run; a failure is reported beside the save rather than instead of it.
  const copyRefreshed = await copyCleared(async () => { await refreshWorkflowCaches(id, c.env.WORKFLOW_CACHE, supabase) }, `workflow ${id} caches`)

  // Deploy code node scripts — run synchronously so errors surface in the save response
  const deployErrors: { namespace: string; error: string }[] = []
  if (body.definition) {
    const results = await deployCodeNodes(
      id,
      body.definition as WorkflowDefinition,
      c.env.CLOUDFLARE_ACCOUNT_ID,
      c.env.CLOUDFLARE_API_TOKEN,
      c.env.WORKFLOW_CACHE
    ).catch((e) => { console.error('[code-nodes] deploy failed:', e); return [] })
    for (const r of results) {
      if (r.error) deployErrors.push({ namespace: r.namespace, error: r.error })
    }
    // The stable bundle is now (re)deployed — delete the ephemeral test bundles
    // accumulated from iterate-then-test cycles. Non-blocking; best-effort.
    c.executionCtx.waitUntil(
      deleteTestBundles(id, c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN, c.env.WORKFLOW_CACHE)
        .catch((e) => console.error('[code-nodes] test bundle cleanup failed:', e))
    )
  }

  // Push definition to GitHub backup repo and store commit SHA on the version row (non-blocking)
  const workflowName = body.name ?? (existing.definition as { name?: string } | null)?.name ?? id
  c.executionCtx.waitUntil(
    pushWorkflowToGitHub(
      c.env.GITHUB_TOKEN,
      c.env.GITHUB_REPO,
      id,
      workflowName,
      body.definition ?? existing.definition,
      nextVersion,
      body.message
    )
      .then(async (commitSha) => {
        // null = backup not configured (no token/repo) — not a failure, leave the streak alone.
        if (!commitSha) return
        // Runs after the save has already been answered, so there is no response
        // to fail. Both a real error and a zero-row match were discarded here,
        // leaving a version row with no commit_sha that still looked like a
        // healthy backup. The GitHub push itself did succeed, so the streak is
        // still reset; only the bookkeeping is reported as broken (#588).
        // write_workflow names the snapshot it wrote; an answer without one leaves
        // nothing to stamp, reported as the unset stamp it is, never sent as an empty id.
        const { error: stampError } = versionId
          ? await requireRowsAffected(
            'workflow_versions.commit_sha',
            () => supabase.from('workflow_versions').update({ commit_sha: commitSha }).eq('id', versionId).select('id'),
            { onMiss: 'error', context: { workflow_id: id, version_id: versionId } }
          )
          : { error: new Error('write_workflow answered the save without the id of the version it wrote') }
        if (stampError && !isNoRowMatchedError(stampError)) {
          console.error(
            JSON.stringify({
              event: 'workflow_version_commit_sha_unset',
              workflow_id: id,
              version_id: versionId,
              reason: stampError.message,
            })
          )
        }
        await recordBackupSuccess(c.env.IDEMPOTENCY, orgId)
      })
      .catch(async (e) => {
        console.error('[github] backup failed:', e)
        // LOCAL_DEV (set only in .dev.vars, never in production) means this save is
        // running against the real production Supabase/Slack connection from a local
        // `wrangler dev` process, which has no GITHUB_TOKEN. Recording the failure here
        // would trip the real org's backup-failure Slack alert from local testing.
        if (c.env.LOCAL_DEV) return
        await recordBackupFailure({
          supabase,
          kv: c.env.IDEMPOTENCY,
          orgId,
          workflowId: id,
          workflowName,
          error: e,
          appUrl: c.env.APP_URL,
        }).catch((alertErr) => console.error('[github] backup alert failed:', alertErr))
      })
  )

  await writeAuditLog(supabase, orgId, 'workflow', id, 'updated', userId, {
    version: nextVersion,
    changed_by_name: email,
  })

  return c.json({ ...updated, version_id: versionId, deploy_errors: deployErrors.length ? deployErrors : undefined, ...copyWarning(copyRefreshed) })
})

// POST /api/workflows/:id/draft-changelog — AI-drafted summary of pending changes for the save popover
workflows.post('/:id/draft-changelog', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  let body: { definition?: WorkflowDefinition }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON' }, 400)
  }
  if (!body.definition) return c.json({ error: 'definition required' }, 400)

  const apiKey = await getAnthropicKey(c.env, supabase, orgId)
  if (!apiKey) {
    return c.json({ draft: null, reason: 'unavailable' as const })
  }

  const { data: wf, error: wfError } = await supabase
    .from('workflows')
    .select('id, name')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()
  if (wfError && !isNotFoundError(wfError)) return dbError(c, wfError)
  if (!wf) return c.json({ error: 'Workflow not found' }, 404)

  const { data: lastVersion } = await supabase
    .from('workflow_versions')
    .select('definition')
    .eq('workflow_id', id)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!lastVersion?.definition) {
    return c.json({ draft: null, reason: 'no_previous_version' as const })
  }

  const hash = await hashDefinition(body.definition)
  const cacheKey = `changelog-draft:${id}:${hash}`
  const cached = await c.env.WORKFLOW_CACHE.get(cacheKey)
  if (cached) return c.json({ draft: cached, cached: true })

  const diff = computeDiff(lastVersion.definition as unknown as WorkflowDefinition, body.definition)
  if (diffIsEmpty(diff)) {
    return c.json({ draft: null, reason: 'no_changes' as const })
  }

  try {
    const draft = await draftChangelog(apiKey, diff, wf.name)
    if (draft) {
      c.executionCtx.waitUntil(
        c.env.WORKFLOW_CACHE.put(cacheKey, draft, { expirationTtl: 3600 })
      )
    }
    return c.json({ draft })
  } catch (e) {
    console.error('[changelog-draft] failed:', e)
    return c.json({ draft: null, reason: 'error' as const })
  }
})

// PATCH /api/workflows/:id — lightweight field updates (is_active) without creating a version snapshot
workflows.patch('/:id', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{
    is_active?: boolean
    folder_id?: string | null
  }>()

  const { data: owner, error: fetchError } = await supabase
    .from('workflows')
    .select('id, name, is_active, definition, definition_schema_version, lane, version')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()

  const fetchBlocked = dbErrorUnlessNotFound(c, fetchError)
  if (fetchBlocked) return fetchBlocked
  if (!owner) return c.json({ error: 'Workflow not found' }, 404)

  // Switching on makes the definition live: its buyer steps must read every rule they judge (#2149).
  if (body.is_active === true) {
    // And its lead validation steps must be ones the executor can run (#2590),
    // since a switched off draft may have been saved half built.
    const validationProblem = leadValidationRefusal(owner.definition, true)
    if (validationProblem) return c.json({ error: validationProblem }, 400)
    const unfinished = unfinishedStepRefusal(c, owner.definition, owner.lane, owner.definition_schema_version)
    if (unfinished) return unfinished
    const unread = await unreadBuyerRuleRefusal(c, supabase, orgId, { id, name: owner.name, definition: owner.definition })
    if (unread) return unread
    // And every connection it names must still be a live one of this
    // organization (#2576). The trigger fires only on a write of the
    // definition, which a switch on is not, so this check is what refuses it,
    // by name, writing nothing. A removal racing this switch on cannot leave
    // it naming a removed connection: remove_ops_connection refuses while any
    // workflow's definition names the connection, switched on or off.
    const missing = await connectionRefusal(c, supabase, orgId, owner.definition, 'switch_on')
    if (missing) return missing
    // Report only (#1947): the stored definition this makes live, at its own stamp.
    reportDefinition(owner.definition, { writer: 'switch_on', workflowId: id, lane: owner.lane, live: true, schemaVersion: owner.definition_schema_version })
  }

  // One write_workflow call (#1947). Switching on is made from the version
  // whose definition was checked above: a save landing in between makes it
  // stale, so a definition nobody checked is never switched on. A switch off or
  // a move needs no version. The function refuses a folder of another
  // organization as folder not found.
  const fields: Record<string, unknown> = {}
  if (body.is_active !== undefined) fields.is_active = body.is_active
  if ('folder_id' in body && (body.folder_id === null || typeof body.folder_id === 'string')) fields.folder_id = body.folder_id
  const result = await writeWorkflow(supabase, {
    op: 'patch',
    orgId,
    workflowId: id,
    expectedVersion: body.is_active === true ? owner.version : null,
    fields,
    saveId: null,
    actor: actorOf(c),
    storedDefinition: null,
  })
  if (result.kind !== 'written') {
    return answerUnwritten(c, result, 'Not switched on. This workflow was saved by someone else while it was being switched on, so the definition checked is no longer the one stored. Nothing was changed. Try again.')
  }
  const { id: writtenId, name: writtenName, is_active, folder_id, updated_at } = result.workflow
  const data = { id: writtenId, name: writtenName, is_active, folder_id, updated_at }

  // A switch off leaves a copy that refuses (#1845): an outage must not run a
  // workflow somebody turned off.
  const copyRefreshed = await copyCleared(async () => { await refreshWorkflowCaches(id, c.env.WORKFLOW_CACHE, supabase) }, `workflow ${id} caches`)
  await writeAuditLog(supabase, orgId, 'workflow', id, 'updated', userId, {
    is_active: body.is_active,
    folder_id: 'folder_id' in body ? body.folder_id : undefined,
    changed_by_name: email,
  })

  return c.json({ ...data, ...copyWarning(copyRefreshed) })
})

// DELETE /api/workflows/:id: a soft delete. Execution rows have a RESTRICT
// foreign key on workflows(id) and are audit and cost history, so the workflow
// is retired by deleted_at and switched off, so anything that only checks
// is_active skips it too.
//
// What a soft delete does to each piece of state derived from the workflow
// (#1947, L38), each held by a test:
// - the row: deleted_at set, is_active false, its version, definition and
//   history kept (write_workflow; supabase/tests/write_workflow.test.sql E),
//   and every later write of it is a 404 (workflow_not_found);
// - the definition cache and the last good copy: dropped and replaced by a copy
//   that refuses, so an outage never runs it (refreshWorkflowCaches, below;
//   engine/__tests__/definition-copy.test.ts, the deleted case);
// - the engine: the definition loader reads only rows with no deleted_at, so a
//   webhook or a custom endpoint still mapped to it answers 404 Workflow not
//   found and runs nothing; the endpoint row is left for a person to repoint;
// - the ops tick (an ops lane workflow): its copy carries deleted_at and a
//   deleted copy never starts (supabase-ops ops_tick.test.sql);
// - deployed code node bundles, workflow scoped variables and folder
//   membership: left, never loaded or counted, since nothing runs or lists a
//   deleted workflow.
workflows.delete('/:id', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  // Through write_workflow (#1947). A workflow that never existed, belongs to
  // another organization, or was already deleted is a 404 (#588).
  const result = await writeWorkflow(supabase, { op: 'delete', orgId, workflowId: id, expectedVersion: null, fields: {}, saveId: null, actor: actorOf(c), storedDefinition: null })
  if (result.kind !== 'written') return answerUnwritten(c, result)

  const copyRefreshed = await copyCleared(async () => { await refreshWorkflowCaches(id, c.env.WORKFLOW_CACHE, supabase) }, `workflow ${id} caches`)
  await writeAuditLog(supabase, orgId, 'workflow', id, 'deleted', userId)
  return c.json({ ok: true, ...copyWarning(copyRefreshed) })
})

// PATCH /api/workflows/:id/test-payloads — replace the saved test payload array
workflows.patch('/:id/test-payloads', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ test_payloads: Array<{ name: string; payload: unknown }> }>()

  if (!Array.isArray(body.test_payloads)) {
    return c.json({ error: 'test_payloads must be an array' }, 400)
  }

  const { data, error } = await supabase
    .from('workflows')
    .update({ test_payloads: asJson(body.test_payloads) })
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .select('test_payloads')
    .single()

  const updateBlocked = dbErrorUnlessNotFound(c, error)
  if (updateBlocked) return updateBlocked
  if (!data) return c.json({ error: 'Workflow not found' }, 404)
  // Every write to the row moves its stamp, which orders the last-good copy, so
  // the copy is brought up to it here too (#1845).
  // Test payloads change nothing a live lead runs, so a copy still holding the
  // old ones serves the same definition: the failure is logged, never warned.
  await copyCleared(async () => { await refreshWorkflowCaches(id, c.env.WORKFLOW_CACHE, supabase) }, `workflow ${id} caches`)
  return c.json(data)
})

// GET /api/workflows/:id/versions
workflows.get('/:id/versions', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  // Verify ownership first
  const { data: owner, error: ownerError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()

  const ownerBlocked = dbErrorUnlessNotFound(c, ownerError)
  if (ownerBlocked) return ownerBlocked
  if (!owner) return c.json({ error: 'Workflow not found' }, 404)

  // Paged, so a history past PostgREST's 1,000 row cap is listed whole.
  let data: unknown[]
  try {
    data = await fetchAllPaged(
      (from, to) => supabase
        .from('workflow_versions')
        .select('id, version_number, commit_sha, created_by, created_at, message')
        .eq('workflow_id', id)
        .order('version_number', { ascending: false })
        .range(from, to),
      'version history read',
    )
  } catch (err) {
    return dbError(c, err)
  }
  return c.json(data)
})

// GET /api/workflows/:id/versions/:version_id
workflows.get('/:id/versions/:version_id', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const versionId = c.req.param('version_id')
  const supabase = createSupabaseClient(c.env)

  const { data: owner, error: ownerError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()

  const ownerBlocked = dbErrorUnlessNotFound(c, ownerError)
  if (ownerBlocked) return ownerBlocked
  if (!owner) return c.json({ error: 'Workflow not found' }, 404)

  const { data, error } = await supabase
    .from('workflow_versions')
    .select('*')
    .eq('id', versionId)
    .eq('workflow_id', id)
    .single()

  const blocked = dbErrorUnlessNotFound(c, error)
  if (blocked) return blocked
  if (!data) return c.json({ error: 'Version not found' }, 404)
  return c.json(data)
})

// POST /api/workflows/:id/versions/:version_id/restore
workflows.post('/:id/versions/:version_id/restore', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const versionId = c.req.param('version_id')
  const supabase = createSupabaseClient(c.env)
  // A restore may name the version its page last saw (#1947); without one it is
  // made from the version read below, so a write landing during it is still caught.
  // No body, one that is not JSON, and one that is not an object (null, a list) all name no version.
  const parsed: unknown = await c.req.json().catch(() => null)
  const body = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as { expected_version?: unknown }
  const versionRefusal = expectedVersionRefusal(c, body.expected_version)
  if (versionRefusal) return versionRefusal

  // Verify ownership — the service-role key bypasses RLS, so without this an
  // org-B caller who knows an org-A (workflow_id, version_id) pair could
  // overwrite org A's live definition and insert into its version history.
  // 404 (not 403) to avoid leaking which workflow ids exist, matching siblings.
  const { data: owner, error: ownerError } = await supabase
    .from('workflows')
    .select('id, name, is_active, lane, version, definition')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()

  const ownerBlocked = dbErrorUnlessNotFound(c, ownerError)
  if (ownerBlocked) return ownerBlocked
  if (!owner) return c.json({ error: 'Workflow not found' }, 404)

  const { data: version, error: versionError } = await supabase
    .from('workflow_versions')
    .select('definition, version_number, definition_schema_version')
    .eq('id', versionId)
    .eq('workflow_id', id)
    .single()

  const blocked = dbErrorUnlessNotFound(c, versionError)
  if (blocked) return blocked
  if (!version) return c.json({ error: 'Version not found' }, 404)

  // A restored definition meets the lead validation rules (#2590): the placement
  // always, the configuration when the restore makes it live at once.
  const restoreProblem = leadValidationRefusal(version.definition, owner.is_active === true)
  if (restoreProblem) return c.json({ error: restoreProblem }, 400)
  if (owner.is_active === true) {
    const unfinished = unfinishedStepRefusal(c, version.definition, owner.lane, writtenDefinitionStamp())
    if (unfinished) return unfinished
  }

  // A restore onto a live workflow makes the old definition live at once (#2149).
  if (owner.is_active === true) {
    const unread = await unreadBuyerRuleRefusal(c, supabase, orgId, { id, name: owner.name, definition: version.definition })
    if (unread) return unread
  }

  // The old definition may name a connection removed since it was saved
  // (#2338): it stops here, before the snapshot, and asks for a replacement.
  const restored = sanitizeDefinition(version.definition)
  const missing = await connectionRefusal(c, supabase, orgId, restored)
  if (missing) return missing

  // A restored definition keeps the stamp its version row carries, unstamped
  // included (#1947): it was checked under those rules when it was saved, and
  // relabelling it with this build's version would claim a check it never had.
  // write_workflow reads that stamp from the version row itself and writes it
  // to the workflow row even when it is null, because the row may hold a newer
  // stamp from the save this restore replaces.
  const restoredStamp = copiedDefinitionStamp(version)

  // Report only (#1947): the old definition at the stamp it keeps, live if the
  // workflow is. A version a rule would refuse (a loop, the retired integration
  // step) is restored as before and named in the report.
  const report = reportDefinition(restored, { writer: 'restore', workflowId: id, lane: owner.lane, live: owner.is_active === true, schemaVersion: restoredStamp })

  // The new version and the row in one write_workflow call (#1947), so history
  // and definition cannot diverge (#588) and a refusal leaves neither.
  const result = await writeWorkflow(supabase, {
    op: 'restore',
    orgId,
    workflowId: id,
    expectedVersion: typeof body.expected_version === 'number' ? body.expected_version : owner.version,
    fields: { version_id: versionId, definition: restored, definition_report: report },
    saveId: null,
    actor: actorOf(c),
    // A restored step keeps its binder only where its connection is the one bound now (#2339).
    storedDefinition: owner.definition,
  })
  if (result.kind !== 'written') {
    return answerUnwritten(c, result, 'Not restored. This workflow was saved by someone else while it was being restored. Nothing was changed. Look at the latest version, then restore again if you still want to.')
  }
  const nextVersion = result.versionNumber

  const copyRefreshed = await copyCleared(async () => { await refreshWorkflowCaches(id, c.env.WORKFLOW_CACHE, supabase) }, `workflow ${id} caches`)
  await writeAuditLog(supabase, orgId, 'workflow', id, 'updated', userId, {
    restored_from_version: version.version_number,
    new_version: nextVersion,
  })

  return c.json({ ok: true, version_number: nextVersion, version: result.workflow.version, ...copyWarning(copyRefreshed) })
})

// POST /api/workflows/:id/test
workflows.post('/:id/test', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ payload: unknown; execution_id?: string; definition?: unknown }>()

  // Verify ownership
  const { data: owner, error: ownerError } = await supabase
    .from('workflows')
    .select('id, lane')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()

  const ownerBlocked = dbErrorUnlessNotFound(c, ownerError)
  if (ownerBlocked) return ownerBlocked
  if (!owner) return c.json({ error: 'Workflow not found' }, 404)
  // Another lane's workflow is refused before its test bundle is deployed here
  // (#1725); the engine refuses it again before running anything.
  const runtime = moneyRuntime(supabase)
  const laneBlocked = refuseRowOutsideLane(c, id, owner.lane, runtime.lane)
  if (laneBlocked) return laneBlocked

  // Deploy code nodes from the current (unsaved) definition to an ephemeral
  // content-hashed bundle so the test runs the EXACT canvas code, with no
  // dispatch-namespace update-propagation lag (a fixed name can serve the prior
  // bundle right after an upload). The bundle name is threaded to the engine so
  // code nodes dispatch to it; saved bundles are cleaned up on the next save.
  let testBundleName: string | null = null
  if (body.definition) {
    const dep = await deployTestCodeBundle(
      id,
      body.definition as WorkflowDefinition,
      c.env.CLOUDFLARE_ACCOUNT_ID,
      c.env.CLOUDFLARE_API_TOKEN,
      c.env.WORKFLOW_CACHE
    ).catch((e) => { console.error('[code-nodes] test deploy failed:', e); return { bundleName: null } })
    testBundleName = dep.bundleName
  }

  // The canvas test runner mints the execution id in the browser, because it needs
  // it before the run to open its realtime channel filter, so this is the one path
  // by which an id the engine did not generate reaches an execution. Every new id
  // must be a UUIDv7 or the archive's read path cannot derive a day from it and
  // prunes nothing (#869).
  //
  // Validated against the READER's own predicate rather than a looser shape check,
  // so this accepts exactly what `utcDayFromUuidV7` can consume (L150). And it
  // REFUSES rather than substituting an id of its own: a substitution would leave
  // the page listening on a channel for an id that no longer exists, so the run
  // would succeed with the panel sitting empty, which is a silent failure where a
  // refusal is a legible one (L10).
  if (body.execution_id !== undefined && !isUuidV7(String(body.execution_id))) {
    return c.json(
      {
        error:
          'This page is running an older build that generates execution ids the archive cannot index. Reload the page and run the test again.',
      },
      400
    )
  }

  let result: Awaited<ReturnType<typeof executeWorkflow>>
  try {
    result = await executeWorkflow(
      {
        workflowId: id,
        payload: body.payload,
        source: 'test_runner',
        // A canvas test posts a payload as a webhook would; recorded as it always was.
        triggerType: 'http_webhook',
        isTest: true,
        executionId: body.execution_id,
        ...(testBundleName ? { codeBundleName: testBundleName } : {}),
        ...(body.definition ? { definitionOverride: body.definition as import('../../types').WorkflowDefinition } : {}),
      },
      c.env,
      runtime,
      c.executionCtx
    )
  } catch (err) {
    // The engine's own lane refusals (#1725): the lane it loaded, or a step in
    // the unsaved definition the lane cannot run. Anything else is a defect and
    // goes to the generic handler.
    const refused = dashboardLaneRefusal(c, err)
    if (refused) return refused
    throw err
  }

  return c.json(result.response, result.status as 200 | 500, { 'X-Trace-Id': result.traceId })
})

// POST /api/workflows/:id/test-node — re-run a single node using context from a prior execution
workflows.post('/:id/test-node', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  // Verify ownership before deploying code or executing anything. Code bundles
  // are keyed by workflow id (deployCodeNodes), and the service-role key
  // bypasses RLS, so without this a cross-org caller could overwrite a victim
  // workflow's live code-node bundle with attacker-supplied script. The
  // execution_id path below only scopes the execution, not this workflow id.
  // 404 (not 403) to avoid leaking which ids exist, matching siblings.
  const { data: owner, error: ownerError } = await supabase
    .from('workflows')
    .select('id, lane')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()
  const ownerBlocked = dbErrorUnlessNotFound(c, ownerError)
  if (ownerBlocked) return ownerBlocked
  if (!owner) return c.json({ error: 'Workflow not found' }, 404)
  // An ops workflow's app_action step is tested on ops (#2339), which runs it
  // and keeps its result; this Worker runs and writes nothing for it.
  if (owner.lane === 'ops') {
    const raw: unknown = await c.req.json().catch(() => null)
    const opsBody = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const nodes = (opsBody.definition as { nodes?: unknown } | undefined)?.nodes
    const opsNode = Array.isArray(nodes)
      ? (nodes as Array<{ id?: unknown; namespace?: unknown; type?: unknown; config?: unknown }>).find((n) => n?.namespace === opsBody.namespace)
      : undefined
    if (opsNode?.type === 'app_action' && typeof opsNode.id === 'string' && typeof opsNode.namespace === 'string') {
      return testOpsStep(c, id, opsBody, { id: opsNode.id, namespace: opsNode.namespace, config: opsNode.config })
    }
  }
  // No engine runs around this node, so this is the only lane check it gets
  // (#1725): another lane's workflow is refused before its code is deployed or
  // any node of it runs, and the node runs through this Worker's lane executor.
  const runtime = moneyRuntime(supabase)
  const laneBlocked = refuseRowOutsideLane(c, id, owner.lane, runtime.lane)
  if (laneBlocked) return laneBlocked

  const body = await c.req.json<{
    namespace: string
    definition?: WorkflowDefinition
    execution_id?: string
    trigger_payload?: unknown
    steps?: Record<string, StepOutput>
  }>()

  // Build the execution context. Two modes:
  //  - Build from run: execution_id supplied → reconstruct the trigger payload
  //    and upstream step outputs from that execution.
  //  - Cold start: no execution_id → use the inline trigger_payload (and any
  //    inline steps), so a node that doesn't depend on upstream output can be
  //    tested without ever running the whole workflow.
  // Inline trigger_payload / steps always override, so a build-from-run context
  // can still be tweaked before re-testing.
  let triggerPayload: unknown = body.trigger_payload ?? {}
  let source = 'test_node'
  let traceId = crypto.randomUUID()
  const ctxSteps: Record<string, StepOutput> = {}

  if (body.execution_id) {
    // Scope to the workflow being tested (already org-verified above). The
    // execution must belong to this workflow; workflow_executions has no
    // organization_id column (it's org-scoped through workflow_id).
    const { data: exec, error: execError } = await supabase
      .from('workflow_executions')
      .select('trigger_payload, trace_id, source')
      .eq('id', body.execution_id)
      .eq('workflow_id', id)
      .single()
    if (execError && !isNotFoundError(execError)) return dbError(c, execError)
    if (!exec) return c.json({ error: 'Execution not found' }, 404)
    triggerPayload = body.trigger_payload ?? exec.trigger_payload
    source = (exec.source) ?? source
    traceId = (exec.trace_id) ?? traceId

    // paginate-ok .eq(execution_id): one execution's steps, used to rebuild the test-node context
    const { data: stepRows } = await supabase
      .from('execution_steps')
      .select('step_namespace, status, output, error_message, error_type')
      .eq('execution_id', body.execution_id)
    for (const row of stepRows ?? []) {
      ctxSteps[row.step_namespace] = {
        output: row.output,
        status: row.status as StepOutput['status'],
        error: row.error_message as string | undefined,
        error_type: row.error_type as StepOutput['error_type'],
      }
    }
  }
  // Inline step overrides (cold start, or tweaking a build-from-run context).
  if (body.steps) {
    for (const [ns, step] of Object.entries(body.steps)) ctxSteps[ns] = step
  }

  // Find the node definition
  const definition = body.definition
  if (!definition) return c.json({ error: 'definition is required' }, 400)
  const node = definition.nodes.find((n) => n.namespace === body.namespace)
  if (!node) return c.json({ error: 'Node not found in definition' }, 404)

  // Deploy code node from current (unsaved) definition — propagate errors
  // in the response so a silent upload failure doesn't leave the user re-running
  // stale code without feedback.
  let deployResult: { deployed: boolean; skipped: boolean; error?: string } = { deployed: false, skipped: false }
  if (node.type === 'code') {
    try {
      const results = await deployCodeNodes(id, definition, c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN, c.env.WORKFLOW_CACHE)
      const failed = results.find((r) => r.error)
      if (failed?.error) {
        deployResult = { deployed: false, skipped: false, error: failed.error }
        return c.json({ output: null, status: 'failed', error_message: `Code deploy failed: ${failed.error}`, duration_ms: 0, deploy: deployResult }, 500)
      }
      // deployCodeNodes returns [] when nothing to deploy; non-empty means it
      // ran. Distinguish skip vs. actual upload by looking at logs — but for
      // the response, both are "ok, new code is live" from the caller's POV.
      deployResult = { deployed: results.length > 0, skipped: false }
    } catch (e) {
      const msg = formatErr(e)
      console.error('[code-nodes] test-node deploy threw:', e)
      return c.json({ output: null, status: 'failed', error_message: `Code deploy threw: ${msg}`, duration_ms: 0, deploy: { deployed: false, skipped: false, error: msg } }, 500)
    }
  }

  // Reconstruct execution context
  // This workflow's own values over the org ones, as its runs get them (#1681).
  const envVars = await loadEnvVars(orgId, c.env.WORKFLOW_CACHE, supabase, secretKeys(c.env), { workflowId: id })
  const ctx = buildContext(triggerPayload, source, id, traceId, envVars, orgId, body.execution_id, c.env.APP_URL)
  ctx.steps = ctxSteps

  const started = Date.now()
  try {
    // branch_end passes through its chain's preceding step. The engine supplies
    // that from the walk; here the rebuilt ctx.steps IS the chain (one prior
    // execution, in order), so its last entry is the equivalent (#489).
    const chainOutput = Object.values(ctx.steps).at(-1)?.output ?? null
    const result = await nodeExecutorForLane(runtime.lane)(node, ctx, c.env, supabase, undefined, chainOutput)
    // Mirror the engine's sentinel-failed check (engine/index.ts:825): a code
    // node that returns { response: { status: 4xx/5xx } } is signaling its own
    // failure. Without this, Re-run shows green for error responses.
    const respStatus = result.earlyResponse?.status
    const sentinelFailed = respStatus !== undefined && respStatus >= 400 && !result.expected
    if (sentinelFailed) {
      return c.json({ output: result.output, status: 'failed', error_message: formatCodeErrorMessage(respStatus, result.earlyResponse?.body), duration_ms: Date.now() - started, deploy: deployResult })
    }
    return c.json({ output: result.output, status: 'completed', error_message: null, duration_ms: Date.now() - started, deploy: deployResult })
  } catch (e) {
    const msg = formatErr(e)
    return c.json({ output: null, status: 'failed', error_message: msg, duration_ms: Date.now() - started, deploy: deployResult })
  }
})

// GET /api/workflows/:id/test-results/:nodeId: an ops workflow step's kept test
// result, read from ops for the data picker (#2339). Null once none is under 7
// days old, so the picker asks for a fresh test.
workflows.get('/:id/test-results/:nodeId', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)
  const { data: owner, error: ownerError } = await supabase
    .from('workflows')
    .select('id, lane')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()
  const ownerBlocked = dbErrorUnlessNotFound(c, ownerError)
  if (ownerBlocked) return ownerBlocked
  if (!owner) return c.json({ error: 'Workflow not found' }, 404)
  if (owner.lane !== 'ops') {
    return c.json({ error: 'step_test_results_ops_only', message: 'Only an ops workflow keeps its steps\' test results. Test the step to see its output.' }, 422)
  }
  return readOpsStepTest(c, id, c.req.param('nodeId'))
})

// ─── Step ID rename ──────────────────────────────────────────────────────────
//
// When a user renames a node's namespace on the canvas, downstream references
// in other nodes (`steps.OLD.foo`) need to follow. Canvas-local references are
// rewritten client-side. Partner bid formulas live in `partner_configs` and
// are shared across workflows — these endpoints handle the cross-workflow
// safety check and the actual formula rewrite.
//
// GET  rename-impact: report which partner formulas would be affected, and
//                     which of them are shared with OTHER workflows in the org
//                     (those get flagged as unsafe-to-rewrite).
// POST rename-apply:  rewrite the formulas the caller opts into. Caller is
//                     expected to call this only after the workflow save
//                     succeeds, so the canvas and DB stay in sync.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countStepsRefs(haystack: string | null | undefined, ns: string): number {
  if (!haystack) return 0
  const matches = haystack.match(new RegExp(`\\bsteps\\.${escapeRegex(ns)}\\b`, 'g'))
  return matches ? matches.length : 0
}

function rewriteStepsRefs(haystack: string | null | undefined, oldNs: string, newNs: string): string | null {
  if (!haystack) return haystack ?? null
  return haystack.replace(new RegExp(`\\bsteps\\.${escapeRegex(oldNs)}\\b`, 'g'), `steps.${newNs}`)
}

interface PartnerForRename {
  id: string
  name: string
  slug: string
  bid_formula: string | null
  bid_resolver_config: Record<string, unknown> | null
}

function isValidNamespace(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)
}

// GET /api/workflows/:id/rename-impact?old=foo&new=bar
workflows.get('/:id/rename-impact', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const oldNs = c.req.query('old')
  const newNs = c.req.query('new')
  const supabase = createSupabaseClient(c.env)

  if (!isValidNamespace(oldNs) || !isValidNamespace(newNs)) {
    return c.json({ error: 'old and new must be valid namespaces' }, 400)
  }
  if (oldNs === newNs) {
    return c.json({ partner_formulas: [] })
  }

  const { data: owner, error: ownError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()
  const ownBlocked = dbErrorUnlessNotFound(c, ownError)
  if (ownBlocked) return ownBlocked
  if (!owner) return c.json({ error: 'Workflow not found' }, 404)

  // Every partner of the org, read whole or refused (#1437): a partner past a
  // cut list would be renamed under this workflow without being shown here.
  let partners: PartnerForRename[]
  try {
    partners = await fetchUpTo<PartnerForRename>((limit) => supabase
      .from('partner_configs')
      .select('id, name, slug, bid_formula, bid_resolver_config')
      .eq('organization_id', orgId)
      .limit(limit), CONFIG_LIST_BOUNDS.partnerConfigs, 'partners for rename impact')
  } catch (err) {
    return dbError(c, err)
  }

  const affected: PartnerForRename[] = []
  for (const p of partners) {
    const resolverFormula =
      p.bid_resolver_config && typeof (p.bid_resolver_config).formula === 'string'
        ? ((p.bid_resolver_config).formula)
        : null
    const refs = countStepsRefs(p.bid_formula, oldNs) + countStepsRefs(resolverFormula, oldNs)
    if (refs > 0) affected.push(p)
  }

  if (affected.length === 0) return c.json({ partner_formulas: [] })

  // For each affected partner, find OTHER workflows in the same org that name
  // it (a partner_bid, bid_group, click node, or buyer_select priced for it). A
  // formula rewrite made for this workflow could silently break any of them, so
  // we surface them to the user and (by default) skip the rewrite.
  let otherWorkflows
  try {
    otherWorkflows = await readOrgWorkflows(supabase, orgId, { excludeId: id })
  } catch (err) {
    return dbError(c, err)
  }

  // A buyer_select node names no partner in its config: the decision recorded on
  // the plan (#1411) is that a workflow containing one uses every partner holding
  // an enabled profile priced for that node's population. The snapshot is read
  // once, only when some other workflow carries the node, and a read that fails
  // refuses the whole answer rather than reporting a partner as unshared (L98).
  // The finder itself is shared with the buyer profile route (#1412, L613).
  const others = otherWorkflows
  let pricedPartners: Map<string, Set<string>>
  try {
    pricedPartners = await pricedPartnersByPopulation(others, () => loadBuyerProfiles(orgId, c.env.WORKFLOW_CACHE, supabase))
  } catch (err) {
    console.error(`[workflows] rename impact could not read buyer profiles for org ${orgId}: ${err instanceof Error ? err.message : 'non Error thrown'}`)
    return c.json({ error: 'Buyer profiles could not be read, so which workflows share these partners cannot be determined. Try again.' }, 503)
  }
  // A Latency Gate in another workflow never reads the formula rewritten here (#2251).
  const workflowsUsingPartner = workflowsUsingPartnerShared(others, pricedPartners, { includeBuyerSelect: true, includeClickNodes: true, includeLatencyGates: false })

  const partner_formulas = affected.map((p) => {
    const resolverFormula =
      p.bid_resolver_config && typeof (p.bid_resolver_config).formula === 'string'
        ? ((p.bid_resolver_config).formula)
        : null
    const formulaPreview = resolverFormula ?? p.bid_formula ?? ''
    const shared = workflowsUsingPartner(p.id)
    return {
      partner_id: p.id,
      partner_name: p.name,
      partner_slug: p.slug,
      references: countStepsRefs(p.bid_formula, oldNs) + countStepsRefs(resolverFormula, oldNs),
      formula_preview: formulaPreview.length > 120 ? formulaPreview.slice(0, 120) + '…' : formulaPreview,
      shared_with_workflows: shared,
      can_rewrite: shared.length === 0,
    }
  })

  return c.json({ partner_formulas })
})

// POST /api/workflows/:id/rename-apply
// Body: { old: string, new: string, partner_ids: string[] }
// Rewrites `steps.OLD.…` → `steps.NEW.…` in each listed partner's bid_formula
// and bid_resolver_config.formula. Caller is responsible for filtering out
// cross-workflow-shared partners using the rename-impact response.
// It writes partner formulas only, never a workflow definition (the canvas
// saves the renamed definition through PUT /:id, which checks its connections,
// #2338), and a namespace cannot hold a connection id (isValidNamespace allows
// no hyphen), so it asks no connection check.
workflows.post('/:id/rename-apply', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ old?: unknown; new?: unknown; partner_ids?: unknown }>()

  if (!isValidNamespace(body.old) || !isValidNamespace(body.new)) {
    return c.json({ error: 'old and new must be valid namespaces' }, 400)
  }
  const oldNs = body.old
  const newNs = body.new
  if (oldNs === newNs) return c.json({ updated: 0 })

  if (!Array.isArray(body.partner_ids) || body.partner_ids.some((x) => typeof x !== 'string')) {
    return c.json({ error: 'partner_ids must be an array of strings' }, 400)
  }
  const partnerIds = body.partner_ids as string[]
  if (partnerIds.length === 0) return c.json({ updated: 0 })
  // The ids come straight from the body, so their number is bounded here, before
  // anything is read: an org holds at most this many partners, and a read of more
  // would come back cut at the row cap and rename only some of them (#1437).
  if (partnerIds.length > CONFIG_LIST_BOUNDS.partnerConfigs) {
    return c.json({ error: `partner_ids may name at most ${CONFIG_LIST_BOUNDS.partnerConfigs} partners` }, 400)
  }

  const { data: owner, error: ownError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()
  const ownBlocked = dbErrorUnlessNotFound(c, ownError)
  if (ownBlocked) return ownBlocked
  if (!owner) return c.json({ error: 'Workflow not found' }, 404)

  let partners: PartnerForRename[]
  try {
    partners = await fetchUpTo<PartnerForRename>((limit) => supabase
      .from('partner_configs')
      .select('id, name, slug, bid_formula, bid_resolver_config')
      .eq('organization_id', orgId)
      .in('id', partnerIds)
      .limit(limit), CONFIG_LIST_BOUNDS.partnerConfigs, 'partners to rename')
  } catch (err) {
    return dbError(c, err)
  }

  let updated = 0

  const notCleared: string[] = []
  for (const p of partners) {
    const nextLegacy = rewriteStepsRefs(p.bid_formula, oldNs, newNs)
    const cfg = (p.bid_resolver_config ?? {})
    const cfgFormula = typeof cfg.formula === 'string' ? cfg.formula : null
    const nextCfgFormula = rewriteStepsRefs(cfgFormula, oldNs, newNs)
    const cfgChanged = cfgFormula !== null && nextCfgFormula !== cfgFormula
    const legacyChanged = nextLegacy !== p.bid_formula
    if (!cfgChanged && !legacyChanged) continue

    const columns: { bid_formula?: string | null; bid_resolver_config?: Record<string, unknown> } = {}
    if (legacyChanged) columns.bid_formula = nextLegacy
    if (cfgChanged) columns.bid_resolver_config = { ...cfg, formula: nextCfgFormula }

    // The rewrite goes through rename_partner_step_namespace (#1409), so the
    // audit row the table trigger writes carries the actor, the reason and the
    // workflow. The function returns the rows it touched: a partner deleted
    // between the SELECT above and this write comes back as 0, and aborting a
    // bulk rename over one vanished partner is worse than skipping it, but it
    // must not be counted as renamed (#588). A real database error still aborts.
    const { data: touched, error: upErr } = await supabase.rpc('rename_partner_step_namespace', {
      p_org: orgId,
      p_partner: p.id,
      p_columns: columns as never,
      p_actor: userId,
      p_actor_email: c.get('user').email,
      p_context: { reason: 'step_id_renamed', workflow_id: id, old_namespace: oldNs, new_namespace: newNs } as never,
    })
    if (upErr) return dbError(c, upErr)
    if (!touched || Number(touched) === 0) {
      // The same event line requireRowsAffected logs for a zero row write, so the
      // partner rename keeps showing up wherever those are counted.
      console.warn(JSON.stringify({
        event: 'zero_row_write',
        target: 'partner_configs.step_id_rename',
        message: 'rename_partner_step_namespace touched no row',
        partner_id: p.id,
        workflow_id: id,
      }))
      continue
    }
    updated += 1
    // The Partner Bid node's stored copy of this partner still carries the old
    // formula; retire it so an outage never bids with a formula that is gone
    // (#1846). A refusal is collected rather than thrown, so the partners after
    // it are still rewritten and the answer names exactly which copies remain.
    // Applying the rename again finds nothing left to rewrite, so the sweep is
    // what repairs those copies.
    if (!(await copyCleared(() => retirePartnerLastGood(c.env.WORKFLOW_CACHE, p.id), `partner copy ${p.id} after the rename`))) notCleared.push(p.id)
  }

  if (notCleared.length > 0) return c.json({ updated, copies_not_cleared: notCleared, ...copyWarning(false) })
  return c.json({ updated })
})

export default workflows
