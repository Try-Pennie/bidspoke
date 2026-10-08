/**
 * Reduced finalize of stranded workflow_executions rows.
 *
 * Same root cause as the lead_sightings strand (#353 / #343 / #309): the
 * execution-record finalize write in engine/index.ts (status, completed_at,
 * duration_ms) runs in a post-response ctx.waitUntil, fire-and-forget, so the
 * Worker isolate can be evicted before it lands. The row is then stuck at
 * status='running' forever -- it is never purged (purge only targets terminal
 * statuses), so it silently accumulates and pollutes anything that reads
 * "still running" as "still in flight" (e.g. slow-execution-rate.ts, which
 * counts a stranded row's ever-growing elapsed time as a slow run).
 *
 * This does NOT guess 'completed' from execution_steps evidence alone. A first
 * attempt at that (a pg_cron SQL function, reverted same day) assumed every
 * workflow signals "response sent" with a dedicated 'response'/'exit' step --
 * false for Engine Bidding Workflow (the majority of stranded rows), which
 * sends its response from inside a Code node's own script (an early
 * $.respond()-style sentinel), logged with step_type='code' like any other
 * code step. There is no reliable, workflow-agnostic signal in execution_steps
 * alone that distinguishes "the walk finished" from "the walk was cut off here
 * mid-graph" -- so guessing 'completed' from step types risks overstating
 * success on a run that never actually served the lead.
 *
 * There IS one precise, workflow-agnostic signal though (#571): the workflow
 * graph itself. If a step that finished at the run's final instant landed on a
 * node with zero outgoing edges (a true graph dead end that exists in the
 * definition), the walk ran to the end of the graph rather than being cut off
 * mid-flight -- real evidence of completion. resolveStrandedExecution uses that
 * when a StrandGraph is supplied (built once per workflow_version and cached
 * across rows) to honestly claim 'completed'.
 *
 * When the graph cannot confirm -- the normal case for a workflow that answers
 * from inside a code node rather than a terminal node -- it falls back to the
 * outcome the engine itself recorded on lead_sightings (#1112), a verdict rather
 * than an inference, and only then to the conservative unresolved label below.
 *
 * Otherwise this mirrors finalize_unrecoverable_stranded's "label honestly,
 * don't guess" precedent: only claim 'failed' with real evidence (a step that
 * actually failed); everything else is honestly marked unresolved rather than
 * masqueraded as either outcome. completed_at is always reconstructed from
 * real step history (or falls back to started_at) -- never `now()` -- so a
 * bulk catch-up run doesn't make a backlog of days-old executions look like
 * they all just failed simultaneously, which upstream-outage.ts and
 * failure-rate.ts window on completed_at and would page on as a false spike.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { WorkflowDefinition } from '../types'
import { isNoRowMatchedError, requireRowsAffected } from './db-retry'
import { formatErr } from './format-error'
import type { AnswerJournal } from '../engine/unconfirmed-writes'

export const MIN_AGE_MINUTES = 30
export const LOOKBACK_DAYS = 14
export const MAX_PER_RUN = 300

export interface StrandStepEvidence {
  status: string
  step_type: string | null
  error_message: string | null
  completed_at: string | null
  step_node_id?: string | null
  step_namespace?: string | null
}

export interface ResolvedStrand {
  status: 'failed' | 'completed'
  outcome: 'successful' | 'completed' | 'failed' | null
  completed_at: string
  duration_ms: number
  error_message: string | null
  failed_step_type: string | null
}

/**
 * Graph analysis of a workflow_version's definition, precomputed once per
 * version and reused across every stranded execution that shares it (#571).
 * `outgoingEdgeCount` maps a node id to how many edges leave it; a node id that
 * exists in `nodeIds` with a count of zero is a true graph dead end -- reaching
 * and completing it means the walk finished naturally, not that it was cut off.
 */
export interface StrandGraph {
  nodeIds: Set<string>
  outgoingEdgeCount: Map<string, number>
  successNamespaces: string[]
}

export function buildStrandGraph(definition: WorkflowDefinition): StrandGraph {
  const nodeIds = new Set<string>()
  for (const node of definition.nodes ?? []) nodeIds.add(node.id)

  const outgoingEdgeCount = new Map<string, number>()
  for (const edge of definition.edges ?? []) {
    outgoingEdgeCount.set(edge.source, (outgoingEdgeCount.get(edge.source) ?? 0) + 1)
  }

  return {
    nodeIds,
    outgoingEdgeCount,
    successNamespaces: definition.trigger?.config?.success_node_namespaces ?? [],
  }
}

