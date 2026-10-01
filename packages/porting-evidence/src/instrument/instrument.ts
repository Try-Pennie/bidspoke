/**
 * Instruments one exported Pipedream workflow so every run is recorded for the
 * port comparison (#1705, plan 0.R, decisions D2 to D6).
 *
 * Where captures go, for every pipeline: the top level `steps` AND every
 * `deployments` entry, which hold the live branches:
 * - `start`: a capture step first in the top level pipeline;
 * - `terminal`: a capture step immediately before every enabled end-workflow
 *   step, in any pipeline; a capture step last in the top level pipeline when
 *   it does not already end in an enabled end-workflow; and a capture call
 *   immediately before every `$.flow.exit` in code;
 * - `responded`: a capture step after every http return step, and a capture
 *   call after every `$.respond` in code. Never counted as a finish;
 * - `error`: an error listener for the workspace $errors stream (see
 *   capture-source.ts), because Pipedream has no per workflow error step.
 *
 * A branch pipeline that falls off its end gets NO terminal. Pipedream merges a
 * finished branch back into its parent flow ("Merge and continue execution in
 * the parent flow after the branching operation", pipedream.com/docs control
 * flow, read 2026-10-01), so that run still reaches the parent's terminal, and a
 * second terminal at the branch end would break the one start plus exactly one
 * terminal pairing rule.
 *
 * Code is edited through its syntax tree (recast over @babel/parser), never as
 * text, and recast reprints only the nodes that changed, so every other line of
 * the step is byte identical. A site the tree edit cannot make safe is REFUSED
 * by name with its line, never skipped and never guessed at:
 * - `exit_outside_run`: the exit sits in a module level helper, where the run's
 *   `steps` (and so its event id) is not in scope;
 * - `exit_in_sync_function`: the enclosing function is not async, so the capture
 *   cannot be awaited before the run ends;
 * - `exit_in_expression_position` (`a && $.flow.exit()`): there is no statement
 *   to put the capture in front of;
 * - `exit_alias`: `$.flow.exit` read as a value, so its calls cannot be found;
 * - the same three for `$.respond`; `unparseable_code`; `no_run_method`;
 *   `unsupported_run_parameters`; `already_instrumented`.
 * Each refusal becomes a hand item for the person installing the recorder.
 */
import { parse as babelParse } from '@babel/parser'
import type { ExpressionKind, StatementKind } from 'ast-types/lib/gen/kinds'
import type { NodePath } from 'ast-types/lib/node-path'
import { parse, print, types, visit } from 'recast'
import {
  CAPTURE_FUNCTION,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  captureHelperSource,
  captureStepSource,
  errorListenerSource,
  keyEnvName,
  type CaptureConfig,
} from './capture-source.ts'

const b = types.builders
const n = types.namedTypes
type Node = types.namedTypes.Node

export const CAPTURE_STEP_PREFIX = 'porting_capture_'
const STEPS_ALIAS = '__portingSteps'
const END_KEY = 'end-end-workflow'
const RETURN_KEY = 'http-return-http-response'

export interface PipedreamStep {
  namespace: string
  type?: string
  lang?: string
  component?: boolean
  disabled?: boolean
  component_key?: string
  uses: { registry?: boolean; code?: string; key?: string; version?: string }
  props?: Record<string, unknown>
  [extra: string]: unknown
}

export interface PipedreamWorkflow {
  schema?: string
  id: string
  name?: string
  settings?: Record<string, unknown>
  triggers?: unknown[]
  steps: PipedreamStep[]
  deployments?: Record<string, { steps?: PipedreamStep[] }>
  [extra: string]: unknown
}

export type SiteKind = 'start' | 'terminal' | 'responded' | 'error'

export interface InstrumentedSite {
  siteId: string
  kind: SiteKind
  pipeline: string
  step: string
  how: 'capture_step' | 'code_call' | 'error_listener'
}

export type RefusalReason =
  | 'exit_outside_run'
  | 'exit_in_sync_function'
  | 'exit_in_expression_position'
  | 'exit_alias'
  | 'respond_outside_run'
  | 'respond_in_sync_function'
  | 'respond_in_expression_position'
  | 'respond_unsupported_arguments'
  | 'unparseable_code'
  | 'no_run_method'
  | 'unsupported_run_parameters'
  | 'already_instrumented'
  | 'invalid_hashid'

