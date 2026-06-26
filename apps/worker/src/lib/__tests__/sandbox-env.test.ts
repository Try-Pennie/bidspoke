/**
 * Code-node sandbox env filtering (#108): platform master secrets must not reach
 * user-authored code, while partner credentials and DB env vars still flow.
 */
import { describe, it, expect } from 'vitest'
import { sandboxEnvBindings, SANDBOX_BLOCKED_ENV_KEYS, buildSandboxEnv } from '../sandbox-env'
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

describe('buildSandboxEnv (credential assembly — regression guard for the 2026-06-26 outage)', () => {
  it('exposes the org env-loader values (already decrypted) to the sandbox', () => {
    const ctxEnv = { ELIGIBILITY_SCOUT_CLIENT_SECRET: 'decrypted-plaintext', SOME_CONFIG: 'v' }
    const merged = buildSandboxEnv(env, ctxEnv)
    expect(merged.ELIGIBILITY_SCOUT_CLIENT_SECRET).toBe('decrypted-plaintext')
    expect(merged.SOME_CONFIG).toBe('v')
  })

  it('still withholds platform master secrets regardless of ctxEnv', () => {
    const merged = buildSandboxEnv(env, { SOME_CONFIG: 'v' })
    expect(merged.SECRET_ENCRYPTION_KEY).toBeUndefined()
    expect(merged.SSN_HASH_PEPPER).toBeUndefined()
    expect(merged.SUPABASE_SECRET_KEY).toBeUndefined()
  })

  it('surfaces the env-loader value for a credential key (must be the decrypted value the loader provides, never a raw blob)', () => {
    // env-loader owns decryption (env-loader.test.ts locks "never inject ciphertext").
    // This locks the assembly half: a credential a node reads resolves to the value
    // env-loader provided. The 2026-06-26 outage was the encrypted blob reaching the
    // node here; if a regression ever puts ciphertext into ctxEnv, that's the loader's
    // contract — this guards that buildSandboxEnv passes the loader value through intact.
    const ctxEnv = { EQUIFAX_PASSWORD: 'real-decrypted-pass' }
    const merged = buildSandboxEnv(env, ctxEnv)
    expect(merged.EQUIFAX_PASSWORD).toBe('real-decrypted-pass')
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