// "Isolate evicted" was the cause assumed when this was written. Measured on
// 2026-10-08 (#1883), the strands of a database stall were Cloudflare cancelling
// the work after the answer 30 s after it, with the isolate alive, so the label
// names what is known: that work stopped before finalize.
const UNRESOLVED_MESSAGE =
  '[recovered] execution stranded: the work after the answer was cancelled before finalize, outcome could not be confirmed'
const FAILED_NO_MESSAGE_FALLBACK = '[recovered] execution stranded after a failed step'
// Distinct from FAILED_NO_MESSAGE_FALLBACK: that one had a failed STEP naming the
// node, this one has only the engine's recorded verdict and no failing step to
// point at, so the two must not share a message (LESSONS L11).
const SIGHTING_FAILED_MESSAGE =
  '[recovered] execution stranded: no failed step recorded, the lead sighting reported outcome=failed'

/**
 * The engine's OWN verdict for this run, recorded independently of the finalize
 * write that eviction destroys (#1112). lead_sightings is written at the trigger
 * boundary and finalized in its own waitUntil block, so it routinely survives
 * when workflow_executions.sighting_finalize does not (that projection rides in
 * the lost UPDATE, and is null on every stranded row).
 *
 * A null `outcome` means the sighting's own finalize was lost too. That is
 * missing evidence, not a verdict, and must not be read as one.
 */
export interface StrandSightingEvidence {
  outcome: string | null
}

// lead_sightings.outcome is a plain text column, so it can hold anything. Only
// the three values the engine actually writes are a verdict this code can act
// on; anything else is unreadable evidence, not a lean in either direction, and
// is treated as absent (LESSONS L257).
const KNOWN_OUTCOMES = ['successful', 'completed', 'failed'] as const
type KnownOutcome = (typeof KNOWN_OUTCOMES)[number]

function asKnownOutcome(value: string | null | undefined): KnownOutcome | null {
  return KNOWN_OUTCOMES.includes(value as KnownOutcome) ? (value as KnownOutcome) : null
}

