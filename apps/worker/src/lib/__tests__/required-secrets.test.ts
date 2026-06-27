import { describe, it, expect } from 'vitest'
import { findMissingRequiredSecrets, REQUIRED_SECRETS, REQUIRED_PARTNER_SECRETS } from '../required-secrets'
import type { Env } from '../../index'

/** An env where every required secret (core + partner) is present and non-empty. */
function fullSecretEnv(): Record<string, string> {
  const e: Record<string, string> = {}
  for (const k of [...REQUIRED_SECRETS, ...REQUIRED_PARTNER_SECRETS]) e[k] = 'set-value'
  return e
}

describe('findMissingRequiredSecrets', () => {
  it('returns empty when every required secret is set', () => {
    expect(findMissingRequiredSecrets(fullSecretEnv() as unknown as Env)).toEqual([])
  })

  it('flags a required secret that is absent', () => {
    const env = fullSecretEnv()
    delete env.SSN_HASH_PEPPER
    expect(findMissingRequiredSecrets(env as unknown as Env)).toEqual(['SSN_HASH_PEPPER'])
  })

  it('treats an empty string as missing', () => {
    const env = fullSecretEnv()
    env.SUPABASE_SECRET_KEY = ''
    expect(findMissingRequiredSecrets(env as unknown as Env)).toContain('SUPABASE_SECRET_KEY')
  })

  it('treats a whitespace-only value as missing', () => {
    const env = fullSecretEnv()
    env.SNOWFLAKE_USER = '   '
    expect(findMissingRequiredSecrets(env as unknown as Env)).toContain('SNOWFLAKE_USER')
  })

  it('does not flag optional keys that are absent', () => {
    const missing = findMissingRequiredSecrets(fullSecretEnv() as unknown as Env)
    expect(missing).not.toContain('GITHUB_TOKEN')
    expect(missing).not.toContain('ANTHROPIC_API_KEY')
    expect(missing).not.toContain('DEPLOYED_SHA')
    expect(missing).not.toContain('SALESFORCE_BULKHEAD_LIMIT')
  })

  it('does not flag non-secret vars that ship defaults in wrangler.toml', () => {
    const missing = findMissingRequiredSecrets(fullSecretEnv() as unknown as Env)
    expect(missing).not.toContain('APP_URL')
    expect(missing).not.toContain('SUPABASE_JWKS_URL')
    expect(missing).not.toContain('PII_REDACTION_FIELDS')
  })

  it('reports multiple missing secrets in REQUIRED_SECRETS order', () => {
    const env = fullSecretEnv()
    delete env.SNOWFLAKE_ROLE
    delete env.SUPABASE_URL
    expect(findMissingRequiredSecrets(env as unknown as Env)).toEqual(['SUPABASE_URL', 'SNOWFLAKE_ROLE'])
  })

  it('includes the two non-recoverable secrets in the required set', () => {
    expect(REQUIRED_SECRETS).toContain('SSN_HASH_PEPPER')
    expect(REQUIRED_SECRETS).toContain('SECRET_ENCRYPTION_KEY')
  })

  it('flags a missing partner secret (Equifax EQUIFAX_PASSWORD)', () => {
    const env = fullSecretEnv()
    delete env.EQUIFAX_PASSWORD
    expect(findMissingRequiredSecrets(env as unknown as Env)).toEqual(['EQUIFAX_PASSWORD'])
  })

  it('only requires partner values that are genuine worker secrets', () => {
    expect(REQUIRED_PARTNER_SECRETS).toContain('SALESFORCE_CLIENT_SECRET')
    expect(REQUIRED_PARTNER_SECRETS).toContain('TRIPOINT_PROXY_SECRET')
    expect(REQUIRED_PARTNER_SECRETS).toContain('EQUIFAX_PASSWORD')
  })

  it('does not require partner config that lives in the environment_variables table (guarded by #394) or misnamed keys', () => {
    // SALESFORCE_INSTANCE_URL / SALESFORCE_CLIENT_ID are non-secret DB env vars,
    // not worker secrets, so this guard always saw them as absent (false positive).
    // EQ_USER / EQ_PASS never existed (the real keys are EQUIFAX_USERNAME in the DB
    // and EQUIFAX_PASSWORD as a worker secret).
    expect(REQUIRED_PARTNER_SECRETS).not.toContain('SALESFORCE_INSTANCE_URL')
    expect(REQUIRED_PARTNER_SECRETS).not.toContain('SALESFORCE_CLIENT_ID')
    expect(REQUIRED_PARTNER_SECRETS).not.toContain('EQ_USER')
    expect(REQUIRED_PARTNER_SECRETS).not.toContain('EQ_PASS')
    expect(REQUIRED_PARTNER_SECRETS).not.toContain('EQUIFAX_USERNAME')
  })

  it('does not require feature-gated partner secrets (Achieve, Scout)', () => {
    const all = [...REQUIRED_SECRETS, ...REQUIRED_PARTNER_SECRETS] as string[]
    expect(all).not.toContain('ACHIEVE_USERNAME')
    expect(all).not.toContain('ACHIEVE_PASSWORD')
    expect(all).not.toContain('ACHIEVE_API_URL')
    expect(all).not.toContain('SCOUT_KEY')
  })
})
