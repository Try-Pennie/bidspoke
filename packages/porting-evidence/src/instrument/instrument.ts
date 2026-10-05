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
 * - `exit_alias`: `$.flow.exit` read as a value (stored, passed, bound, or
 *   `flow` destructured from `$`), so its calls cannot be found;
 * - `exit_run_parameter_shadowed`: the run takes its context as a plain
 *   identifier (`run(ctx)`), the capture would read `ctx.steps`, and at the
 *   site a nearer `ctx` hides the run's;
 * - the same five for `$.respond`; `respond_unresolved_receiver`, a
 *   `.respond(` call whose receiver cannot be traced to the run's `$`;
 *   `unparseable_code`; `no_run_method`; `unsupported_run_parameters`;
 *   `already_instrumented`.
 * Each refusal becomes a hand item for the person installing the recorder.
 *
 * The run's `$` is followed by binding, not only by name (#1717): into a helper
 * defined in the step that is called with it (a function declaration, an
 * arrow or function expression held in a variable, a method of an object
 * literal, a component method called as `this.name(...)`), through helpers
 * that pass it on, through a local `const d = $`, and through the run context
 * or an object carrying `$` (`helper(ctx)`, `helper({ $ })`). A respond or
 * exit through such a helper is captured where the helper sits inside `run`,
 * because the capture can read the run's `steps` there exactly as it does for
 * `$` itself, and refused as
 * `respond_outside_run` / `exit_outside_run` where it sits outside, because
 * `steps` is not in scope there and the only ways in (a changed signature at
 * every call site, a capture at the call site that cannot know whether this
 * call responded, a module level variable shared by concurrent runs) are not
 * safe. A `$` handed to anything NOT defined in the step (`axios($, ...)`, an
 * import) is not followed and refuses nothing.
 */
import { parse as babelParse } from '@babel/parser'
import type { ExpressionKind, StatementKind } from 'ast-types/lib/gen/kinds'
import type { NodePath } from 'ast-types/lib/node-path'
import type { Scope } from 'ast-types/lib/scope'
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
  | 'exit_run_parameter_shadowed'
  | 'respond_outside_run'
  | 'respond_in_sync_function'
  | 'respond_in_expression_position'
  | 'respond_unsupported_arguments'
  | 'respond_alias'
  | 'respond_run_parameter_shadowed'
  | 'respond_unresolved_receiver'
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

/** The object of `export default defineComponent({...})` or `export default {...}`. */
function findComponent(ast: types.namedTypes.File): types.namedTypes.ObjectExpression | null {
  for (const stmt of ast.program.body) {
    if (!n.ExportDefaultDeclaration.check(stmt)) continue
    let obj: Node = stmt.declaration
    if (n.CallExpression.check(obj) && obj.arguments.length > 0) obj = obj.arguments[0]
    return n.ObjectExpression.check(obj) ? obj : null
  }
  return null
}

/** The function a property of an object literal holds: a method, or a property whose value is a function. */
function propertyFunction(prop: Node): FunctionNode | null {
  if (n.ObjectMethod.check(prop)) return prop
  if ((n.ObjectProperty.check(prop) || n.Property.check(prop)) && isFunction(prop.value)) return prop.value as FunctionNode
  return null
}

/** The `run` function of the component. */
function findRun(ast: types.namedTypes.File): Node | null {
  const obj = findComponent(ast)
  for (const prop of obj?.properties ?? []) {
    if (!(n.ObjectMethod.check(prop) || n.ObjectProperty.check(prop)) || propName(prop.key) !== 'run') continue
    const fn = propertyFunction(prop)
    if (fn) return fn
  }
  return null
}

type FunctionNode = types.namedTypes.Function

/**
 * Arranges for the run's `steps` to be readable by name, and says how. `root`
 * is the run parameter the expression starts from when that name is the
 * workflow's own (`ctx` in `ctx.steps`), so a site where a nearer binding hides
 * it can be refused; null when the name is one this module added.
 */