export function resolveStrandedExecution(
  steps: StrandStepEvidence[],
  startedAtIso: string,
  graph?: StrandGraph,
  sighting?: StrandSightingEvidence | null
): ResolvedStrand {
  const startedAtMs = new Date(startedAtIso).getTime()

  // Only the LAST step chronologically decides this -- an earlier failure
  // followed by a later completed step means an on_error/fallback_node path
  // recovered and the walk kept going, so an earlier failure is not proof the
  // execution ultimately failed. Only claim 'failed' when failure is what the
  // walk actually stopped on.
  const stepsWithCompletion = [...steps]
    .filter((s) => s.completed_at != null)
    .sort((a, b) => new Date(b.completed_at as string).getTime() - new Date(a.completed_at as string).getTime())

  // Every step that finished at the final instant, not one arbitrary winner
  // (#1112). Two steps completing in the same millisecond is routine here, the
  // read that produced this list carries no inherent order (L343), and a sort
  // leaves tied elements in whatever order they arrived. Taking [0] therefore
  // picked at random among them, which is why the dead-end branch below had
  // never once fired across 117 recovered rows: on the real Engine workflow the
  // branch_end and the salesforce step both stamp the same millisecond, and the
  // salesforce step (which has an outgoing edge) kept winning the coin flip.
  const lastCompletedAt = stepsWithCompletion[0]?.completed_at ?? null
  const finalSteps =
    lastCompletedAt === null ? [] : stepsWithCompletion.filter((s) => s.completed_at === lastCompletedAt)

  // A failure among the tied steps outranks a dead end reached in the same
  // instant, so a tie can never upgrade a failed walk into a clean completion.
  const failedStep = finalSteps.find((s) => s.status === 'failed')
  if (failedStep) {
    const completedAtIso = failedStep.completed_at ?? startedAtIso
    return {
      status: 'failed',
      outcome: 'failed',
      completed_at: completedAtIso,
      duration_ms: Math.max(0, new Date(completedAtIso).getTime() - startedAtMs),
      error_message: failedStep.error_message ?? FAILED_NO_MESSAGE_FALLBACK,
      failed_step_type: failedStep.step_type,
    }
  }

  const completedAtIso = lastCompletedAt ?? startedAtIso

  // Graph-confirmed completion (#571): if any step that finished at the final
  // instant landed on a node that exists in the definition and has zero outgoing
  // edges, the walk reached a true dead end -- it ran to the end of the graph, it
  // wasn't cut off mid-flight. That is real evidence of completion, so we can
  // honestly claim 'completed' instead of the conservative unresolved label. The
  // node-id existence guard matters: a node id absent from the definition also
  // has zero outgoing edges, but that is missing evidence, not a dead end, so it
  // must not read as a false completion.
  const deadEndStep = graph
    ? finalSteps.find((s) => {
        const nodeId = s.step_node_id
        return nodeId != null && graph.nodeIds.has(nodeId) && (graph.outgoingEdgeCount.get(nodeId) ?? 0) === 0
      })
    : undefined
  if (graph && deadEndStep) {
    // Mirror the engine's own outcome attribution: 'successful' if the walk
    // passed through a configured success node, else 'completed'.
    const passedThroughSuccessNode = graph.successNamespaces.some((ns) =>
      steps.some((s) => s.step_namespace === ns && s.status === 'completed')
    )
    return {
      status: 'completed',
      outcome: passedThroughSuccessNode ? 'successful' : 'completed',
      completed_at: completedAtIso,
      duration_ms: Math.max(0, new Date(completedAtIso).getTime() - startedAtMs),
      error_message: null,
      failed_step_type: null,
    }
  }

  // The graph could not confirm, which is the normal case for a workflow that
  // answers from inside a code node rather than from a terminal node. Fall back
  // to the outcome the engine itself recorded on the sighting (#1112), which is
  // a verdict rather than an inference. Only a non-null outcome counts.
  const sightingOutcome = asKnownOutcome(sighting?.outcome)
  if (sightingOutcome !== null) {
    const failed = sightingOutcome === 'failed'
    return {
      status: failed ? 'failed' : 'completed',
      outcome: sightingOutcome,
      completed_at: completedAtIso,
      duration_ms: Math.max(0, new Date(completedAtIso).getTime() - startedAtMs),
      error_message: failed ? SIGHTING_FAILED_MESSAGE : null,
      failed_step_type: null,
    }
  }

  return {
    status: 'failed',
    outcome: null,
    completed_at: completedAtIso,
    duration_ms: Math.max(0, new Date(completedAtIso).getTime() - startedAtMs),
    error_message: UNRESOLVED_MESSAGE,
    failed_step_type: null,
  }
}

export interface ReduceFinalizeResult {
  processed: number
  errors: number
  /** Rows that vanished between the scan and the update (purged mid-run). Not repairs, not errors. */
  vanished: number
}

/**
 * Loads a workflow_version's definition and builds its StrandGraph. Returns null
 * when the definition can't be loaded (missing version, DB error, or malformed
 * definition) -- graph confirmation is a best-effort precision boost, so a
 * failure here just falls back to the honest-unresolved labeling rather than
 * failing the row.
 */
async function loadStrandGraph(supabase: SupabaseClient, versionId: string): Promise<StrandGraph | null> {
  const { data, error } = await supabase
    .from('workflow_versions')
    .select('definition')
    .eq('id', versionId)
    .maybeSingle()

  if (error || !data?.definition) {
    if (error) console.warn('[stranded-executions] version definition lookup failed', { versionId, error })
    return null
  }
  try {
    return buildStrandGraph(data.definition as unknown as WorkflowDefinition)
  } catch (e) {
    console.warn('[stranded-executions] malformed definition, skipping graph confirmation', { versionId, error: formatErr(e) })
    return null
  }
}

/**
 * Would the sighting change the answer? Only when the cheap evidence already in
 * hand cannot settle the row, so a run the graph confirms costs no extra read.
 * Deliberately asks resolveStrandedExecution itself rather than reimplementing
 * its precedence beside it, which would be a second copy of the rule that drifts
 * the first time the precedence changes (LESSONS L370).
 */
function needsSightingEvidence(
  steps: StrandStepEvidence[],
  startedAtIso: string,
  graph?: StrandGraph,
): boolean {
  return resolveStrandedExecution(steps, startedAtIso, graph).error_message === UNRESOLVED_MESSAGE
}

