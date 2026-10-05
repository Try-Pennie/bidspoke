/**
 * The instrumenter over the REAL Pipedream export (#1705).
 *
 * The export holds partner code and configuration and is never committed, so
 * this reads it from the machine it lives on: `PIPEDREAM_EXPORT_DIR`, else the
 * folder the 2026-09-30 export sits in on Dan's Mac. Where it is missing:
 * - with `PIPEDREAM_EXPORT_DIR` set, the suite FAILS: a measurement was asked
 *   for and cannot be taken (L320);
 * - otherwise (CI, or another machine) one test is reported as SKIPPED with an
 *   UNMEASURED note naming the path it looked at, and the same line goes to
 *   stderr, so a run that measured nothing never reads as a run that passed
 *   (L411, L98). It does not fail, because CI never holds the export: the
 *   committed fixture suites cover the same rules on hand written workflows.
 * Until #1717 the default still named the folder the export left on
 * 2026-10-02, so on the one machine holding it the suite skipped with nothing
 * saying why.
 *
 * What it proves on all 346 workflows: every run end the plan names has a
 * capture, every code exit and respond is either rewritten or refused by name
 * (counted by a separate parse, not by the instrumenter's own bookkeeping, L70),
 * and every rewritten step still parses.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { parse as babelParse, type ParserOptions } from '@babel/parser'
import { describe, expect, it } from 'vitest'
import { CAPTURE_STEP_PREFIX, exportFiles, instrumentWorkflow, type PipedreamStep, type PipedreamWorkflow } from '../index.ts'

const REQUESTED_DIR = process.env.PIPEDREAM_EXPORT_DIR
// Moved here with the Documents folder on 2026-10-02. The apostrophe in the
// folder name is U+2019, written as an escape so the source holds no curly quote.
const DEFAULT_DIR = path.join(homedir(), 'Documents', 'Documents - Dan\u2019s MacBook Pro', 'Pipedream export', 'Pipedream export 26-09-30')
const EXPORT_DIR = REQUESTED_DIR ?? DEFAULT_DIR
const present = existsSync(EXPORT_DIR)

if (!present && REQUESTED_DIR !== undefined) {
  describe('the real export named by PIPEDREAM_EXPORT_DIR', () => {
    it('exists', () => {
      throw new Error(`PIPEDREAM_EXPORT_DIR names ${EXPORT_DIR}, which does not exist, so the measurement it asks for cannot be taken`)
    })
  })
} else if (!present) {
  const note = `UNMEASURED: no Pipedream export at ${EXPORT_DIR}, so the instrumenter was not run over the real export. Set PIPEDREAM_EXPORT_DIR to measure it.`
  process.stderr.write(`\n${note}\n\n`)
  describe('instrumenter over the real export', () => {
    it('is unmeasured on this machine', (ctx) => ctx.skip(note))
  })
}

const parseOpts: ParserOptions = { sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, plugins: ['jsx', 'topLevelAwait'] }

type Raw = Record<string, unknown>
const isMember = (x: unknown): x is Raw => (x as Raw | undefined)?.type === 'MemberExpression' || (x as Raw | undefined)?.type === 'OptionalMemberExpression'
const isCallNode = (x: unknown): x is Raw => (x as Raw | undefined)?.type === 'CallExpression' || (x as Raw | undefined)?.type === 'OptionalCallExpression'
const propOf = (x: Raw) => (x.computed ? undefined : (x.property as { name?: string } | undefined)?.name)
const isFlowExit = (x: unknown) => isMember(x) && propOf(x) === 'exit' && isMember(x.object) && propOf(x.object) === 'flow'
const isRespond = (x: unknown) => isMember(x) && propOf(x) === 'respond'
/** `$` spelled out, or `<anything>.$`: the receivers a respond taken as a value is counted on. */
const isDollarSpelled = (x: unknown) => ((x as Raw | undefined)?.type === 'Identifier' && (x as Raw).name === '$') || (isMember(x) && propOf(x) === '$')

