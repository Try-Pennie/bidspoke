import { describe, it, expect } from 'vitest'
import type { ExecutionContext } from '../../types'
import {
  isShadowDryRun,
  shadowIntegrationStub,
  shadowSalesforceStub,
  shadowPartnerBidStub,
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

describe('isShadowDryRun', () => {
  it('is true only when shadow_mode is dry_run', () => {
    expect(isShadowDryRun(ctx('dry_run'))).toBe(true)
    expect(isShadowDryRun(ctx('off'))).toBe(false)
    expect(isShadowDryRun(ctx(undefined))).toBe(false)
  })
})

describe('shadow stubs', () => {
  it('integration stub is a tagged 200 with empty body/headers', () => {
    expect(shadowIntegrationStub().output).toEqual({ status: 200, body: { _shadow: true }, headers: {} })
  })
  it('salesforce stub is a tagged 200', () => {
    expect(shadowSalesforceStub().output).toEqual({ status: 200, body: { _shadow: true } })
  })
  it('partner bid stub is a tagged skip carrying the slug', () => {
    expect(shadowPartnerBidStub('tripoint').output).toEqual({
      partner: 'tripoint',
      bid: null,
      accepted: false,
      skipped: true,
      skip_reason: 'shadow',
      _shadow: true,
    })
  })
  it('achieve stub is a tagged non-accept with no evaluation marker', () => {
    const out = shadowAchieveStub().output as Record<string, unknown>
    expect(out._shadow).toBe(true)
    expect(out.accepted).toBe(false)
    expect(out._achieve_evaluation).toBeUndefined()
  })
})
