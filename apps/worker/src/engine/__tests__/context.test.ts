import { describe, it, expect, vi } from 'vitest'
import { resolveValue, buildContext, recordStepOutput, findUndefinedPaths, warnDroppedBodyFields } from '../context'
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

  it('?? coalesce picks the first non-null operand (whichever step ran)', () => {
    const onlyB = ctxWith({ b: { v: 7 } })
    expect(resolveValue('{{steps.a.output.v ?? steps.b.output.v}}', onlyB)).toBe(7)
    const onlyA = ctxWith({ a: { v: 3 } })
    expect(resolveValue('{{steps.a.output.v ?? steps.b.output.v}}', onlyA)).toBe(3)
  })

  it('?? coalesce keeps a real false (uses null/undefined semantics, not ||)', () => {
    const c = ctxWith({ a: { ok: false } })
    expect(resolveValue('{{steps.a.output.ok ?? steps.b.output.ok}}', c)).toBe(false)
  })

  it('concatenates adjacent {{a}}{{b}}{{c}} expressions into a string (no single-expr over-match)', () => {
    // Regression: the single-expression regex used to over-match this whole
    // string because the trailing `$` forced the non-greedy capture to swallow
    // the interior `}}{{`, feeding a malformed path to resolveExpression. It
    // resolved to undefined and the SF body key was silently dropped.
    const c = buildContext({ LEG: 2 }, 'test', 'wf', 'trace', {}, 'org')
    recordStepOutput(c, 'mutate_adv', { output: 1, status: 'completed' })
    recordStepOutput(c, 'mutate_bes', { output: 1, status: 'completed' })
    expect(
      resolveValue('{{steps.mutate_adv.output}}{{steps.mutate_bes.output}}{{trigger.payload.LEG}}', c)
    ).toBe('112')
  })

  it('drops the missing operand to empty string in a concatenation (never undefined)', () => {
    const c = buildContext({}, 'test', 'wf', 'trace', {}, 'org')
    recordStepOutput(c, 'mutate_adv', { output: 1, status: 'completed' })
    // mutate_bes never ran and trigger.payload.LEG is absent → both empty, key still present
    expect(
      resolveValue('{{steps.mutate_adv.output}}{{steps.mutate_bes.output}}{{trigger.payload.LEG}}', c)
    ).toBe('1')
  })
})

describe('findUndefinedPaths — dropped-field detection', () => {
  it('returns top-level keys whose value is undefined', () => {
    expect(findUndefinedPaths({ a: 1, b: undefined, c: 'x' })).toEqual(['b'])
  })

  it('returns nested dot-paths and array indices', () => {
    expect(findUndefinedPaths({ a: { b: undefined }, list: [1, undefined] })).toEqual([
      'a.b',
      'list[1]',
    ])
  })

  it('treats null and empty string as present (not dropped)', () => {
    expect(findUndefinedPaths({ a: null, b: '', c: 0, d: false })).toEqual([])
  })

  it('returns [] for a fully-resolved body', () => {
    expect(findUndefinedPaths({ ADV_SO__c: 1, XBC_SO__c: '112' })).toEqual([])
  })
})

