import { describe, expect, it } from 'vitest'
import { hasVariables, readAppActionConfig, readStepArgs } from './step-config'
import type { ActionSchema } from './types'

/**
 * An app_action step's settings (#2339): which action, at which version, through
 * which connection, with which arguments. One reading of them, shared by the
 * definition validator (at save) and the ops executor (at run), so the two can
 * never disagree about what a step holds (L342).
 */

const CONNECTION = '33333333-3333-4333-8333-333333333333'

const ACTION: ActionSchema = {
  key: 'fixture.send',
  name: 'Send',
  version: 2,
  arguments: [
    { key: 'channel', type: 'dropdown', required: true, allowsVariables: false, parseJson: false, source: { lookup: 'channels' } },
    { key: 'text', type: 'text', required: true, allowsVariables: true, parseJson: false },
    { key: 'sql', type: 'code', required: false, allowsVariables: false, parseJson: false },
    { key: 'binds', type: 'list', required: false, allowsVariables: true, parseJson: true },
    { key: 'rows', type: 'code', required: false, allowsVariables: true, parseJson: true },
  ],
  sideEffect: true,
  idempotent: false,
  idempotentBecause: 'A fixture.',
}

describe('readAppActionConfig', () => {
  it('reads the service, the action key, its pinned version, the connection and the arguments', () => {
    expect(readAppActionConfig({ service: 'fixture', action: 'fixture.send', actionVersion: 2, connection: CONNECTION, args: { text: 'hi' } })).toEqual({
      ok: true,
      config: { service: 'fixture', action: 'fixture.send', actionVersion: 2, connection: CONNECTION, args: { text: 'hi' } },
    })
  })

  it('names each thing a half built step lacks, in the setup order', () => {
    expect(readAppActionConfig({})).toMatchObject({ ok: false, reason: 'action_not_chosen' })
    expect(readAppActionConfig({ service: 'fixture', action: 'fixture.send' })).toMatchObject({ ok: false, reason: 'action_version_not_pinned' })
    expect(readAppActionConfig({ service: 'fixture', action: 'fixture.send', actionVersion: 2 })).toMatchObject({ ok: false, reason: 'connection_not_chosen' })
  })

  it('refuses a version that is not a whole number from 1, rather than reading it as a version (L50)', () => {
    for (const actionVersion of ['2', 0, 1.5, -1, null]) {
      expect(readAppActionConfig({ service: 'fixture', action: 'fixture.send', actionVersion, connection: CONNECTION }), String(actionVersion)).toMatchObject({
        ok: false, reason: 'action_version_not_pinned',
      })
    }
  })

  it('refuses a connection that is not a connection id, and never falls back to another connection (L75)', () => {
    for (const connection of ['trypennie', 'CONN_33333333', 42, '']) {
      expect(readAppActionConfig({ service: 'fixture', action: 'fixture.send', actionVersion: 2, connection })).toMatchObject({
        ok: false, reason: connection === '' ? 'connection_not_chosen' : 'connection_id_invalid',
      })
    }
  })

  it('refuses an action of another service than the step names', () => {
    expect(readAppActionConfig({ service: 'slack', action: 'fixture.send', actionVersion: 2, connection: CONNECTION })).toMatchObject({ ok: false, reason: 'action_service_mismatch' })
  })

  it('refuses arguments that are not an object, and reads absent arguments as none', () => {
    expect(readAppActionConfig({ service: 'fixture', action: 'fixture.send', actionVersion: 2, connection: CONNECTION, args: ['x'] })).toMatchObject({ ok: false, reason: 'args_not_object' })
    expect(readAppActionConfig({ service: 'fixture', action: 'fixture.send', actionVersion: 2, connection: CONNECTION })).toMatchObject({ ok: true, config: { args: {} } })
  })
})

describe('readStepArgs against the pinned version\'s schema', () => {
  const read = (args: Record<string, unknown>) => readStepArgs(ACTION, args)

  it('passes a step holding every required argument, parsing JSON text where the argument says to', () => {
    expect(read({ channel: 'C1', text: 'Hello {{steps.a.output.name}}', binds: '["{{steps.a.output.id}}", 3]', rows: '[[1, null]]' })).toEqual({
      ok: true,
      args: { channel: 'C1', text: 'Hello {{steps.a.output.name}}', binds: ['{{steps.a.output.id}}', 3], rows: [[1, null]] },
    })
  })

  it('takes a JSON argument already held as a value, and a whole reference standing for one', () => {
    expect(read({ channel: 'C1', text: 'x', binds: ['a', 1], rows: '{{steps.load.output.rows}}' })).toEqual({
      ok: true, args: { channel: 'C1', text: 'x', binds: ['a', 1], rows: '{{steps.load.output.rows}}' },
    })
  })

  it('names every problem, each with the argument it is about', () => {
    const r = read({ text: '  ', channel: '{{steps.a.output.c}}', sql: 7, binds: '[1,', rows: '{"a": 1}', extra: 'x' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems.map((p) => [p.reason, p.argument])).toEqual([
      ['argument_variables_not_allowed', 'channel'],
      ['argument_missing', 'text'],
      ['argument_not_text', 'sql'],
      ['argument_json_invalid', 'binds'],
      ['argument_unknown', 'extra'],
    ])
    for (const p of r.problems) expect(p.message).toContain(p.argument)
  })

  it('refuses a list argument whose JSON is not a list', () => {
    const r = read({ channel: 'C1', text: 'x', binds: '{"a": 1}' })
    expect(r).toMatchObject({ ok: false, problems: [{ reason: 'argument_not_list', argument: 'binds' }] })
  })

  it('leaves an optional argument out when it is absent or blank', () => {
    expect(read({ channel: 'C1', text: 'x', sql: '', binds: null })).toEqual({ ok: true, args: { channel: 'C1', text: 'x' } })
  })

  it('reads an own key only: an argument named like an inherited property is unknown', () => {
    const r = read({ channel: 'C1', text: 'x', constructor: 'y' })
    expect(r).toMatchObject({ ok: false, problems: [{ reason: 'argument_unknown', argument: 'constructor' }] })
  })
})

describe('hasVariables', () => {
  it('finds a reference at any depth', () => {
    expect(hasVariables('a {{steps.x.output}}')).toBe(true)
    expect(hasVariables([1, { b: ['{{trigger.payload.id}}'] }])).toBe(true)
    expect(hasVariables({ a: 'plain', b: [1, 'two'] })).toBe(false)
  })
})
