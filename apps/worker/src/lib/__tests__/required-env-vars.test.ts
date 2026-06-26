import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'

vi.mock('../slack', () => ({
  sendRequiredEnvVarsAlert: vi.fn(async () => true),
}))

import { sendRequiredEnvVarsAlert } from '../slack'
import {
  runRequiredEnvVarsCheck,
  findMissingEnvVars,
  REQUIRED_ENV_VARS,
} from '../required-env-vars'

/** A full, valid set of the required non-secret config values. */
function fullVars(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const v: Record<string, string | undefined> = {}
  for (const k of REQUIRED_ENV_VARS) v[k] = 'set-value'
  return Object.fromEntries(
    Object.entries({ ...v, ...overrides }).filter(([, val]) => val !== undefined)
  ) as Record<string, string>
}

const env = { APP_URL: 'https://app.example' } as unknown as Env

/**
 * Supabase double: slack `service_connections` query returns `orgRows`; the
 * per-org `environment_variables` query returns `envByOrg[orgId]` (rows of
 * {key, value}), or a DB error when `errorOrgs` includes the org.
 */
function fakeSupabase(
  orgRows: { organization_id: string }[],
  envByOrg: Record<string, { key: string; value: string | null }[]>,
  errorOrgs: string[] = []
): SupabaseClient {
  return {
    from: (table: string) => {
      if (table === 'service_connections') {
        return { select: () => ({ eq: () => Promise.resolve({ data: orgRows, error: null }) }) }
      }
      // environment_variables: select().eq(org).eq(scope).is(is_secret)
      let orgId = ''
      const result = () =>
        errorOrgs.includes(orgId)
          ? Promise.resolve({ data: null, error: { message: 'connection reset' } })
          : Promise.resolve({ data: envByOrg[orgId] ?? [], error: null })
      const chain = {
        eq: (col: string, val: string) => {
          if (col === 'organization_id') orgId = val
          return chain
        },
        is: () => result(),
      }
      return { select: () => chain }
    },
  } as unknown as SupabaseClient
}

beforeEach(() => {
  vi.mocked(sendRequiredEnvVarsAlert).mockClear()
})

describe('findMissingEnvVars', () => {
  it('returns nothing when every required key is present and non-blank', () => {
    expect(findMissingEnvVars(fullVars())).toEqual([])
  })

  it('flags an absent required key', () => {
    expect(findMissingEnvVars(fullVars({ EQUIFAX_USERNAME: undefined }))).toEqual(['EQUIFAX_USERNAME'])
  })

  it('flags a blank or whitespace-only required key', () => {
    expect(findMissingEnvVars(fullVars({ SALESFORCE_CLIENT_ID: '   ' }))).toEqual(['SALESFORCE_CLIENT_ID'])
  })

  it('preserves declared order when multiple are missing', () => {
    const missing = findMissingEnvVars(fullVars({ SALESFORCE_INSTANCE_URL: '', EQUIFAX_USERNAME: '' }))
    expect(missing).toEqual(['SALESFORCE_INSTANCE_URL', 'EQUIFAX_USERNAME'])
  })
})

describe('runRequiredEnvVarsCheck', () => {
  it('does nothing and never alerts when all required env vars are present', async () => {
    const supabase = fakeSupabase(
      [{ organization_id: 'org1' }],
      { org1: REQUIRED_ENV_VARS.map((key) => ({ key, value: 'x' })) }
    )
    const res = await runRequiredEnvVarsCheck(supabase, env)
    expect(res.alerted).toBe(false)
    expect(res.missing).toEqual([])
    expect(sendRequiredEnvVarsAlert).not.toHaveBeenCalled()
  })

  it('alerts the org with the missing keys when a required env var is blank', async () => {
    const rows = REQUIRED_ENV_VARS.map((key) => ({ key, value: key === 'EQUIFAX_USERNAME' ? '' : 'x' }))
    const supabase = fakeSupabase([{ organization_id: 'org1' }], { org1: rows })
    const res = await runRequiredEnvVarsCheck(supabase, env)
    expect(res.alerted).toBe(true)
    expect(res.missing).toEqual(['EQUIFAX_USERNAME'])
    expect(sendRequiredEnvVarsAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendRequiredEnvVarsAlert).mock.calls[0][1]).toBe('org1')
    expect(vi.mocked(sendRequiredEnvVarsAlert).mock.calls[0][2]).toEqual(['EQUIFAX_USERNAME'])
  })

  it('skips an org that has no non-secret env vars configured at all', async () => {
    const supabase = fakeSupabase([{ organization_id: 'newOrg' }], { newOrg: [] })
    const res = await runRequiredEnvVarsCheck(supabase, env)
    expect(res.alerted).toBe(false)
    expect(res.missing).toEqual([])
    expect(sendRequiredEnvVarsAlert).not.toHaveBeenCalled()
  })

  it('does not alert on a transient DB error (a blip must not page a false-missing)', async () => {
    const supabase = fakeSupabase([{ organization_id: 'org1' }], {}, ['org1'])
    const res = await runRequiredEnvVarsCheck(supabase, env)
    expect(res.alerted).toBe(false)
    expect(res.missing).toEqual([])
    expect(sendRequiredEnvVarsAlert).not.toHaveBeenCalled()
  })

  it('checks each distinct Slack org independently', async () => {
    const supabase = fakeSupabase(
      [{ organization_id: 'org1' }, { organization_id: 'org2' }],
      {
        org1: REQUIRED_ENV_VARS.map((key) => ({ key, value: 'x' })),
        org2: REQUIRED_ENV_VARS.map((key) => ({ key, value: key === 'SALESFORCE_INSTANCE_URL' ? '' : 'x' })),
      }
    )
    const res = await runRequiredEnvVarsCheck(supabase, env)
    expect(res.alerted).toBe(true)
    expect(sendRequiredEnvVarsAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendRequiredEnvVarsAlert).mock.calls[0][1]).toBe('org2')
  })
})