/**
 * An independent witness over a plain babel tree, sharing no code with the
 * instrumenter:
 * - `exits`: calls of `X.flow.exit(` on any receiver;
 * - `responds`: calls of `X.respond(` on ANY receiver, so a respond through a
 *   helper parameter, a local name or something untraceable is counted too
 *   (#1717), not only one spelled `$.respond(`;
 * - `aliases`: `respond` or `flow.exit` taken as a value: `.bind`, `.call` or
 *   `.apply` on either, a `$.respond` or `X.flow.exit` stored, passed, returned
 *   or put in an object or array, and `respond` or `flow` destructured from `$`.
 */
function rawCounts(code: string): { exits: number; responds: number; aliases: number } {
  let exits = 0
  let responds = 0
  let aliases = 0
  const walk = (node: unknown, parent: Raw | null) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach((x) => walk(x, parent))
    const o = node as Raw
    if (isCallNode(o) && isFlowExit(o.callee)) exits++
    if (isCallNode(o) && isRespond(o.callee)) responds++
    const exitOrRespond = isFlowExit(o) || (isRespond(o) && isDollarSpelled(o.object))
    if ((isFlowExit(o) || isRespond(o)) && parent && isMember(parent) && parent.object === o && ['bind', 'call', 'apply'].includes(propOf(parent) ?? '')) aliases++
    else if (exitOrRespond && parent) {
      const p = parent
      const stored =
        (p.type === 'VariableDeclarator' && p.init === o) ||
        (p.type === 'AssignmentExpression' && p.right === o) ||
        (isCallNode(p) && (p.arguments as unknown[]).includes(o)) ||
        ((p.type === 'ObjectProperty' || p.type === 'Property') && p.value === o) ||
        (p.type === 'ReturnStatement' && p.argument === o) ||
        (p.type === 'ArrowFunctionExpression' && p.body === o) ||
        p.type === 'ArrayExpression'
      if (stored) aliases++
    }
    if (o.type === 'VariableDeclarator' && isDollarSpelled(o.init) && (o.id as Raw).type === 'ObjectPattern') {
      for (const p of (o.id as Raw).properties as Raw[]) if (['respond', 'flow'].includes(((p.key as Raw | undefined)?.name as string | undefined) ?? '')) aliases++
    }
    for (const [k, v] of Object.entries(o)) if (k !== 'loc' && k !== 'start' && k !== 'end') walk(v, o)
  }
  walk(babelParse(code, parseOpts).program, null)
  return { exits, responds, aliases }
}