export interface Refusal {
  siteId: string
  pipeline: string
  step: string
  reason: RefusalReason
  line: number
}

export interface InstrumentResult {
  workflow: PipedreamWorkflow
  sites: InstrumentedSite[]
  refused: Refusal[]
  errorListener: { code: string; trigger: string; keyEnv: string }
  delaySteps: Array<{ pipeline: string; step: string }>
}

export interface InstrumentOptions {
  receiverBaseUrl: string
  timeoutMs?: number
  maxBytes?: number
}

const isControlFlow = (s: PipedreamStep) => !!s.props && '_controlFlow' in s.props
const isCodeStep = (s: PipedreamStep) => typeof s.uses?.code === 'string' && s.uses.registry !== true && !isControlFlow(s)

function parseModule(code: string) {
  return parse(code, {
    parser: {
      parse: (source: string) =>
        babelParse(source, {
          sourceType: 'module',
          tokens: true,
          allowReturnOutsideFunction: true,
          allowAwaitOutsideFunction: true,
          errorRecovery: false,
          plugins: ['jsx', 'topLevelAwait'],
        }),
    },
  }) as types.namedTypes.File
}

const isFunction = (node: Node) =>
  n.FunctionDeclaration.check(node) ||
  n.FunctionExpression.check(node) ||
  n.ArrowFunctionExpression.check(node) ||
  n.ObjectMethod.check(node) ||
  n.ClassMethod.check(node)

const propName = (key: unknown): string | null =>
  n.Identifier.check(key) ? key.name : n.StringLiteral.check(key) ? key.value : null

/** The `run` function of `export default defineComponent({...})` or `export default {...}`. */
function findRun(ast: types.namedTypes.File): Node | null {
  for (const stmt of ast.program.body) {
    if (!n.ExportDefaultDeclaration.check(stmt)) continue
    let obj: Node = stmt.declaration
    if (n.CallExpression.check(obj) && obj.arguments.length > 0) obj = obj.arguments[0]
    if (!n.ObjectExpression.check(obj)) return null
    for (const prop of obj.properties) {
      if (n.ObjectMethod.check(prop) && propName(prop.key) === 'run') return prop
      if (n.ObjectProperty.check(prop) && propName(prop.key) === 'run' && isFunction(prop.value)) return prop.value
    }
  }
  return null
}

type FunctionNode = types.namedTypes.Function

/** Arranges for the run's `steps` to be readable by name, and says how. */
function stepsAccess(run: FunctionNode): { expr: () => ExpressionKind; dollar: string } | null {
  const param = run.params[0]
  if (param === undefined) {
    run.params.push(b.objectPattern([b.objectProperty(b.identifier('steps'), b.identifier(STEPS_ALIAS))]))
    return { expr: () => b.identifier(STEPS_ALIAS), dollar: '$' }
  }
  if (n.Identifier.check(param)) {
    const name = param.name
    return { expr: () => b.memberExpression(b.identifier(name), b.identifier('steps')), dollar: '\u0000none' }
  }
  if (n.ObjectPattern.check(param)) {
    let dollar = '$'
    for (const p of param.properties) {
      if ((n.ObjectProperty.check(p) || n.Property.check(p)) && propName(p.key) === '$' && n.Identifier.check(p.value)) dollar = p.value.name
    }
    const added = b.objectProperty(b.identifier('steps'), b.identifier(STEPS_ALIAS))
    const restAt = param.properties.findIndex((p) => n.RestElement.check(p))
    if (restAt === -1) param.properties.push(added)
    else param.properties.splice(restAt, 0, added)
    return { expr: () => b.identifier(STEPS_ALIAS), dollar }
  }
  return null
}

interface CodeSite {
  path: NodePath
  kind: 'exit' | 'respond' | 'exit_alias'
  line: number
  column: number
}

const memberProp = (node: Node): string | null =>
  n.MemberExpression.check(node) && !node.computed ? propName(node.property) : null

const isCall = (node: Node) => n.CallExpression.check(node) || n.OptionalCallExpression.check(node)

/**
 * True when `$.flow.exit` is read as a value that can be called later under
 * another name: stored, assigned, passed, returned or put in an object. Those
 * calls cannot be found, so the read is refused as an alias.
 */
