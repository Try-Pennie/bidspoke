import { describe, expect, it } from 'vitest'
import { emailForMarker, isSpikeMarker, makeMarker, newLedger, openLedger, orgSlugForEmail, readLedger, type LedgerIo } from './ledger.ts'

function memoryIo(): LedgerIo & { files: Map<string, string>; writes: string[] } {
  const files = new Map<string, string>()
  const writes: string[] = []
  return {
    files,
    writes,
    exists: (p) => files.has(p),
    read: (p) => {
      const text = files.get(p)
      if (text === undefined) throw new Error(`ENOENT ${p}`)
      return text
    },
    write: (p, text) => {
      files.set(p, text)
      writes.push(text)
    },
  }
}

describe('the marker and the names derived from it', () => {
  it('is realtime-spike- and a UTC timestamp, lower case', () => {
    expect(makeMarker(new Date('2026-10-15T15:30:12.345Z'))).toBe('realtime-spike-20261015t153012z')
    expect(isSpikeMarker('realtime-spike-20261015t153012z')).toBe(true)
    expect(isSpikeMarker('realtime-spike-')).toBe(false)
    expect(isSpikeMarker('pennie')).toBe(false)
  })

  it('puts the marker in the email domain, so the signup trigger files the user under the spike org', () => {
    const email = emailForMarker('realtime-spike-20261015t153012z')
    expect(email).toBe('org-b@realtime-spike-20261015t153012z.example.com')
    // handle_new_auth_user: lower(regexp_replace(domain, '[^a-z0-9]', '-', 'g'))
    expect(orgSlugForEmail(email)).toBe('realtime-spike-20261015t153012z-example-com')
  })
})

describe('the ledger is written before anything is created (L515)', () => {
  it('writes the file when opened, before any entry', () => {
    const io = memoryIo()
    openLedger('/l.json', newLedger('realtime-spike-20261015t153012z', 'ref', '2026-10-15T15:30:12Z'), io)
    expect(io.writes).toHaveLength(1)
    expect(readLedger('/l.json', io).entries).toEqual([])
  })

  it('records a planned entry on disk, then the id once known', () => {
    const io = memoryIo()
    const ledger = openLedger('/l.json', newLedger('realtime-spike-20261015t153012z', 'ref', 'now'), io)
    ledger.plan('auth_user', 'org-b@realtime-spike-20261015t153012z.example.com', null)
    expect(readLedger('/l.json', io).entries).toEqual([
      { kind: 'auth_user', key: 'org-b@realtime-spike-20261015t153012z.example.com', id: null, state: 'planned' },
    ])
    ledger.created('auth_user', 'org-b@realtime-spike-20261015t153012z.example.com', 'u-1')
    expect(readLedger('/l.json', io).entries).toEqual([
      { kind: 'auth_user', key: 'org-b@realtime-spike-20261015t153012z.example.com', id: 'u-1', state: 'created' },
    ])
  })

  it('refuses to open over an existing ledger, which may name things an earlier run left behind', () => {
    const io = memoryIo()
    io.files.set('/l.json', '{}')
    expect(() => openLedger('/l.json', newLedger('realtime-spike-20261015t153012z', 'ref', 'now'), io)).toThrow(/already exists/)
  })

  it('refuses to plan an entry whose key does not carry the marker', () => {
    const io = memoryIo()
    const ledger = openLedger('/l.json', newLedger('realtime-spike-20261015t153012z', 'ref', 'now'), io)
    expect(() => ledger.plan('organization', 'pennie', 'org-1')).toThrow(/marker/)
  })

  it('refuses a key that merely contains the marker, or is the key of another kind (#2157 lessons review)', () => {
    const io = memoryIo()
    const marker = 'realtime-spike-20261015t153012z'
    const ledger = openLedger('/l.json', newLedger(marker, 'ref', 'now'), io)
    expect(() => ledger.plan('organization', `pennie-${marker}`, 'org-1')).toThrow(/marker/)
    expect(() => ledger.plan('allowlist', `dan+${marker}@trypennie.com`, null)).toThrow(/marker/)
    expect(() => ledger.plan('organization', emailForMarker(marker), 'org-1')).toThrow(/marker/)
    expect(() => ledger.plan('public_user', orgSlugForEmail(emailForMarker(marker)), 'u-1')).toThrow(/marker/)
    ledger.plan('organization', orgSlugForEmail(emailForMarker(marker)), 'org-1')
    ledger.plan('auth_user', emailForMarker(marker), null)
    expect(ledger.current().entries).toHaveLength(2)
  })

  it('refuses to read a file that is not a spike ledger', () => {
    const io = memoryIo()
    io.files.set('/bad.json', JSON.stringify({ version: 1, marker: 'pennie', project: 'p', startedAt: 'x', entries: [] }))
    expect(() => readLedger('/bad.json', io)).toThrow(/not a realtime spike ledger/)
    io.files.set('/worse.json', 'not json')
    expect(() => readLedger('/worse.json', io)).toThrow(/not a realtime spike ledger/)
  })
})
