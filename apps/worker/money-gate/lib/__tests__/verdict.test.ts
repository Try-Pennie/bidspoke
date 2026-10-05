import { describe, it, expect } from 'vitest'
import { gateVerdict, staleness, STALE_WARN_DAYS, STALE_REMIND_DAYS } from '../verdict'
import type { FixtureRecord, Transcript } from '../compare'

const fx = (route: string, nodes = ['a', 'b']): FixtureRecord => ({
  id: 'W/x', workflow_id: 'w', workflow_name: 'W', variant: 'x', run_kind: 'live', trigger: {}, routes: [{ node: 'b', namespace: 'b', type: 'branch', route }],
  nodes_executed: nodes, final_node: 'b', response: { status: 200, body: {} }, outbound: [], code_dispatch: [], supabase_writes: [], do_state: {}, kv_state: {},
})
// Every workflow is also replayed as a test run and a shadow run (#1730). These
// twins are the same on both sides, so each test below differs only where it says.
const twins = (f: FixtureRecord[]): FixtureRecord[] =>
  f.length === 0 ? [] : (['test', 'shadow_dry_run'] as const).map((k) => ({ ...fx('yes', f[0].nodes_executed), id: `W/x as ${k}`, run_kind: k }))
const t = (side: 'base' | 'head', f: FixtureRecord[], kinds = true): Transcript => ({
  version: 1, side, fixtures: kinds ? [...f, ...twins(f)] : f, unstubbed_hosts: [], unknown_tables: [],
  workflows: [{ workflow_id: 'w', workflow_name: 'W', nodes: ['a', 'b'], arms: [{ node: 'b', namespace: 'b', handles: ['yes', 'else'] }] }],
})
const NOW = new Date('2026-10-01T00:00:00Z')

type VerdictInput = Parameters<typeof gateVerdict>[0]
const verdict = (base: Transcript, head: Transcript, over: Partial<VerdictInput> = {}) =>
  gateVerdict({ base, head, shapesExportedAt: '2026-09-30T00:00:00Z', now: NOW, committedDefinitionIds: ['w'], expectedHead: null, expectedBase: null, ...over })

const EXCUSE = JSON.stringify({ entries: [{ workflow: 'W', check: 'route', node: 'b', field: 'route', reason: 'The branch now routes else for this lead, as agreed in #1' }] })

describe('staleness', () => {
  it('is quiet before day 23, warns from day 23 and asks for a reminder from day 30, and never blocks', () => {
    expect(STALE_WARN_DAYS).toBe(23)
    expect(STALE_REMIND_DAYS).toBe(30)
    expect(staleness('2026-09-10T00:00:00Z', NOW)).toEqual({ days: 21, level: 'fresh' })
    expect(staleness('2026-09-08T00:00:00Z', NOW)).toEqual({ days: 23, level: 'warn' })
    expect(staleness('2026-08-31T00:00:00Z', NOW)).toEqual({ days: 31, level: 'remind' })
  })
})

