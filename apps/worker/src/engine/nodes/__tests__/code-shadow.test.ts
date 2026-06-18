import { describe, it, expect } from 'vitest'
import { buildCodeSandboxBody } from '../code'
import type { ExecutionContext } from '../../../types'

function ctx(shadow_mode?: 'off' | 'dry_run'): ExecutionContext {
  return { trigger: { payload: { a: 1 }, source: 's', workflow_id: 'w', trace_id: 't', org_id: 'o' }, steps: {}, env: {}, shadow_mode }
}

describe('buildCodeSandboxBody — shadow_mode in sandbox body', () => {
  it('includes shadow_mode when dry_run', () => {
    const body = JSON.parse(buildCodeSandboxBody(ctx('dry_run'), {}, {}, {}))
    expect(body.shadow_mode).toBe('dry_run')
  })

  it('defaults shadow_mode to off when unset, and still carries the payload', () => {
    const body = JSON.parse(buildCodeSandboxBody(ctx(undefined), {}, {}, {}))
    expect(body.shadow_mode).toBe('off')
    expect(body.payload).toEqual({ a: 1 })
  })
})