const escapesAsValue = (parent: Node, node: Node): boolean =>
  (n.VariableDeclarator.check(parent) && parent.init === node) ||
  (n.AssignmentExpression.check(parent) && parent.right === node) ||
  (isCall(parent) && (parent as types.namedTypes.CallExpression).arguments.includes(node as ExpressionKind)) ||
  ((n.ObjectProperty.check(parent) || n.Property.check(parent)) && parent.value === node) ||
  (n.ReturnStatement.check(parent) && parent.argument === node) ||
  (n.ArrowFunctionExpression.check(parent) && parent.body === node) ||
  n.ArrayExpression.check(parent)

function collectSites(ast: types.namedTypes.File, dollarNames: Set<string>): CodeSite[] {
  const sites: CodeSite[] = []
  const loc = (node: Node) => ({ line: node.loc?.start.line ?? 0, column: node.loc?.start.column ?? 0 })
  visit(ast, {
    visitMemberExpression(path) {
      const node = path.node
      const isFlowExit = memberProp(node) === 'exit' && memberProp(node.object) === 'flow'
      const parent = (path.parent as NodePath | null)?.node as Node | undefined
      const isCallee = !!parent && isCall(parent) && (parent as types.namedTypes.CallExpression).callee === node
      if (isFlowExit) {
        if (isCallee) sites.push({ path: path.parent as NodePath, kind: 'exit', ...loc(parent) })
        else if (parent && escapesAsValue(parent, node)) sites.push({ path, kind: 'exit_alias', ...loc(node) })
        // Any other read (`if ($?.flow?.exit)`, `typeof $.flow.exit`) only tests
        // the function exists: it exits nothing and calls nothing.
      } else if (memberProp(node) === 'respond' && n.Identifier.check(node.object) && dollarNames.has(node.object.name)) {
        if (isCallee) sites.push({ path: path.parent as NodePath, kind: 'respond', ...loc(parent) })
      }
      this.traverse(path)
    },
  })
  return sites
}

function enclosingFunction(path: NodePath): NodePath | null {
  let p: NodePath | null = path.parent as NodePath | null
  while (p && !isFunction(p.node as Node)) p = p.parent as NodePath | null
  return p
}

function isInside(path: NodePath, ancestor: Node): boolean {
  let p: NodePath | null = path
  while (p) {
    if (p.node === ancestor) return true
    p = p.parent as NodePath | null
  }
  return false
}

/** The statement a call is the whole of (`x()`, `await x()`, `return x()`, `return await x()`), or null. */
function owningStatement(callPath: NodePath): NodePath | null {
  let p = callPath
  if (n.AwaitExpression.check((p.parent as NodePath | null)?.node)) p = p.parent as NodePath
  const parent = p.parent as NodePath | null
  if (!parent) return null
  if (n.ExpressionStatement.check(parent.node) && parent.node.expression === p.node) return parent
  if (n.ReturnStatement.check(parent.node) && parent.node.argument === p.node) return parent
  return null
}

/** Replaces one statement with several, inside its list or wrapped in a block when it stands alone. */
function replaceStatement(stmtPath: NodePath, nodes: StatementKind[]) {
  if (Array.isArray((stmtPath.parentPath as NodePath | null)?.value)) stmtPath.replace(...nodes)
  else stmtPath.replace(b.blockStatement(nodes))
}

function captureCall(stepsExpr: ExpressionKind, kind: SiteKind, siteId: string, payload: ExpressionKind) {
  return b.expressionStatement(
    b.awaitExpression(b.callExpression(b.identifier(CAPTURE_FUNCTION), [stepsExpr, b.stringLiteral(kind), b.stringLiteral(siteId), payload])),
  )
}

interface CodeResult {
  code: string | null
  sites: InstrumentedSite[]
  refused: Refusal[]
}

