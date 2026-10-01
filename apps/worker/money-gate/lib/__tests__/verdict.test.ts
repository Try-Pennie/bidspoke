import { describe, it, expect } from 'vitest'
import { gateVerdict, staleness, STALE_WARN_DAYS, STALE_REMIND_DAYS } from '../verdict'
import type { FixtureRecord, Transcript } from '../compare'

const fx = (route: string, nodes = ['a', 'b']): FixtureRecord => ({
  id: 'W/x', workflow_id: 'w', workflow_name: 'W', variant: 'x', trigger: {}, routes: [{ node: 'b', namespace: 'b', type: 'branch', route }],
  nodes_executed: nodes, final_node: 'b', response: { status: 200, body: {} }, outbound: [], code_dispatch: [], supabase_writes: [], do_state: {}, kv_state: {},
})
const t = (side: 'base' | 'head', f: FixtureRecord[]): Transcript => ({
  version: 1, side, fixtures: f, unstubbed_hosts: [], unknown_tables: [],
  workflows: [{ workflow_id: 'w', workflow_name: 'W', nodes: ['a', 'b'], arms: [{ node: 'b', namespace: 'b', handles: ['yes', 'else'] }] }],
})
const NOW = new Date('2026-10-01T00:00:00Z')

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
    const v = gateVerdict({ base: t('base', [fx('yes')]), head: t('head', [fx('yes')]), shapesExportedAt: '2026-09-30T00:00:00Z', now: NOW })
    expect(v.exitCode).toBe(0)
    expect(v.output).toContain('money gate: no difference between base and head')
    expect(v.output).toContain('not reached: b -> else')
  })

  it('fails on a difference, naming the check', () => {
    const v = gateVerdict({ base: t('base', [fx('yes')]), head: t('head', [fx('else')]), shapesExportedAt: '2026-09-30T00:00:00Z', now: NOW })
    expect(v.exitCode).toBe(1)
    expect(v.output).toContain('[route] W/x node b field route: base "yes" head "else"')
    expect(v.output).toContain('checks that fired: route (1)')
    expect(v.output).toContain('first difference of each check:')
  })

  it('caps the full list so a sweeping change stays readable', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ ...fx('yes'), id: `W/x${i}`, variant: `x${i}` }))
    const flipped = many.map((f) => ({ ...f, routes: [{ ...f.routes[0], route: 'else' }] }))
    const v = gateVerdict({ base: t('base', many), head: t('head', flipped), shapesExportedAt: '2026-09-30T00:00:00Z', now: NOW })
    expect(v.output).toContain('checks that fired: route (400)')
    expect(v.output).toContain('100 more differences not shown')
  })

  it('fails when a workflow executed no node, on either side', () => {
    const v = gateVerdict({ base: t('base', [fx('yes', [])]), head: t('head', [fx('yes', [])]), shapesExportedAt: '2026-09-30T00:00:00Z', now: NOW })
    expect(v.exitCode).toBe(1)
    expect(v.output).toContain('W executed no node in any fixture')
  })

  it('warns, and does not fail, on stale shapes', () => {
    const v = gateVerdict({ base: t('base', [fx('yes')]), head: t('head', [fx('yes')]), shapesExportedAt: '2026-08-01T00:00:00Z', now: NOW })
    expect(v.exitCode).toBe(0)
    expect(v.output).toMatch(/warning: the fixture shapes are 61 days old/)
  })
})
