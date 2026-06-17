/**
 * Code-node sandbox env filtering (#108): platform master secrets must not reach
 * user-authored code, while partner credentials and DB env vars still flow.
 */
import { describe, it, expect } from 'vitest'
import { sandboxEnvBindings, SANDBOX_BLOCKED_ENV_KEYS } from '../sandbox-env'
import type { Env } from '../../index'

const env = {
  // master secrets — must be withheld
  SUPABASE_SECRET_KEY: 'service-role',
  SECRET_ENCRYPTION_KEY: 'enc-key',
  SSN_HASH_PEPPER: 'pepper',
  CLOUDFLARE_API_TOKEN: 'cf-token',
  CLOUDFLARE_ACCOUNT_ID: 'cf-acct',
  API_KEY_MAP: '{"k":"src"}',
  SNOWFLAKE_PRIVATE_KEY: 'rsa-pem',
  GITHUB_TOKEN: 'ghp_x',
  ANTHROPIC_API_KEY: 'sk-ant',
  // non-secret config — exposed
  SUPABASE_URL: 'https://proj.supabase.co',
  APP_URL: 'https://app.test',
  // partner credentials (dynamic worker secrets — not in the typed Env) — exposed
  EQUIFAX_USERNAME: 'equ-user',
  EQUIFAX_PASSWORD: 'equ-pass',
  TRIPOINT_PROXY_SECRET: 'tri-secret',
  GIGFI_API_KEY: 'gigfi',
  // non-string bindings — never copied
  WORKFLOW_CACHE: {},
  DYNAMIC_WORKER_LOADER: {},
} as unknown as Env

describe('sandboxEnvBindings (#108)', () => {
  const out = sandboxEnvBindings(env)

  it('withholds every platform master secret', () => {
    for (const k of ['SUPABASE_SECRET_KEY', 'SECRET_ENCRYPTION_KEY', 'SSN_HASH_PEPPER', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'API_KEY_MAP', 'SNOWFLAKE_PRIVATE_KEY', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY']) {
      expect(out[k], `${k} must be withheld`).toBeUndefined()
    }
  })

  it('passes partner credentials and non-secret config through', () => {
    expect(out.EQUIFAX_USERNAME).toBe('equ-user')
    expect(out.EQUIFAX_PASSWORD).toBe('equ-pass')
    expect(out.TRIPOINT_PROXY_SECRET).toBe('tri-secret')
    expect(out.GIGFI_API_KEY).toBe('gigfi')
    expect(out.SUPABASE_URL).toBe('https://proj.supabase.co')
    expect(out.APP_URL).toBe('https://app.test')
  })

  it('never copies non-string bindings (KV/DO/dispatch)', () => {
    expect(out.WORKFLOW_CACHE).toBeUndefined()
    expect(out.DYNAMIC_WORKER_LOADER).toBeUndefined()
  })
})

describe('SANDBOX_BLOCKED_ENV_KEYS', () => {
  it('blocks the critical secrets and not partner creds / config', () => {
    expect(SANDBOX_BLOCKED_ENV_KEYS.has('SUPABASE_SECRET_KEY')).toBe(true)
    expect(SANDBOX_BLOCKED_ENV_KEYS.has('SECRET_ENCRYPTION_KEY')).toBe(true)
    expect(SANDBOX_BLOCKED_ENV_KEYS.has('SSN_HASH_PEPPER')).toBe(true)
    expect(SANDBOX_BLOCKED_ENV_KEYS.has('EQUIFAX_USERNAME')).toBe(false)
    expect(SANDBOX_BLOCKED_ENV_KEYS.has('SUPABASE_URL')).toBe(false)
  })
})