function stepsAccess(run: FunctionNode): { expr: () => ExpressionKind; dollar: string; root: string | null } | null {
  const param = run.params[0]
  if (param === undefined) {
    run.params.push(b.objectPattern([b.objectProperty(b.identifier('steps'), b.identifier(STEPS_ALIAS))]))
    return { expr: () => b.identifier(STEPS_ALIAS), dollar: '$', root: null }
  }
  if (n.Identifier.check(param)) {
    const name = param.name
    return { expr: () => b.memberExpression(b.identifier(name), b.identifier('steps')), dollar: '\u0000none', root: name }
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
    return { expr: () => b.identifier(STEPS_ALIAS), dollar, root: null }
  }
  return null
}

interface CodeSite {
  /** Null for an alias found in a destructuring pattern, which is refused without being edited. */
  path: NodePath | null
  kind: 'exit' | 'respond' | 'exit_alias' | 'respond_alias' | 'respond_unresolved'
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

/** True when the read is `.bind`, `.call` or `.apply` on it: a call under another name, or a function kept for later. */
const isReboundBy = (parent: Node, node: Node): boolean =>
  n.MemberExpression.check(parent) && parent.object === node && ['bind', 'call', 'apply'].includes(memberProp(parent) ?? '')

/**
 * True when a node is the run's `$` BY NAME: an identifier spelled `$` or a
 * destructured alias of it, or `<param>.$` where the run takes its context as a
 * plain identifier (`run(ctx)` then `ctx.$.respond(...)`). The binding rules in
 * `traceDollar` find the rest.
 */
const isDollar = (node: Node, dollarNames: Set<string>, runParamNames: Set<string>): boolean =>
  (n.Identifier.check(node) && dollarNames.has(node.name)) ||
  (n.MemberExpression.check(node) &&
    memberProp(node) === '$' &&
    n.Identifier.check(node.object) &&
    runParamNames.has(node.object.name))

/**
 * The scope that declares `name` where `path` stands, or null for a global.
 * Walked here rather than with `Scope.lookup`, because ast-types cannot scan
 * the scope of a `catch {` with no binding (it asserts the missing parameter is
 * a pattern and throws). Such a scope declares nothing, so skipping it is exact.
 */
function scopeDeclaring(path: NodePath, name: string): Scope | null {
  for (let scope = path.scope as Scope | null; scope; scope = scope.parent as Scope | null) {
    const node = scope.node as Node
    if (n.CatchClause.check(node) && node.param == null) continue
    if (scope.declares(name)) return scope
  }
  return null
}

/** The node of the scope that declares `name` where `path` stands (a function, or the program), or null for a global. */
function declaringScope(path: NodePath, name: string): Node | null {
  const scope = scopeDeclaring(path, name)
  return scope ? (scope.node as Node) : null
}

/** Bindings, keyed by the scope node that declares them and their name. */
class Bindings {
  private readonly byScope = new Map<Node, Set<string>>()
  add(scope: Node, name: string): boolean {
    const names = this.byScope.get(scope) ?? new Set<string>()
    this.byScope.set(scope, names)
    if (names.has(name)) return false
    names.add(name)
    return true
  }
  holds(path: NodePath, name: string): boolean {
    const scope = declaringScope(path, name)
    return scope !== null && (this.byScope.get(scope)?.has(name) ?? false)
  }
}

interface DollarTrace {
  /** True when the expression at `path` is the run's `$`, by name or by binding. */
  isDollar(path: NodePath): boolean
  /** `respond` or `flow` destructured from a `$`: functions taken as values, so their calls cannot be found. */
  aliases: CodeSite[]
}

/**
 * Follows the run's `$` into the bindings that receive it, by scope rather than
 * by name (#1717), until nothing new is found:
 * - an argument to a function DEFINED IN THE STEP binds that function's
 *   parameter: a function declaration, an arrow or function expression held
 *   in a variable, a method of an object literal held in a variable, or a
 *   component method called as `this.name(...)`; a helper passing it on
 *   carries it further;
 * - `const d = $` binds `d`;
 * - the run context (`run(ctx)`, then `helper(ctx)`) and an object literal
 *   carrying `$` (`helper({ $ })`) bind a parameter whose `.$` is the run's
 *   `$`, or whose destructured `$` property is.
 * A callee defined anywhere else (an import, `axios`, a global) is not
 * followed, so `axios($, ...)` binds nothing and refuses nothing.
 *
 * A helper parameter counts as `$` when ANY call in the step passes `$` there.
 * A helper also called with something else in that position would then capture
 * a respond the other object made; that costs one extra responded record, never
 * a missing one, and responded records are never counted as a finish.
 */
function traceDollar(
  ast: types.namedTypes.File,
  run: FunctionNode | null,
  dollarNames: Set<string>,
  runParamNames: Set<string>,
): DollarTrace {
  const dollar = new Bindings()
  const context = new Bindings()
  const aliasNodes = new Set<Node>()
  const aliases: CodeSite[] = []
  const calls: NodePath[] = []
  const declarators: NodePath[] = []
  visit(ast, {
    visitCallExpression(path) {
      calls.push(path)
      this.traverse(path)
    },
    visitVariableDeclarator(path) {
      declarators.push(path)
      this.traverse(path)
    },
  })

  if (run && n.Identifier.check(run.params[0])) context.add(run, run.params[0].name)

  const isDollarAt = (path: NodePath): boolean => {
    const node = path.node as Node
    if (isDollar(node, dollarNames, runParamNames)) return true
    if (n.Identifier.check(node)) return dollar.holds(path, node.name)
    if (memberProp(node) === '$' && n.Identifier.check((node as types.namedTypes.MemberExpression).object)) {
      return context.holds(path.get('object') as NodePath, ((node as types.namedTypes.MemberExpression).object as types.namedTypes.Identifier).name)
    }
    return false
  }
  const isContextAt = (path: NodePath): boolean => {
    const node = path.node as Node
    if (n.Identifier.check(node)) return context.holds(path, node.name)
    if (!n.ObjectExpression.check(node)) return false
    return node.properties.some(
      (p, i) => (n.ObjectProperty.check(p) || n.Property.check(p)) && propName(p.key) === '$' && isDollarAt(path.get('properties', i, 'value') as NodePath),
    )
  }

  const alias = (node: Node, kind: 'respond_alias' | 'exit_alias') => {
    if (aliasNodes.has(node)) return
    aliasNodes.add(node)
    aliases.push({ path: null, kind, line: node.loc?.start.line ?? 0, column: node.loc?.start.column ?? 0 })
  }
  /** Binds what a pattern takes from a `$` or a context; reports `respond` and `flow` taken from a `$`. */
  const bindTarget = (target: Node, scope: Node, holds: 'dollar' | 'context'): boolean => {
    const left = n.AssignmentPattern.check(target) ? target.left : target
    if (n.Identifier.check(left)) return (holds === 'dollar' ? dollar : context).add(scope, left.name)
    if (!n.ObjectPattern.check(left)) return false
    let changed = false
    for (const p of left.properties) {
      if (!(n.ObjectProperty.check(p) || n.Property.check(p))) continue
      const key = propName(p.key)
      if (holds === 'context' && key === '$') changed = bindTarget(p.value, scope, 'dollar') || changed
      if (holds === 'dollar' && key === 'respond') alias(p, 'respond_alias')
      if (holds === 'dollar' && key === 'flow') alias(p, 'exit_alias')
    }
    return changed
  }

  const component = findComponent(ast)
  const componentMethods = new Map<string, FunctionNode>()
  for (const prop of component?.properties ?? []) {
    if (!(n.ObjectProperty.check(prop) || n.Property.check(prop)) || propName(prop.key) !== 'methods' || !n.ObjectExpression.check(prop.value)) continue
    for (const m of prop.value.properties) {
      const fn = propertyFunction(m)
      const key = n.ObjectMethod.check(m) || n.ObjectProperty.check(m) || n.Property.check(m) ? propName(m.key) : null
      if (fn && key) componentMethods.set(key, fn)
    }
  }
  /** Where `name` is declared as seen from `path`: a function declaration, or a const holding a function or an object literal. */
  const declarations = (path: NodePath, name: string): Node[] => {
    const scope = scopeDeclaring(path, name)
    if (!scope) return []
    const out: Node[] = []
    for (const idPath of ((scope.getBindings() as Record<string, NodePath[]>)[name] ?? [])) {
      const parent = (idPath.parent as NodePath | null)?.node as Node | undefined
      if (n.FunctionDeclaration.check(parent) && parent.id === idPath.node) out.push(parent)
      else if (n.VariableDeclarator.check(parent) && parent.id === idPath.node && parent.init) out.push(parent.init)
    }
    return out
  }
  /** The functions defined in the step that a callee can name; none for anything defined elsewhere. */
  const definedCallees = (calleePath: NodePath): FunctionNode[] => {
    const callee = calleePath.node as Node
    if (n.Identifier.check(callee)) return declarations(calleePath, callee.name).filter(isFunction) as FunctionNode[]
    const key = memberProp(callee)
    if (key === null) return []
    const object = (callee as types.namedTypes.MemberExpression).object
    if (n.ThisExpression.check(object)) {
      const method = componentMethods.get(key)
      return method ? [method] : []
    }
    if (!n.Identifier.check(object)) return []
    const out: FunctionNode[] = []
    for (const decl of declarations(calleePath.get('object') as NodePath, object.name)) {
      if (!n.ObjectExpression.check(decl)) continue
      for (const p of decl.properties) {
        const fn = propertyFunction(p)
        if (fn && (n.ObjectMethod.check(p) || n.ObjectProperty.check(p) || n.Property.check(p)) && propName(p.key) === key) out.push(fn)
      }
    }
    return out
  }

  let changed = true
  while (changed) {
    changed = false
    for (const decl of declarators) {
      const node = decl.node as types.namedTypes.VariableDeclarator
      if (!node.init) continue
      const init = decl.get('init') as NodePath
      const scope = (decl.scope as Scope | null)?.node as Node | undefined
      if (!scope) continue
      if (isDollarAt(init)) changed = bindTarget(node.id, scope, 'dollar') || changed
      else if (isContextAt(init)) changed = bindTarget(node.id, scope, 'context') || changed
    }
    for (const call of calls) {
      const node = call.node as types.namedTypes.CallExpression
      const fns = definedCallees(call.get('callee') as NodePath)
      if (fns.length === 0) continue
      node.arguments.forEach((_arg, i) => {
        const argPath = call.get('arguments', i) as NodePath
        const holds = isDollarAt(argPath) ? 'dollar' : isContextAt(argPath) ? 'context' : null
        if (!holds) return
        for (const fn of fns) {
          const param = fn.params[i] as Node | undefined
          if (param) changed = bindTarget(param, fn, holds) || changed
        }
      })
    }
  }
  return { isDollar: isDollarAt, aliases }
}

function collectSites(
  ast: types.namedTypes.File,
  run: FunctionNode | null,
  dollarNames: Set<string>,
  runParamNames: Set<string> = new Set(),
): CodeSite[] {
  const trace = traceDollar(ast, run, dollarNames, runParamNames)
  const sites: CodeSite[] = [...trace.aliases]
  const loc = (node: Node) => ({ line: node.loc?.start.line ?? 0, column: node.loc?.start.column ?? 0 })
  visit(ast, {
    visitMemberExpression(path) {
      const node = path.node
      const isFlowExit = memberProp(node) === 'exit' && memberProp(node.object) === 'flow'
      const parent = (path.parent as NodePath | null)?.node as Node | undefined
      const isCallee = !!parent && isCall(parent) && (parent as types.namedTypes.CallExpression).callee === node
      const isValue = !!parent && (escapesAsValue(parent, node) || isReboundBy(parent, node))
      if (isFlowExit) {
        if (isCallee) sites.push({ path: path.parent as NodePath, kind: 'exit', ...loc(parent) })
        else if (isValue) sites.push({ path, kind: 'exit_alias', ...loc(node) })
        // Any other read (`if ($?.flow?.exit)`, `typeof $.flow.exit`) only tests
        // the function exists: it exits nothing and calls nothing.
      } else if (memberProp(node) === 'respond') {
        const onDollar = trace.isDollar(path.get('object') as NodePath)
        if (isCallee) sites.push({ path: path.parent as NodePath, kind: onDollar ? 'respond' : 'respond_unresolved', ...loc(parent) })
        else if (isValue && (onDollar || isReboundBy(parent, node))) sites.push({ path, kind: 'respond_alias', ...loc(node) })
        // A `.respond` read on something that is not `$` and not rebound is
        // data (`body.respond`), not a call: nothing to capture.
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
  const preview = collectSites(ast, runFn, new Set(['$', ...(runFn ? dollarAliases(runFn) : [])]), new Set(runFn ? runParamName(runFn) : []))
  if (preview.length === 0) return { code: null, sites: [], refused: [] }
  if (!runFn) return refuse('no_run_method', preview[0].line)

  const access = stepsAccess(runFn)
  if (!access) return refuse('unsupported_run_parameters', runFn.loc?.start.line ?? 0)

  const sites: InstrumentedSite[] = []
  const refused: Refusal[] = []
  // Last first, so an edit never shifts a statement list another site still points into.
  const ordered = [...preview].sort((a, z) => z.line - a.line || z.column - a.column)
  for (const site of ordered) {
    const isExit = site.kind === 'exit' || site.kind === 'exit_alias'
    const siteId = `${pipeline}/${step}/${isExit ? 'exit' : 'respond'}:${site.line}:${site.column}`
    const refuseSite = (reason: RefusalReason) => refused.push({ siteId, pipeline, step, reason, line: site.line })
    if (site.kind === 'exit_alias' || site.kind === 'respond_alias' || site.kind === 'respond_unresolved' || site.path === null) {
      refuseSite(site.kind === 'respond_unresolved' ? 'respond_unresolved_receiver' : isExit ? 'exit_alias' : 'respond_alias')
      continue
    }
    if (!isInside(site.path, runFn)) {
      refuseSite(isExit ? 'exit_outside_run' : 'respond_outside_run')
      continue
    }
    if (access.root !== null && declaringScope(site.path, access.root) !== runFn) {
      refuseSite(isExit ? 'exit_run_parameter_shadowed' : 'respond_run_parameter_shadowed')
      continue
    }
    const fn = enclosingFunction(site.path)
    if (!fn || !(fn.node as FunctionNode).async) {
      refuseSite(isExit ? 'exit_in_sync_function' : 'respond_in_sync_function')
      continue
    }
    const stmt = owningStatement(site.path)
    if (!stmt) {
      refuseSite(isExit ? 'exit_in_expression_position' : 'respond_in_expression_position')
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
    // added for `steps` above is discarded with the tree. Refusals go back in
    // source order, as they do below.
    return { code: null, sites, refused: refused.reverse() }
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

/** The run's parameter when it is a plain identifier (`run(ctx)`), so `ctx.$` is recognised. */
function runParamName(run: FunctionNode): string[] {
  const param = run.params[0]
  return n.Identifier.check(param) ? [param.name] : []
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