function instrumentCode(code: string, pipeline: string, step: string, config: CaptureConfig): CodeResult {
  const refuse = (reason: RefusalReason, line: number, siteId = `${pipeline}/${step}`): CodeResult => ({
    code: null,
    sites: [],
    refused: [{ siteId, pipeline, step, reason, line }],
  })

  let ast: types.namedTypes.File
  try {
    ast = parseModule(code)
  } catch (e) {
    const line = typeof e === 'object' && e !== null && 'loc' in e ? ((e as { loc?: { line?: number } }).loc?.line ?? 0) : 0
    return refuse('unparseable_code', line)
  }

  let alreadyInstrumented = false
  visit(ast, {
    visitIdentifier(path) {
      if (path.node.name === CAPTURE_FUNCTION) alreadyInstrumented = true
      this.traverse(path)
    },
  })
  if (alreadyInstrumented) return refuse('already_instrumented', 0)

  const run = findRun(ast)
  const runFn = run as FunctionNode | null
  const preview = collectSites(ast, new Set(['$', ...(runFn ? dollarAliases(runFn) : [])]))
  if (preview.length === 0) return { code: null, sites: [], refused: [] }
  if (!runFn) return refuse('no_run_method', preview[0].line)

  const access = stepsAccess(runFn)
  if (!access) return refuse('unsupported_run_parameters', runFn.loc?.start.line ?? 0)

  const sites: InstrumentedSite[] = []
  const refused: Refusal[] = []
  // Last first, so an edit never shifts a statement list another site still points into.
  const ordered = [...preview].sort((a, z) => z.line - a.line || z.column - a.column)
  for (const site of ordered) {
    const label = site.kind === 'respond' ? 'respond' : 'exit'
    const siteId = `${pipeline}/${step}/${label}:${site.line}:${site.column}`
    const refuseSite = (reason: RefusalReason) => refused.push({ siteId, pipeline, step, reason, line: site.line })
    if (site.kind === 'exit_alias') {
      refuseSite('exit_alias')
      continue
    }
    if (!isInside(site.path, runFn)) {
      refuseSite(site.kind === 'exit' ? 'exit_outside_run' : 'respond_outside_run')
      continue
    }
    const fn = enclosingFunction(site.path)
    if (!fn || !(fn.node as FunctionNode).async) {
      refuseSite(site.kind === 'exit' ? 'exit_in_sync_function' : 'respond_in_sync_function')
      continue
    }
    const stmt = owningStatement(site.path)
    if (!stmt) {
      refuseSite(site.kind === 'exit' ? 'exit_in_expression_position' : 'respond_in_expression_position')
      continue
    }

    if (site.kind === 'exit') {
      replaceStatement(stmt, [captureCall(access.expr(), 'terminal', siteId, b.nullLiteral()), stmt.node as StatementKind])
      sites.push({ siteId, kind: 'terminal', pipeline, step, how: 'code_call' })
      continue
    }

    const call = site.path.node as types.namedTypes.CallExpression
    if (call.arguments.length > 1 || call.arguments.some((a) => n.SpreadElement.check(a))) {
      refuseSite('respond_unsupported_arguments')
      continue
    }
    const tag = `${site.line}_${site.column}`
    const nodes: StatementKind[] = []
    let payload: ExpressionKind = b.nullLiteral()
    if (call.arguments.length === 1) {
      const responseName = `__portingResponse_${tag}`
      nodes.push(b.variableDeclaration('const', [b.variableDeclarator(b.identifier(responseName), call.arguments[0] as ExpressionKind)]))
      call.arguments[0] = b.identifier(responseName)
      payload = b.arrowFunctionExpression([], b.identifier(responseName))
    }
    const capture = captureCall(access.expr(), 'responded', siteId, payload)
    if (n.ReturnStatement.check(stmt.node)) {
      const resultName = `__portingResult_${tag}`
      nodes.push(b.variableDeclaration('const', [b.variableDeclarator(b.identifier(resultName), stmt.node.argument)]))
      nodes.push(capture, b.returnStatement(b.identifier(resultName)))
    } else {
      nodes.push(stmt.node as StatementKind, capture)
    }
    replaceStatement(stmt, nodes)
    sites.push({ siteId, kind: 'responded', pipeline, step, how: 'code_call' })
  }

  if (sites.length === 0) {
    // Nothing was rewritten, so the step is left exactly as it was. The param
    // added for `steps` above is discarded with the tree.
    return { code: null, sites, refused }
  }

  const helper = parseModule(captureHelperSource(config)).program.body
  const body = ast.program.body
  let at = 0
  body.forEach((stmt, i) => {
    if (n.ImportDeclaration.check(stmt)) at = i + 1
  })
  body.splice(at, 0, ...helper)
  return { code: print(ast).code, sites: sites.reverse(), refused: refused.reverse() }
}

function dollarAliases(run: FunctionNode): string[] {
  const param = run.params[0]
  if (!n.ObjectPattern.check(param)) return []
  const out: string[] = []
  for (const p of param.properties) {
    if ((n.ObjectProperty.check(p) || n.Property.check(p)) && propName(p.key) === '$' && n.Identifier.check(p.value)) out.push(p.value.name)
  }
  return out
}

