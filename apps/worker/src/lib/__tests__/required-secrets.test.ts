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

  // Not a feature-gated partner value: the Eligibility Scout call runs on live
  // traffic (roughly 180 leads a day) and, since FFN's firewall started refusing
  // Cloudflare's shared Workers address, cannot get through without this key. An
  // unset key means that path stays blocked, which the field-presence check only
  // reports four days later and as a symptom, so it is named here directly.
  it('requires the FFN identifying key that unblocks the live Scout and Achieve calls', () => {
    expect(REQUIRED_PARTNER_SECRETS).toContain('FFN_PARTNER_KEY')
    expect(findMissingRequiredSecrets({ ...fullSecretEnv(), FFN_PARTNER_KEY: '' } as unknown as Env))
      .toEqual(['FFN_PARTNER_KEY'])
  })

  it('does not require feature-gated partner secrets (Achieve, Scout)', () => {
    const all = [...REQUIRED_SECRETS, ...REQUIRED_PARTNER_SECRETS] as string[]
    expect(all).not.toContain('ACHIEVE_USERNAME')
    expect(all).not.toContain('ACHIEVE_PASSWORD')
    expect(all).not.toContain('ACHIEVE_API_URL')
    expect(all).not.toContain('SCOUT_KEY')
  })
})

describe('the archive credentials', () => {
  it('covers every identity the archive can authenticate as', async () => {
    // DERIVED from the credential map rather than listed by hand, so a fourth
    // identity cannot be added with nothing watching whether its secrets are set
    // (L41, L96). The reader and eraser were deliberately held back until their
    // code paths shipped, which they did on 2026-08-22, and the deferral then
    // outlived its reason: both were unset in production and the only thing that
    // noticed was a downstream job failing the next morning.
    const { ARCHIVE_SECRET_NAMES } = await import('../archive-snowflake')

    const needed = Object.values(ARCHIVE_SECRET_NAMES).flatMap((n) => [n.user, n.privateKey])
    const missing = needed.filter((n) => !(REQUIRED_SECRETS as readonly string[]).includes(n))

    expect(missing).toEqual([])
  })
})
