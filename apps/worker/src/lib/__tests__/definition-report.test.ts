import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportDefinition } from '../definition-report'

// validateDefinition runs report only on every money lane write (#1947 PR 3):
// it records what it would refuse and refuses nothing, so the enforcement flip
// is decided from measured saves rather than a guess (L56, L65).

const trigger = { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } }
const code = (id: string, script = 'return 1') => ({ id, type: 'code', namespace: id, config: { script } })
const clean = { trigger, nodes: [code('a')], edges: [] }

afterEach(() => vi.restoreAllMocks())

function logged(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
}

describe('reportDefinition', () => {
  it('logs a clean definition as one line with no problems and nothing it would refuse', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const report = reportDefinition(clean, { writer: 'save', workflowId: 'wf-1', lane: 'money', live: true, schemaVersion: 1 })
    expect(report).toEqual({ verdict: 'judged', schema_version: 1, stamped: true, problems: 0, by_rule: {}, would_refuse: 0, would_refuse_reasons: [] })
    expect(logged(log)).toEqual([{ event: 'definition_report', writer: 'save', workflow_id: 'wf-1', lane: 'money', live: true, ...report }])
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns, naming each rule and what it would refuse, when a rule would refuse the write', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const def = { trigger, nodes: [{ id: 'f', type: 'integration', namespace: 'fail_test', config: {} }, code('b', '')], edges: [{ source: 'f', target: 'b' }] }
    const draft = reportDefinition(def, { writer: 'restore', workflowId: 'wf-1', lane: 'money', live: false, schemaVersion: null })
    expect(draft).toMatchObject({ verdict: 'judged', schema_version: 1, stamped: false, by_rule: { node_type: 1, node_config: 1 }, would_refuse: 1, would_refuse_reasons: ['node_type_unknown'] })
    const live = reportDefinition(def, { writer: 'restore', workflowId: 'wf-1', lane: 'money', live: true, schemaVersion: null })
    expect(live).toMatchObject({ would_refuse: 2, would_refuse_reasons: ['node_type_unknown', 'node_unconfigured'] })
    expect(logged(warn).map((l) => [l.event, l.writer, l.would_refuse])).toEqual([['definition_report', 'restore', 1], ['definition_report', 'restore', 2]])
  })

  it('a warning alone (the old webhook spelling) is counted and refuses nothing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const report = reportDefinition({ ...clean, trigger: { ...trigger, type: 'webhook' } }, { writer: 'restore', workflowId: 'wf-1', lane: 'money', live: true, schemaVersion: null })
    expect(report).toMatchObject({ problems: 1, by_rule: { trigger: 1 }, would_refuse: 0 })
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('names a stamp newer than this build knows, never reads it as clean', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const report = reportDefinition(clean, { writer: 'switch_on', workflowId: 'wf-1', lane: 'money', live: true, schemaVersion: 99 })
    expect(report).toEqual({ verdict: 'unknown_schema_version', stamp: 99 })
    expect(logged(warn)[0]).toMatchObject({ event: 'definition_report', verdict: 'unknown_schema_version', stamp: 99 })
  })

  it('names a stored lane that is no lane, never judging it as money', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(reportDefinition(clean, { writer: 'save', workflowId: 'wf-1', lane: 'Money', live: true, schemaVersion: 1 })).toEqual({ verdict: 'invalid_lane' })
    expect(logged(warn)[0]).toMatchObject({ event: 'definition_report', verdict: 'invalid_lane', lane: 'Money' })
  })

  it('never throws into the write it reports on: a definition that cannot be read is logged as a failed report', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const hostile = new Proxy({}, { get() { throw new Error('unreadable') } })
    expect(reportDefinition(hostile, { writer: 'create', workflowId: null, lane: 'money', live: false, schemaVersion: 1 })).toEqual({ verdict: 'report_failed' })
    expect(logged(error)[0]).toMatchObject({ event: 'definition_report_failed', writer: 'create', error: 'unreadable' })
  })
})