export function instrumentWorkflow(input: PipedreamWorkflow, options: InstrumentOptions): InstrumentResult {
  const wf = structuredClone(input)
  const config: CaptureConfig = {
    hashid: wf.id,
    receiverBaseUrl: options.receiverBaseUrl,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
  }
  const errorListener = { code: '', trigger: 'Pipedream source: Workspace $error events', keyEnv: keyEnvName(wf.id) }
  const empty = (refusal: Refusal): InstrumentResult => ({ workflow: wf, sites: [], refused: [refusal], errorListener, delaySteps: [] })

  if (typeof wf.id !== 'string' || !/^p_[A-Za-z0-9]+$/.test(wf.id)) {
    return empty({ siteId: 'workflow', pipeline: 'main', step: '', reason: 'invalid_hashid', line: 0 })
  }
  const pipelines: Array<[string, PipedreamStep[]]> = [
    ['main', wf.steps ?? []],
    ...Object.entries(wf.deployments ?? {}).map(([id, d]): [string, PipedreamStep[]] => [id, d.steps ?? []]),
  ]
  const existing = pipelines.flatMap(([, steps]) => steps.map((s) => s.namespace))
  const prior = existing.find((ns) => ns.startsWith(CAPTURE_STEP_PREFIX))
  if (prior) return empty({ siteId: 'workflow', pipeline: 'main', step: prior, reason: 'already_instrumented', line: 0 })

  const taken = new Set(existing)
  let counter = 0
  const sites: InstrumentedSite[] = []
  const refused: Refusal[] = []
  const delaySteps: Array<{ pipeline: string; step: string }> = []

  const captureStep = (pipeline: string, kind: 'start' | 'terminal' | 'responded', siteId: string, anchor: string): PipedreamStep => {
    let namespace = `${CAPTURE_STEP_PREFIX}${counter++}`
    while (taken.has(namespace)) namespace = `${CAPTURE_STEP_PREFIX}${counter++}`
    taken.add(namespace)
    sites.push({ siteId, kind, pipeline, step: anchor, how: 'capture_step' })
    return {
      namespace,
      type: 'CodeCell',
      lang: 'nodejs20.x',
      component: true,
      uses: { registry: false, code: captureStepSource(config, kind, siteId) },
    }
  }

  const rewrite = (pipeline: string, steps: PipedreamStep[]): PipedreamStep[] => {
    const out: PipedreamStep[] = []
    if (pipeline === 'main') out.push(captureStep(pipeline, 'start', 'main/start', 'start'))
    for (const step of steps) {
      if (step.disabled) {
        out.push(step)
        continue
      }
      if ((step.component_key ?? step.uses?.key ?? '').includes('delay')) delaySteps.push({ pipeline, step: step.namespace })
      if (step.component_key === END_KEY) {
        out.push(captureStep(pipeline, 'terminal', `${pipeline}/before:${step.namespace}`, step.namespace))
        out.push(step)
        continue
      }
      if (isCodeStep(step)) {
        const result = instrumentCode(step.uses.code as string, pipeline, step.namespace, config)
        sites.push(...result.sites)
        refused.push(...result.refused)
        out.push(result.code === null ? step : { ...step, uses: { ...step.uses, code: result.code } })
      } else {
        out.push(step)
      }
      if (step.component_key === RETURN_KEY) {
        out.push(captureStep(pipeline, 'responded', `${pipeline}/after:${step.namespace}`, step.namespace))
      }
    }
    if (pipeline === 'main') {
      const lastEnabled = [...steps].reverse().find((s) => !s.disabled)
      if (!lastEnabled || lastEnabled.component_key !== END_KEY) out.push(captureStep(pipeline, 'terminal', 'main/end', 'end'))
    }
    return out
  }

  wf.steps = rewrite('main', wf.steps ?? [])
  for (const [id, dep] of Object.entries(wf.deployments ?? {})) dep.steps = rewrite(id, dep.steps ?? [])

  errorListener.code = errorListenerSource(config)
  sites.push({ siteId: 'error-listener', kind: 'error', pipeline: 'error-listener', step: 'error-listener', how: 'error_listener' })
  return { workflow: wf, sites, refused, errorListener, delaySteps }
}
