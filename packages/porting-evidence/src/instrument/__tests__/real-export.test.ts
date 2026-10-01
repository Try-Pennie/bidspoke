/**
 * The instrumenter over the REAL Pipedream export (#1705).
 *
 * The export holds partner code and configuration and is never committed, so
 * this reads it from the machine it lives on: `PIPEDREAM_EXPORT_DIR`, else the
 * folder the 2026-09-30 export was saved to. Where neither exists (CI) the suite
 * is reported as SKIPPED by name, never as passed (L411): the committed fixture
 * suites cover the same rules on a hand written workflow.
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

const EXPORT_DIR = process.env.PIPEDREAM_EXPORT_DIR ?? path.join(homedir(), 'Documents', 'Pipedream export', 'Pipedream export 26-09-30')
const present = existsSync(EXPORT_DIR)

const parseOpts: ParserOptions = { sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, plugins: ['jsx', 'topLevelAwait'] }

/** Counts calls of `X.flow.exit(` and `$.respond(` by walking a plain babel tree: an independent witness. */
function rawCounts(code: string): { exits: number; responds: number } {
  let exits = 0
  let responds = 0
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    const o = node as Record<string, unknown>
    if (o.type === 'CallExpression' || o.type === 'OptionalCallExpression') {
      const callee = o.callee as Record<string, unknown>
      const prop = (callee.property as { name?: string } | undefined)?.name
      const obj = callee.object as Record<string, unknown> | undefined
      const isMember = (x: Record<string, unknown> | undefined) => x?.type === 'MemberExpression' || x?.type === 'OptionalMemberExpression'
      if (isMember(callee) && prop === 'exit' && isMember(obj) && (obj!.property as { name?: string }).name === 'flow') exits++
      if (isMember(callee) && prop === 'respond' && obj?.type === 'Identifier' && obj.name === '$') responds++
    }
    for (const [k, v] of Object.entries(o)) if (k !== 'loc' && k !== 'start' && k !== 'end') walk(v)
  }
  walk(babelParse(code, parseOpts).program)
  return { exits, responds }
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

  it('accounts for every $.flow.exit and $.respond in enabled code: rewritten or refused by name', () => {
    let exits = 0
    let responds = 0
    let handledExits = 0
    let handledResponds = 0
    for (const r of results) {
      for (const [, steps] of pipelinesOf(r.original)) {
        for (const s of steps) {
          if (s.disabled || typeof s.uses?.code !== 'string' || s.uses.registry === true || (s.props && '_controlFlow' in s.props)) continue
          const c = rawCounts(s.uses.code)
          exits += c.exits
          responds += c.responds
        }
      }
      handledExits += r.sites.filter((x) => x.how === 'code_call' && x.kind === 'terminal').length
      handledExits += r.refused.filter((x) => x.reason.startsWith('exit_') && x.reason !== 'exit_alias').length
      handledResponds += r.sites.filter((x) => x.how === 'code_call' && x.kind === 'responded').length
      handledResponds += r.refused.filter((x) => x.reason.startsWith('respond_')).length
    }
    expect(exits).toBeGreaterThan(0)
    expect(handledExits).toBe(exits)
    expect(handledResponds).toBe(responds)
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
