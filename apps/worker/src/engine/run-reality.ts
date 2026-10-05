/**
 * What kind of run this is, decided in one place (#1708, plan 0.D, R11).
 *
 * Three inputs say it: the test flag (a canvas Test Runner run, or a shadow run,
 * which the shadow route also marks as a test), the shadow mode (`dry_run` stubs
 * every outbound submission, `stand_in` answers partner bids from a stand-in),
 * and LOCAL_DEV (a laptop `wrangler dev` pointed at production data). Every
 * engine conclusion drawn from them is derived here, and a scan
 * (apps/web/src/lib/__guards__/worker/run-reality-one-reader.test.ts) fails on a
 * read of any of them elsewhere in the engine, so the answer cannot drift
 * between call sites again.
 *
 * A canvas test run is otherwise LIVE: it makes its real outbound calls (Dan,
 * 2026-10-02). Where a node must behave differently on a test run, the
 * difference is a named `testRunException` in NODE_TRAITS with its reason.
 */
import { NODE_TRAITS, isNodeType, type NodeType } from '@bidspoke/node-types'
import type { ExecutionContext, WorkflowDefinition } from '../types'

export type ShadowMode = NonNullable<ExecutionContext['shadow_mode']>

export interface RunInput {
  isTest?: boolean
  shadowMode?: ShadowMode
  /** env.LOCAL_DEV as it arrives: any truthy value means a local run. */
  localDev?: unknown
}

export interface RunReality {
  /** Marked as a test: written on the execution row, kept out of sightings, idempotency and alerts. */
  isTest: boolean
  /** Running from a laptop against production data. */
  localDev: boolean
  /** A shadow run: no outbound submission fires; each sending node returns its stub. */
  outboundStubbed: boolean
  /** A shadow run answering partner bids from a stand-in rather than skipping them. */
  standIn: boolean
  /** No page or alert may be sent for this run. */
  silentAlerts: boolean
  /** The shadow mode as the code node sandbox receives it. */
  sandboxShadowMode: ShadowMode
}

/** What the shadow mode alone decides; it rides on the context, so a node with no env can ask. */
function shadowFacts(shadow: ShadowMode | undefined): Pick<RunReality, 'outboundStubbed' | 'standIn' | 'sandboxShadowMode'> {
  return {
    outboundStubbed: shadow === 'dry_run' || shadow === 'stand_in',
    standIn: shadow === 'stand_in',
    sandboxShadowMode: shadow ?? 'off',
  }
}

export function runReality(input: RunInput): RunReality {
  const isTest = input.isTest === true
  const localDev = Boolean(input.localDev)
  return { isTest, localDev, silentAlerts: isTest || localDev, ...shadowFacts(input.shadowMode) }
}

/**
 * The shadow facts of a run under way. Shadow mode lives on the context, so a
 * node that is not handed the env (and so cannot know LOCAL_DEV) reads these.
 */
export function shadowOf(ctx: ExecutionContext): Pick<RunReality, 'outboundStubbed' | 'standIn' | 'sandboxShadowMode'> {
  return shadowFacts(ctx.shadow_mode)
}

/** The run reality of a run about to start, from its options and the Worker's env. */
export function runRealityOfOptions(options: Pick<RunInput, 'isTest' | 'shadowMode'>, env: { LOCAL_DEV?: unknown }): RunReality {
  return runReality({ isTest: options.isTest, shadowMode: options.shadowMode, localDev: env.LOCAL_DEV })
}

/** The run reality of a run already under way, from its context and the Worker's env. */
export function runRealityOf(ctx: ExecutionContext, env: { LOCAL_DEV?: unknown }): RunReality {
  return runReality({ isTest: ctx.isTest, shadowMode: ctx.shadow_mode, localDev: env.LOCAL_DEV })
}

/**
 * Writes the test flag and shadow mode onto a new run's context, exactly as the
 * engine always has: only a set option is stamped, so a live run's context
 * carries neither field.
 */
export function stampRunReality(ctx: ExecutionContext, input: Pick<RunInput, 'isTest' | 'shadowMode'>): void {
  if (input.shadowMode) ctx.shadow_mode = input.shadowMode
  if (input.isTest) ctx.isTest = true
}

/** The node decides and records but commits nothing: always on a shadow or local run, on a test run where its trait says so. */
export function nodeReportsOnly(type: NodeType, reality: RunReality): boolean {
  if (reality.outboundStubbed || reality.localDev) return true
  return reality.isTest && NODE_TRAITS[type].testRunException?.kind === 'report_only'
}

/** The node skips its pre-send screen: only on a test run, and only where its trait says so. */
export function nodeSkipsScreen(type: NodeType, reality: Pick<RunReality, 'isTest'>): boolean {
  return reality.isTest && NODE_TRAITS[type].testRunException?.kind === 'unscreened'
}

/** nodeSkipsScreen for a node not handed the env: the screen exception reads only the test flag. */
export function nodeSkipsScreenOn(type: NodeType, ctx: ExecutionContext): boolean {
  return nodeSkipsScreen(type, { isTest: ctx.isTest === true })
}

/**
 * A shadow run of a workflow carrying a node it cannot stub (#1780). Refused
 * before anything is recorded or run: a shadow run exists to send nothing, and
 * a code node's scripts would make their real calls, an Equifax credit pull
 * among them. Lifts when shadow runs dispatch to a compare namespace that
 * denies egress (#1708 part B).
 */
export class ShadowRunRefusedError extends Error {
  /** Read by the retry classifier: a refusal is the same on every attempt. */
  readonly permanent = true

  constructor(readonly nodes: Array<{ namespace: string; type: NodeType; reason: string }>) {
    super(shadowRefusalMessage(nodes))
    this.name = 'ShadowRunRefusedError'
  }
}

function shadowRefusalMessage(nodes: Array<{ namespace: string; type: NodeType; reason: string }>): string {
  const byType = new Map<NodeType, { reason: string; namespaces: string[] }>()
  for (const n of nodes) {
    const group = byType.get(n.type) ?? { reason: n.reason, namespaces: [] }
    group.namespaces.push(n.namespace)
    byType.set(n.type, group)
  }
  const sentences = [...byType].map(([type, { reason, namespaces }]) => {
    const names = namespaces.length === 1 ? namespaces[0] : `${namespaces.slice(0, -1).join(', ')} and ${namespaces[namespaces.length - 1]}`
    const what = namespaces.length === 1 ? `is a ${type} node` : `are ${type} nodes`
    return `${names} ${what}, and ${reason}.`
  })
  return `A shadow run of this workflow is refused before anything runs. ${sentences.join(' ')}`
}

/**
 * The refusal for a shadow run of this definition, or null when the run may go
 * ahead: it is no shadow run, or every node sends nothing or is stubbed. A type
 * this build has never heard of is left to the executor, which refuses it by
 * name, as the lane check does.
 */
export function shadowRunRefusal(definition: WorkflowDefinition, reality: Pick<RunReality, 'outboundStubbed'>): ShadowRunRefusedError | null {
  if (!reality.outboundStubbed) return null
  const refused: Array<{ namespace: string; type: NodeType; reason: string }> = []
  for (const n of definition.nodes) {
    if (!isNodeType(n.type)) continue
    const trait = NODE_TRAITS[n.type].shadowRun
    if (trait.kind === 'refused') refused.push({ namespace: n.namespace, type: n.type, reason: trait.reason })
  }
  return refused.length > 0 ? new ShadowRunRefusedError(refused) : null
}