/**
 * Reads the engine's own recorded outcome for a stranded run (#1112). Scoped by
 * the partition key as well as the execution id: lead_sightings is partitioned
 * monthly on execution_started_at_utc, and a read without it scans every
 * partition.
 *
 * Returns null on any failure or absence, which the resolver treats as missing
 * evidence rather than a verdict.
 */
async function loadSightingOutcome(
  supabase: SupabaseClient,
  executionId: string,
  startedAt: string,
): Promise<StrandSightingEvidence | null> {
  const { data, error } = await supabase
    .from('lead_sightings')
    .select('outcome')
    .eq('execution_id', executionId)
    .eq('execution_started_at_utc', startedAt)
    .maybeSingle()

  if (error) {
    console.warn('[stranded-executions] sighting lookup failed', { executionId, error })
    return null
  }
  if (!data) return null
  return { outcome: (data as { outcome: string | null }).outcome ?? null }
}

export interface ReduceFinalizeOptions {
  /**
   * The run's answer journal (#1883): what the engine answered, written to KV at
   * the answer. A stranded run that has one is restored from it, since it is
   * the engine's own record and every other source here is inference.
   */
  readJournal?: (executionId: string) => Promise<AnswerJournal | null>
}

/** The journal, or null when there is none, it is another run's, or it cannot be read. */
async function journalFor(options: ReduceFinalizeOptions, executionId: string): Promise<AnswerJournal | null> {
  if (!options.readJournal) return null
  try {
    const j = await options.readJournal(executionId)
    return j && j.execution_id === executionId ? j : null
  } catch (e) {
    console.warn('[stranded-executions] answer journal unreadable, using the step evidence', { executionId, error: formatErr(e) })
    return null
  }
}

/**
 * Finds workflow_executions rows stuck at status='running' past MIN_AGE_MINUTES
 * and finalizes them via resolveStrandedExecution. Bounded to MAX_PER_RUN per
 * invocation (matches the bounded-per-call pattern used elsewhere, e.g. the
 * sightings admin backfill) -- a large backlog catches up over a few runs
 * rather than risking one invocation's CPU/time budget.
 */
