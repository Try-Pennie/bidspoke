import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'

vi.mock('../slack', () => ({
  sendRequiredSecretsAlert: vi.fn(async () => true),
}))

import { sendRequiredSecretsAlert } from '../slack'
import { runRequiredSecretsCheck, REQUIRED_SECRETS, REQUIRED_PARTNER_SECRETS } from '../required-secrets'
import { alertRowListAnswer } from '../../__tests__/helpers/slack-alert-read'

function fullSecretEnv(overrides: Record<string, string | undefined> = {}): Env {
  const e: Record<string, string | undefined> = { APP_URL: 'https://app.example' }
  for (const k of [...REQUIRED_SECRETS, ...REQUIRED_PARTNER_SECRETS]) e[k] = 'set-value'
  return { ...e, ...overrides } as unknown as Env
}

/** Minimal supabase double: from().select().eq() resolves to the given slack-connection rows. */
function fakeSupabase(orgRows: { organization_id: string }[]): SupabaseClient {
  return {
    from: () => ({
      select: () => alertRowListAnswer(Promise.resolve({ data: orgRows, error: null })),
    }),
  } as unknown as SupabaseClient
}

beforeEach(() => {
  vi.mocked(sendRequiredSecretsAlert).mockClear()
})

describe('runRequiredSecretsCheck', () => {
  it('does nothing and never alerts when all required secrets are set', async () => {
    const res = await runRequiredSecretsCheck(fakeSupabase([{ organization_id: 'org1' }]), fullSecretEnv())
    expect(res).toEqual({ missing: [], alerted: false })
    expect(sendRequiredSecretsAlert).not.toHaveBeenCalled()
  })

  it('alerts each distinct Slack org once when a required secret is missing', async () => {
    const env = fullSecretEnv({ SSN_HASH_PEPPER: undefined })
    const res = await runRequiredSecretsCheck(
      fakeSupabase([{ organization_id: 'org1' }, { organization_id: 'org1' }, { organization_id: 'org2' }]),
      env,
    )
    expect(res.missing).toEqual(['SSN_HASH_PEPPER'])
    expect(res.alerted).toBe(true)
    expect(sendRequiredSecretsAlert).toHaveBeenCalledTimes(2)
    const orgsAlerted = vi.mocked(sendRequiredSecretsAlert).mock.calls.map((c) => c[1]).sort()
    expect(orgsAlerted).toEqual(['org1', 'org2'])
    // The alert carries the missing keys so the message is actionable.
    expect(vi.mocked(sendRequiredSecretsAlert).mock.calls[0][2]).toEqual(['SSN_HASH_PEPPER'])
  })

  it('reports missing but not alerted when no Slack connections exist', async () => {
    const env = fullSecretEnv({ SNOWFLAKE_USER: '' })
    const res = await runRequiredSecretsCheck(fakeSupabase([]), env)
    expect(res.missing).toEqual(['SNOWFLAKE_USER'])
    expect(res.alerted).toBe(false)
    expect(sendRequiredSecretsAlert).not.toHaveBeenCalled()
  })
})