describe('gateVerdict', () => {
  it('passes when the sides agree, printing coverage', () => {
    const v = verdict(t('base', [fx('yes')]), t('head', [fx('yes')]))
    expect(v.exitCode).toBe(0)
    expect(v.output).toContain('money gate: no difference between base and head')
    expect(v.output).toContain('not reached: b -> else')
  })

  it('fails on a difference, naming the check', () => {
    const v = verdict(t('base', [fx('yes')]), t('head', [fx('else')]))
    expect(v.exitCode).toBe(1)
    expect(v.output).toContain('[route] W/x node b field route: base "yes" head "else"')
    expect(v.output).toContain('checks that fired: route (1)')
    expect(v.output).toContain('first difference of each check:')
  })

  it('caps the full list so a sweeping change stays readable', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ ...fx('yes'), id: `W/x${i}`, variant: `x${i}` }))
    const flipped = many.map((f) => ({ ...f, routes: [{ ...f.routes[0], route: 'else' }] }))
    const v = verdict(t('base', many), t('head', flipped))
    expect(v.output).toContain('checks that fired: route (400)')
    expect(v.output).toContain('100 more differences not shown')
  })

  it('fails when a workflow executed no node, on either side', () => {
    const v = verdict(t('base', [fx('yes', [])]), t('head', [fx('yes', [])]))
    expect(v.exitCode).toBe(1)
    expect(v.output).toContain('W executed no node in any fixture')
  })

  it('warns, and does not fail, on stale shapes', () => {
    const v = verdict(t('base', [fx('yes')]), t('head', [fx('yes')]), { shapesExportedAt: '2026-08-01T00:00:00Z' })
    expect(v.exitCode).toBe(0)
    expect(v.output).toMatch(/warning: the fixture shapes are 61 days old/)
  })

  it('passes a difference excused by an entry new in this change, and still prints it with its reason', () => {
    const v = verdict(t('base', [fx('yes')]), t('head', [fx('else')]), { expectedHead: EXCUSE })
    expect(v.exitCode).toBe(0)
    expect(v.output).toContain('money gate: 1 difference(s) excused by expected-changes.json, 0 not excused')
    expect(v.output).toContain('[route] W/x node b field route: base "yes" head "else" (excused: The branch now routes else for this lead, as agreed in #1)')
  })

  it('an entry carried over from the merge base excuses nothing', () => {
    const v = verdict(t('base', [fx('yes')]), t('head', [fx('else')]), { expectedHead: EXCUSE, expectedBase: EXCUSE })
    expect(v.exitCode).toBe(1)
    expect(v.output).toContain('carried over from the merge base, excusing nothing')
  })

  it('fails by name on a new entry that matches no difference', () => {
    const v = verdict(t('base', [fx('yes')]), t('head', [fx('yes')]), { expectedHead: EXCUSE })
    expect(v.exitCode).toBe(1)
    expect(v.output).toContain('money gate: expected change for W route node b field "route" matched no difference')
  })

  it('fails by name on a malformed expected-changes file', () => {
    const v = verdict(t('base', [fx('yes')]), t('head', [fx('yes')]), { expectedHead: '{ nope' })
    expect(v.exitCode).toBe(1)
    expect(v.output).toContain('expected-changes.json does not parse')
  })

  it('fails by name on a malformed merge base file, rather than reading it as empty and letting old entries excuse again', () => {
    const v = verdict(t('base', [fx('yes')]), t('head', [fx('else')]), { expectedHead: EXCUSE, expectedBase: '{ nope' })
    expect(v.exitCode).toBe(1)
    expect(v.output).toContain("money gate: the merge base's expected-changes.json does not parse as JSON")
    expect(v.output).not.toContain('(excused:')
  })

  it('fails when either transcript holds no workflow or no fixture, rather than passing on nothing', () => {
    const empty: Transcript = { ...t('head', []), workflows: [] }
    for (const [base, head, side] of [[t('base', [fx('yes')]), empty, 'head'], [empty, t('head', [fx('yes')]), 'base']] as const) {
      const v = verdict(base, head)
      expect(v.exitCode).toBe(1)
      expect(v.output).toContain(`money gate: the ${side} transcript holds no workflow`)
      expect(v.output).toContain(`money gate: the ${side} transcript holds no fixture`)
    }
  })

  it('fails when a workflow was replayed only live, naming each kind it was not replayed as', () => {
    const v = verdict(t('base', [fx('yes')], false), t('head', [fx('yes')], false))
    expect(v.exitCode).toBe(1)
    expect(v.output).toContain('money gate: W replayed no test run fixture')
    expect(v.output).toContain('money gate: W replayed no shadow dry_run fixture')
  })

  it('fails when the head replayed fewer workflows than are committed', () => {
    const v = verdict(t('base', [fx('yes')]), t('head', [fx('yes')]), { committedDefinitionIds: ['w', 'missing-1'] })
    expect(v.exitCode).toBe(1)
    expect(v.output).toContain('money gate: committed definitions the head did not replay: missing-1')
  })
})