export async function runReduceFinalizeStrandedExecutions(
  supabase: SupabaseClient,
  options: ReduceFinalizeOptions = {},
): Promise<ReduceFinalizeResult> {
  const now = Date.now()
  const ageFloor = new Date(now - MIN_AGE_MINUTES * 60_000).toISOString()
  const lookbackStart = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString()

  const { data: stranded, error: strandedErr } = await supabase
    .from('workflow_executions')
    .select('id, started_at, workflow_version_id')
    .eq('status', 'running')
    .lt('started_at', ageFloor)
    .gte('started_at', lookbackStart)
    .order('started_at', { ascending: true })
    .limit(MAX_PER_RUN)

  if (strandedErr) {
    console.error('[stranded-executions] scan failed', strandedErr)
    return { processed: 0, errors: 1, vanished: 0 }
  }
  if (!stranded?.length) return { processed: 0, errors: 0, vanished: 0 }

  let processed = 0
  let errors = 0
  let vanished = 0
  // Definitions are fetched at most once per workflow_version_id -- the strand
  // backlog is dominated by a handful of high-volume workflows (822 of the
  // first 1094 rows were one workflow), so many rows share a version. A null
  // cache entry records a version we already tried and could not load, so we
  // don't re-fetch it per row.
  const graphCache = new Map<string, StrandGraph | null>()
  let fromJournal = 0
  // A journal restore that matched no row: the run's own finalize reached it
  // first (the restore only takes a row still at running). Not a purge.
  let superseded = 0

  for (const exec of stranded) {
    const journal = await journalFor(options, exec.id as string)
    if (journal) {
      // What the run actually answered, as the engine recorded it at the answer.
      const { rows, error: journalUpdateErr } = await requireRowsAffected(
        'workflow_executions.strand_repair',
        () =>
          supabase
            .from('workflow_executions')
            .update({
              status: journal.status,
              outcome: journal.outcome,
              completed_at: journal.completed_at,
              duration_ms: journal.duration_ms,
              response_status: journal.response_status,
              response_body: journal.response_body,
              final_node_namespace: journal.final_node_namespace,
              final_node_id: journal.final_node_id,
              error_message: journal.error_message,
              failed_step_type: journal.failed_step_type,
              // The rest of the finalize, when the journal carries it: the sighting
              // drain finalizes a stranded sighting from sighting_finalize.
              ...(journal.sighting_finalize !== undefined ? { sighting_finalize: journal.sighting_finalize } : {}),
              ...(journal.cost_usd !== undefined ? { cost_usd: journal.cost_usd } : {}),
              ...(journal.field_presence !== undefined ? { field_presence: journal.field_presence } : {}),
              ...(journal.email_dropped ? { email_dropped: true } : {}),
            })
            .eq('id', exec.id as string)
            // Its own partition, and only while still at running: the run's own
            // finalize can land after the scan read it, and must not be overwritten.
            .eq('started_at', exec.started_at as string)
            .eq('status', 'running')
            .select('id'),
        { onMiss: 'warn', context: { id: exec.id } },
      )
      if (journalUpdateErr && !isNoRowMatchedError(journalUpdateErr)) {
        console.error('[stranded-executions] update failed', { id: exec.id, error: journalUpdateErr })
        errors++
      } else if (rows.length === 0) {
        superseded++
      } else {
        processed++
        fromJournal++
      }
      continue
    }

    const versionId = exec.workflow_version_id as string | null
    let graph: StrandGraph | undefined
    if (versionId) {
      if (!graphCache.has(versionId)) {
        graphCache.set(versionId, await loadStrandGraph(supabase, versionId))
      }
      graph = graphCache.get(versionId) ?? undefined
    }

    // A single execution's own step count is bounded by the workflow graph
    // (tens, not thousands) -- .limit matches PostgREST's own row cap as a
    // defensive ceiling rather than relying on that alone.
    const { data: steps, error: stepsErr } = await supabase
      .from('execution_steps')
      .select('status, step_type, error_message, completed_at, step_node_id, step_namespace')
      .eq('execution_id', exec.id as string)
      .gte('execution_started_at', lookbackStart)
      // Newest first, for two reasons (#1112). A read with no ORDER BY returns
      // rows in whatever order the store chose (L343), and steps that share a
      // completed_at then reached the resolver in an arbitrary order, which is
      // what let a mid-graph step beat a dead end and mislabel 119 runs. And
      // because this read is capped, descending keeps the END of the run, which
      // is where every piece of evidence the resolver uses lives.
      .order('completed_at', { ascending: false })
      .limit(1000)

    if (stepsErr) {
      console.error('[stranded-executions] step lookup failed', { id: exec.id, error: stepsErr })
      errors++
      continue
    }

    const stepEvidence = (steps ?? []) as StrandStepEvidence[]
    // The sighting read is a precision boost of last resort, so it is spent only
    // when the cheaper evidence already on hand cannot settle the row. Like the
    // graph load above, a failure here degrades to the honest unresolved label
    // rather than erroring the row.
    const sighting = needsSightingEvidence(stepEvidence, exec.started_at as string, graph)
      ? await loadSightingOutcome(supabase, exec.id as string, exec.started_at as string)
      : null

    const resolved = resolveStrandedExecution(stepEvidence, exec.started_at as string, graph, sighting)
    // onMiss 'warn': a zero-row match here is benign, not an error. The nightly
    // partition purge can drop the row between the scan and this update. It is
    // simply not a repair, so it must not be counted as one (#583).
    const { rows, error: updateErr } = await requireRowsAffected(
      'workflow_executions.strand_repair',
      () =>
        supabase
          .from('workflow_executions')
          .update({
            status: resolved.status,
            outcome: resolved.outcome,
            completed_at: resolved.completed_at,
            duration_ms: resolved.duration_ms,
            error_message: resolved.error_message,
            failed_step_type: resolved.failed_step_type,
          })
          .eq('id', exec.id as string)
          .select('id'),
      { onMiss: 'warn', context: { id: exec.id } },
    )

    if (updateErr && !isNoRowMatchedError(updateErr)) {
      console.error('[stranded-executions] update failed', { id: exec.id, error: updateErr })
      errors++
    } else if (rows.length === 0) {
      vanished++
    } else {
      processed++
    }
  }

  console.log(
    `[stranded-executions] processed=${processed} from_journal=${fromJournal} superseded=${superseded} errors=${errors} vanished=${vanished} scanned=${stranded.length}`
  )
  return { processed, errors, vanished }
}