const pipelinesOf = (wf: PipedreamWorkflow): Array<[string, PipedreamStep[]]> => [
  ['main', wf.steps ?? []],
  ...Object.entries(wf.deployments ?? {}).map(([id, d]): [string, PipedreamStep[]] => [id, d.steps ?? []]),
]
const isCapture = (s: PipedreamStep | undefined) => !!s && s.namespace.startsWith(CAPTURE_STEP_PREFIX)
const kindOf = (s: PipedreamStep) => /__portingCapture\(steps, '(\w+)'/.exec(s.uses.code ?? '')?.[1]

describe.skipIf(!present)(`instrumenter over the real export at ${EXPORT_DIR}`, () => {
  const files = present ? exportFiles(EXPORT_DIR) : []
  const results = files.map((file) => {
    const wf = JSON.parse(readFileSync(file, 'utf8')) as PipedreamWorkflow
    return { file, original: wf, ...instrumentWorkflow(wf, { receiverBaseUrl: 'https://ops.invalid' }) }
  })

  it('reads every workflow in the export', () => {
    expect(results.length).toBe(346)
  })

  it('puts a start capture first in every workflow', () => {
    for (const r of results) expect(kindOf(r.workflow.steps[0]), r.file).toBe('start')
  })

  it('puts a terminal capture before every enabled end-workflow step in every pipeline, branches included', () => {
    let ends = 0
    let inBranches = 0
    for (const r of results) {
      for (const [pipeline, steps] of pipelinesOf(r.workflow)) {
        steps.forEach((s, i) => {
          if (s.component_key !== 'end-end-workflow' || s.disabled) return
          ends++
          if (pipeline !== 'main') inBranches++
          expect(kindOf(steps[i - 1]), `${r.file} ${pipeline} ${s.namespace}`).toBe('terminal')
        })
      }
    }
    expect(ends).toBeGreaterThan(150)
    expect(inBranches).toBeGreaterThan(100)
  })

  it('ends every top level pipeline in a terminal, or in an enabled end-workflow that has one before it', () => {
    for (const r of results) {
      const steps = r.workflow.steps
      const last = steps[steps.length - 1]
      const lastEnabled = [...steps].reverse().find((s) => !s.disabled)!
      const ok = kindOf(last) === 'terminal' || (lastEnabled.component_key === 'end-end-workflow' && kindOf(steps[steps.indexOf(lastEnabled) - 1]) === 'terminal')
      expect(ok, r.file).toBe(true)
    }
  })

  it('adds only before-end and after-return captures to branch pipelines, never a terminal at a branch end', () => {
    for (const r of results) {
      for (const [pipeline, steps] of pipelinesOf(r.workflow)) {
        if (pipeline === 'main') continue
        steps.forEach((s, i) => {
          if (!isCapture(s)) return
          const next = steps[i + 1]
          const prev = steps[i - 1]
          const beforeEnd = kindOf(s) === 'terminal' && next?.component_key === 'end-end-workflow'
          const afterReturn = kindOf(s) === 'responded' && prev?.component_key === 'http-return-http-response'
          expect(beforeEnd || afterReturn, `${r.file} ${pipeline} ${s.namespace}`).toBe(true)
        })
      }
    }
  })

  it('accounts for every flow.exit and respond in enabled code, on any receiver: rewritten or refused by name', () => {
    // A step refused as a whole (no run method, unparseable, ...) is one hand
    // item covering every site in it, so its sites are counted there instead.
    const WHOLE_STEP = new Set(['no_run_method', 'unsupported_run_parameters', 'unparseable_code', 'already_instrumented'])
    const isAlias = (reason: string) => reason === 'exit_alias' || reason === 'respond_alias'
    const totals = { exits: 0, responds: 0 }
    const mismatches: string[] = []
    for (const r of results) {
      for (const [pipeline, steps] of pipelinesOf(r.original)) {
        for (const s of steps) {
          if (s.disabled || typeof s.uses?.code !== 'string' || s.uses.registry === true || (s.props && '_controlFlow' in s.props)) continue
          const witness = rawCounts(s.uses.code)
          const here = (x: { pipeline: string; step: string }) => x.pipeline === pipeline && x.step === s.namespace
          const refused = r.refused.filter(here)
          if (refused.some((x) => WHOLE_STEP.has(x.reason))) continue
          const captured = r.sites.filter((x) => here(x) && x.how === 'code_call')
          const handled = {
            exits: captured.filter((x) => x.kind === 'terminal').length + refused.filter((x) => x.reason.startsWith('exit_') && !isAlias(x.reason)).length,
            responds: captured.filter((x) => x.kind === 'responded').length + refused.filter((x) => x.reason.startsWith('respond_') && !isAlias(x.reason)).length,
            aliases: refused.filter((x) => isAlias(x.reason)).length,
          }
          totals.exits += witness.exits
          totals.responds += witness.responds
          if (handled.exits !== witness.exits || handled.responds !== witness.responds || handled.aliases !== witness.aliases) {
            mismatches.push(`${r.file} ${pipeline}/${s.namespace}: witness ${JSON.stringify(witness)}, handled ${JSON.stringify(handled)}`)
          }
        }
      }
    }
    expect(totals.exits).toBeGreaterThan(0)
    expect(totals.responds).toBeGreaterThan(0)
    expect(mismatches).toEqual([])
  })

  it('leaves every rewritten code step parseable', () => {
    for (const r of results) {
      for (const [, steps] of pipelinesOf(r.workflow)) {
        for (const s of steps) {
          if (typeof s.uses?.code !== 'string' || !s.uses.code.includes('__portingCapture')) continue
          expect(() => babelParse(s.uses.code!, parseOpts), `${r.file} ${s.namespace}`).not.toThrow()
        }
      }
    }
  })

  it('refuses nothing as unparseable and nothing for an unknown reason', () => {
    const reasons = new Set(results.flatMap((r) => r.refused.map((x) => x.reason)))
    expect(reasons.has('unparseable_code')).toBe(false)
    expect(reasons.has('invalid_hashid')).toBe(false)
  })
})