describe('warnDroppedBodyFields', () => {
  it('emits a warn log + structured console.warn when fields drop', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logs = warnDroppedBodyFields(
      { ADV_SO__c: 1, XBC_SO__c: undefined },
      { nodeNamespace: 'send_salesforce', nodeLabel: 'send_salesforce', traceId: 't1' }
    )
    expect(logs).toHaveLength(1)
    expect(logs[0].level).toBe('warn')
    expect(logs[0].message).toContain('XBC_SO__c')
    expect(spy).toHaveBeenCalledOnce()
    const payload = JSON.parse(spy.mock.calls[0][0] as string)
    expect(payload).toMatchObject({ event: 'template_field_dropped', node: 'send_salesforce', fields: ['XBC_SO__c'] })
    spy.mockRestore()
  })

  it('returns [] and does not warn when nothing dropped', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(warnDroppedBodyFields({ a: 1 }, { traceId: 't1' })).toEqual([])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('resolveValue — arithmetic expressions', () => {
  it('multiplies two step references', () => {
    const c = ctxWith({ ping: { data: { bid_amount: 100 } }, constants: { multiplier: 0.65 } })
    expect(resolveValue('{{steps.ping.output.data.bid_amount * steps.constants.output.multiplier}}', c)).toBe(65)
  })

  it('supports number literals as operands', () => {
    const c = ctxWith({ x: { amount: 200 } })
    expect(resolveValue('{{steps.x.amount * 0.65}}', c)).toBe(130)
    expect(resolveValue('{{steps.x.amount + 50}}', c)).toBe(250)
    expect(resolveValue('{{steps.x.amount - 25}}', c)).toBe(175)
    expect(resolveValue('{{steps.x.amount / 4}}', c)).toBe(50)
  })

  it('applies standard precedence (* and / before + and -)', () => {
    const c = ctxWith({ x: { a: 2, b: 3, c: 4 } })
    expect(resolveValue('{{steps.x.a + steps.x.b * steps.x.c}}', c)).toBe(14)
    expect(resolveValue('{{steps.x.c - steps.x.b / steps.x.b}}', c)).toBe(3)
  })

  it('fails closed when an operand is missing or non-numeric', () => {
    const c = ctxWith({ x: { amount: 100, name: 'abc' } })
    expect(resolveValue('{{steps.x.nope * 2}}', c)).toBeUndefined()
    expect(resolveValue('{{steps.x.name * 2}}', c)).toBeUndefined()
  })

  it('fails closed on division by zero instead of serializing Infinity', () => {
    const c = ctxWith({ x: { amount: 100 } })
    expect(resolveValue('{{steps.x.amount / 0}}', c)).toBeUndefined()
  })

  it('does not treat dashed payload keys as subtraction', () => {
    const c = buildContext({ 'some-key': 'kept' }, 'test', 'wf', 'trace', {}, 'org')
    expect(resolveValue('{{trigger.payload.some-key}}', c)).toBe('kept')
  })

  it('requires whitespace around operators (a*b stays a plain lookup)', () => {
    const c = ctxWith({ x: { 'a*b': 'literal' } })
    expect(resolveValue('{{steps.x.a*b}}', c)).toBe('literal')
  })

  it('combines with ?? coalesce (arithmetic per operand)', () => {
    const c = ctxWith({ a: { x: 10 } })
    expect(resolveValue('{{steps.a.x * 2 ?? steps.b.y}}', c)).toBe(20)
    expect(resolveValue('{{steps.missing.x * 2 ?? steps.a.x}}', c)).toBe(10)
  })

  it('interpolates arithmetic results inside strings', () => {
    const c = ctxWith({ x: { amount: 100 } })
    expect(resolveValue('bid is {{steps.x.amount * 0.5}} dollars', c)).toBe('bid is 50 dollars')
  })
})

describe('resolveValue — bracket key lookup', () => {
  it('resolves a dynamic key from another reference', () => {
    const c = buildContext({ subAccountUuid: 'abc-123' }, 'test', 'wf', 'trace', {}, 'org')
    recordStepOutput(c, 'constants', { output: { uuid_map: { 'abc-123': 'tripoint' } }, status: 'completed' })
    expect(resolveValue('{{steps.constants.output.uuid_map[trigger.payload.subAccountUuid]}}', c)).toBe('tripoint')
  })

  it('resolves numeric array indexes', () => {
    const c = ctxWith({ x: { arr: [{ id: 'first' }, { id: 'second' }] } })
    expect(resolveValue('{{steps.x.output.arr[0].id}}', c)).toBe('first')
    expect(resolveValue('{{steps.x.arr[1].id}}', c)).toBe('second')
  })

  it('resolves quoted string keys (including keys with dots and spaces)', () => {
    const c = ctxWith({ x: { obj: { 'weird key.name': 'found' } } })
    expect(resolveValue("{{steps.x.obj['weird key.name']}}", c)).toBe('found')
  })

  it('fails closed when the dynamic key does not resolve', () => {
    const c = ctxWith({ constants: { uuid_map: { k: 'v' } } })
    expect(resolveValue('{{steps.constants.uuid_map[trigger.payload.missing]}}', c)).toBeUndefined()
  })

  it('fails closed on malformed brackets', () => {
    const c = ctxWith({ x: { arr: [1] } })
    expect(resolveValue('{{steps.x.arr[0}}', c)).toBeUndefined()
    expect(resolveValue('{{steps.x.arr[]}}', c)).toBeUndefined()
  })

  it('bracket lookup works as an arithmetic operand', () => {
    const c = buildContext({ tier: 'gold' }, 'test', 'wf', 'trace', {}, 'org')
    recordStepOutput(c, 'rates', { output: { by_tier: { gold: 1.5 } }, status: 'completed' })
    expect(resolveValue('{{steps.rates.by_tier[trigger.payload.tier] * 100}}', c)).toBe(150)
  })
})
