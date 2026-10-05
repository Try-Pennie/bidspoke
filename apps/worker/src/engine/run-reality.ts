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
import { NODE_TRAITS, assertNever, isNodeType, type NodeType } from '@bidspoke/node-types'
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
 * A shadow run of a workflow carrying code nodes with no compare bundle deployed
 * for it (#1780, #1708). A code node's scripts make their real calls, an Equifax
 * credit pull among them, so on a shadow run they run only in the compare
 * namespace, whose outbound Worker refuses every request. With no bundle there,
 * they have nowhere safe to run, so the run is refused before anything is
 * recorded or run.
 */
export class ShadowRunRefusedError extends Error {
  /** Read by the retry classifier: a refusal is the same on every attempt. */
  readonly permanent = true

  constructor(readonly nodes: Array<{ namespace: string; type: NodeType }>) {
    super(shadowRefusalMessage(nodes))
    this.name = 'ShadowRunRefusedError'
  }
}

function shadowRefusalMessage(nodes: Array<{ namespace: string; type: NodeType }>): string {
  const byType = new Map<NodeType, string[]>()
  for (const n of nodes) byType.set(n.type, [...(byType.get(n.type) ?? []), n.namespace])
  const sentences = [...byType].map(([type, namespaces]) => {
    const names = namespaces.length === 1 ? namespaces[0] : `${namespaces.slice(0, -1).join(', ')} and ${namespaces[namespaces.length - 1]}`
    const what = namespaces.length === 1 ? `is a ${type} node` : `are ${type} nodes`
    const whose = namespaces.length === 1 ? 'its scripts have' : 'their scripts have'
    return `${names} ${what}, and no compare bundle was deployed for this run, so ${whose} nowhere to run that refuses their outside calls.`
  })
  return `A shadow run of this workflow is refused before anything runs. ${sentences.join(' ')}`
}

/**
 * The refusal for a shadow run of this definition, or null when the run may go
 * ahead: it is no shadow run, every node sends nothing or is stubbed, or a
 * compare bundle was deployed for its sandboxed nodes. A type this build has
 * never heard of is left to the executor, which refuses it by name, as the
 * lane check does.
 */
export function shadowRunRefusal(
  definition: WorkflowDefinition,
  reality: Pick<RunReality, 'outboundStubbed'>,
  compareBundle: string | undefined,
): ShadowRunRefusedError | null {
  if (!reality.outboundStubbed || compareBundle) return null
  const refused: Array<{ namespace: string; type: NodeType }> = []
  for (const n of definition.nodes) {
    if (isNodeType(n.type) && NODE_TRAITS[n.type].shadowRun.kind === 'sandboxed') refused.push({ namespace: n.namespace, type: n.type })
  }
  return refused.length > 0 ? new ShadowRunRefusedError(refused) : null
}

/** Which dispatch namespace a run's code nodes run in. */
export type CodeNamespace = 'money' | 'compare'

/**
 * The one switch that decides it (#1708, plan 0.D). A live run and a canvas
 * test run dispatch to the money namespace and make their real calls (Dan,
 * 2026-10-02). Every shadow run dispatches to the compare namespace, whose
 * outbound Worker refuses every request, and never to the money one. A shadow
 * mode it cannot classify is refused by name rather than given a namespace.
 */
export function codeNamespaceOf(ctx: ExecutionContext): CodeNamespace {
  const mode = ctx.shadow_mode
  switch (mode) {
    case undefined:
    case 'off':
      return 'money'
    case 'dry_run':
    case 'stand_in':
      return 'compare'
    default:
      return assertNever(mode, 'shadow mode')
  }
}
