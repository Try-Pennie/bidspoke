import { describe, it, expect } from 'vitest'
import type { ExecutionContext } from '../../types'
import { shadowOf } from '../run-reality'
import {
  shadowIntegrationStub,
  shadowSalesforceStub,
  shadowAchieveStub,
} from '../shadow'

function ctx(shadow_mode?: 'off' | 'dry_run'): ExecutionContext {
  return {
    trigger: { payload: {}, source: 's', workflow_id: 'w', trace_id: 't', org_id: 'o' },
    steps: {},
    env: {},
    shadow_mode,
  }
}

describe('shadowOf(ctx).outboundStubbed', () => {
  it('is true for dry_run and false for off or unset', () => {
    expect(shadowOf(ctx('dry_run')).outboundStubbed).toBe(true)
    expect(shadowOf(ctx('off')).outboundStubbed).toBe(false)
    expect(shadowOf(ctx(undefined)).outboundStubbed).toBe(false)
  })
})

describe('shadow stubs', () => {
  it('integration stub is a tagged 200 with empty body/headers', () => {
    expect(shadowIntegrationStub().output).toEqual({ status: 200, body: { _shadow: true }, headers: {} })
  })
  it('salesforce stub is a tagged 200', () => {
    expect(shadowSalesforceStub().output).toEqual({ status: 200, body: { _shadow: true } })
  })
  it('achieve stub is a tagged non-accept with no evaluation marker', () => {
    const out = shadowAchieveStub().output as Record<string, unknown>
    expect(out._shadow).toBe(true)
    expect(out.accepted).toBe(false)
    expect(out._achieve_evaluation).toBeUndefined()
  })
})
