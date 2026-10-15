import { describe, expect, it } from 'vitest'
import { sslFor } from './ssl.ts'

describe('sslFor: the connection to the database verifies who it is talking to', () => {
  it('uses no TLS for a local database', () => {
    expect(sslFor({ PGHOST: '127.0.0.1' })).toBe(false)
    expect(sslFor({ PGHOST: 'localhost' })).toBe(false)
  })

  it('verifies a hosted database against Supabase\'s root CA, by host name', () => {
    const ssl = sslFor({ PGHOST: 'db.xvrmivmpfykwwtriqwpg.supabase.co' })
    expect(ssl).not.toBe(false)
    if (ssl === false) return
    expect(ssl.rejectUnauthorized).toBe(true)
    expect(ssl.servername).toBe('db.xvrmivmpfykwwtriqwpg.supabase.co')
    expect(ssl.ca).toMatch(/BEGIN CERTIFICATE/)
  })

  it('takes PGSSLROOTCERT instead when set, still verifying', () => {
    const ssl = sslFor({ PGHOST: 'db.example.supabase.co', PGSSLROOTCERT: '/nonexistent/ca.crt' }, () => 'CA FROM FILE')
    expect(ssl).toMatchObject({ ca: 'CA FROM FILE', rejectUnauthorized: true })
  })
})
