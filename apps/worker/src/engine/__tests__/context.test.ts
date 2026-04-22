import { describe, it, expect } from 'vitest'
import { resolveValue, buildContext, recordStepOutput } from '../context'
import type { ExecutionContext } from '../../types'

function ctxWith(steps: Record<string, unknown>, env: Record<string, string> = {}): ExecutionContext {
  const c = buildContext({}, 'test', 'wf', 'trace', env, 'org')
  for (const [ns, output] of Object.entries(steps)) {
    recordStepOutput(c, ns, { output, status: 'completed' })
  }
  return c
}

describe('resolveValue — template resolution', () => {
  it('resolves {{steps.X}} to the step output', () => {
    const c = ctxWith({ foo: { name: 'bar' } })
    expect(resolveValue('{{steps.foo}}', c)).toEqual({ name: 'bar' })
  })

  it('resolves {{steps.X.Y}} to a nested field', () => {
    const c = ctxWith({ foo: { name: 'bar' } })
    expect(resolveValue('{{steps.foo.name}}', c)).toBe('bar')
  })

  it('tolerates explicit .output — {{steps.X.output}} resolves like {{steps.X}}', () => {
    const c = ctxWith({ foo: { name: 'bar' } })
    expect(resolveValue('{{steps.foo.output}}', c)).toEqual({ name: 'bar' })
  })

  it('tolerates explicit .output — {{steps.X.output.Y}} resolves like {{steps.X.Y}}', () => {
    const c = ctxWith({ foo: { name: 'bar' } })
    expect(resolveValue('{{steps.foo.output.name}}', c)).toBe('bar')
  })

  it('resolves deep paths with .output', () => {
    const c = ctxWith({ foo: { a: { b: { c: 'deep' } } } })
    expect(resolveValue('{{steps.foo.output.a.b.c}}', c)).toBe('deep')
    expect(resolveValue('{{steps.foo.a.b.c}}', c)).toBe('deep')
  })

  it('resolves env vars', () => {
    const c = ctxWith({}, { API_KEY: 'secret' })
    expect(resolveValue('{{env.API_KEY}}', c)).toBe('secret')
  })

  it('resolves trigger payload fields', () => {
    const c = buildContext({ leadId: '123' }, 'test', 'wf', 'trace', {}, 'org')
    expect(resolveValue('{{trigger.payload.leadId}}', c)).toBe('123')
  })

  it('returns undefined for unknown step', () => {
    const c = ctxWith({})
    expect(resolveValue('{{steps.nope}}', c)).toBeUndefined()
  })

  it('recursively resolves templates inside objects', () => {
    const c = ctxWith({ foo: { name: 'bar' } })
    const result = resolveValue({ record: '{{steps.foo.output}}', tag: 'static' }, c)
    expect(result).toEqual({ record: { name: 'bar' }, tag: 'static' })
  })

  it('interpolates templates inside larger strings', () => {
    const c = ctxWith({ foo: { name: 'bar' } })
    expect(resolveValue('Hello {{steps.foo.output.name}}', c)).toBe('Hello bar')
  })
})
