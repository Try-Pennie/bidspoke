/**
 * The backfill that seals an organization's Slack bot token, and the check that
 * gates the contract release (#2331, phase 1 of #1689; F128).
 *
 * Before the plaintext in config.bot_token is ever stripped, every Slack row's
 * credential_enc must be shown to OPEN under the key new writes use and to hold
 * the SAME token as config.bot_token. Otherwise a seal that cannot be opened,
 * or holds the wrong token, hides behind the plaintext fallback until the strip
 * removes the only good copy (L5). So the backfill reports that comparison for
 * every row it can see, on a preview as on a run, and says whether the contract
 * release may go ahead.
 *
 * The table is an in-memory double whose writes honour every filter, so a write
 * scoped to another organization, or to a row already sealed, changes nothing,
 * as PostgREST would. Tokens are placeholder strings.
 */
import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, secretKeys } from '../../../lib/secret-crypto'
import { resolveSlackConnection } from '../../../lib/slack-connection'
import { sealSlackTokens } from '../slack-token-seal'

const ORG = 'org-mine'
const OTHER = 'org-other'
const ACTOR = 'user-7'

function newKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
}

type Row = Record<string, unknown>

function fakeTable(rows: Row[]) {
  const writes: { patch: Row; filters: [string, string, unknown][] }[] = []
  const client = {
    from(table: string) {
      if (table !== 'service_connections') throw new Error(`unexpected table ${table}`)
      const filters: [string, string, unknown][] = []
      let patch: Row | null = null
      const match = (r: Row) => filters.every(([op, c, v]) => (op === 'is' ? r[c] === v : r[c] === v))
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => { filters.push(['eq', c, v]); return b },
        is: (c: string, v: unknown) => { filters.push(['is', c, v]); return b },
        update: (p: Row) => { patch = p; return b },
        then: (resolve: (r: unknown) => unknown) => {
          if (patch) {
            writes.push({ patch, filters: [...filters] })
            const hit = rows.filter(match)
            hit.forEach((r) => Object.assign(r, patch))
            return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(resolve)
          }
          return Promise.resolve({ data: rows.filter(match).map((r) => ({ ...r })), error: null }).then(resolve)
        },
      }
      return b
    },
  }
  return { client, writes }
}

function rowsFor() {
  return [
    { id: 'sc-mine', organization_id: ORG, service_type: 'slack', config: { bot_token: 'mine-bot-token', default_channel: '#a' }, credential_enc: null, sealed_for: null },
    { id: 'sc-other', organization_id: OTHER, service_type: 'slack', config: { bot_token: 'other-bot-token', default_channel: '#b' }, credential_enc: null, sealed_for: null },
  ] as Row[]
}

describe('sealSlackTokens', () => {
  it('previews by default in the route; here a preview changes nothing and says the contract release may not go ahead', async () => {
    const rows = rowsFor()
    const { client, writes } = fakeTable(rows)
    const key = newKey()
    const r = await sealSlackTokens(client as never, secretKeys({ SECRET_ENCRYPTION_KEY: key }), ORG, ACTOR, { dryRun: true })
    expect(writes).toEqual([])
    expect(rows[0].credential_enc).toBeNull()
    expect(r).toMatchObject({ dryRun: true, rowsSeen: 1, sealed: 1, alreadySealed: 0, readyForContract: false })
    expect(r.verification).toEqual([{ id: 'sc-mine', sealed: false, opensWithLockKey: false, matchesPlaintext: null }])
  })

  it('seals the caller org row only, naming the actor, and verifies it from what was stored', async () => {
    const rows = rowsFor()
    const { client, writes } = fakeTable(rows)
    const key = newKey()
    const r = await sealSlackTokens(client as never, secretKeys({ SECRET_ENCRYPTION_KEY: key }), ORG, ACTOR, { dryRun: false })
    expect(r).toMatchObject({ dryRun: false, rowsSeen: 1, sealed: 1, alreadySealed: 0, readyForContract: true })
    expect(await decryptSecret(rows[0].credential_enc as string, key)).toBe('mine-bot-token')
    expect(rows[0]).toMatchObject({ sealed_for: 'bidding_ring', updated_by: ACTOR })
    // The plaintext stays until the contract release (dual write).
    expect((rows[0].config as Row).bot_token).toBe('mine-bot-token')
    expect(rows[1].credential_enc).toBeNull()
    expect(writes).toHaveLength(1)
    expect(writes[0].filters).toEqual(expect.arrayContaining([['eq', 'organization_id', ORG], ['is', 'credential_enc', null]]))
    expect(r.verification).toEqual([{ id: 'sc-mine', sealed: true, opensWithLockKey: true, matchesPlaintext: true }])
  })

  it('is idempotent: a second run seals nothing and still verifies', async () => {
    const rows = rowsFor()
    const { client } = fakeTable(rows)
    const keys = secretKeys({ SECRET_ENCRYPTION_KEY: newKey() })
    await sealSlackTokens(client as never, keys, ORG, ACTOR, { dryRun: false })
    const sealedOnce = rows[0].credential_enc
    const again = await sealSlackTokens(client as never, keys, ORG, ACTOR, { dryRun: false })
    expect(again).toMatchObject({ sealed: 0, alreadySealed: 1, readyForContract: true })
    expect(rows[0].credential_enc).toBe(sealedOnce)
  })

  it('refuses the contract release when the sealed token is not the plaintext token', async () => {
    const key = newKey()
    const rows = rowsFor()
    rows[0].credential_enc = await encryptSecret('some-other-token', key)
    rows[0].sealed_for = 'bidding_ring'
    const r = await sealSlackTokens(fakeTable(rows).client as never, secretKeys({ SECRET_ENCRYPTION_KEY: key }), ORG, ACTOR, { dryRun: true })
    expect(r.readyForContract).toBe(false)
    expect(r.verification).toEqual([{ id: 'sc-mine', sealed: true, opensWithLockKey: true, matchesPlaintext: false }])
  })

  it('refuses the contract release when the sealed token does not open under the current key', async () => {
    const rows = rowsFor()
    rows[0].credential_enc = await encryptSecret('mine-bot-token', newKey())
    rows[0].sealed_for = 'bidding_ring'
    const r = await sealSlackTokens(fakeTable(rows).client as never, secretKeys({ SECRET_ENCRYPTION_KEY: newKey() }), ORG, ACTOR, { dryRun: true })
    expect(r.readyForContract).toBe(false)
    expect(r.verification[0]).toMatchObject({ sealed: true, opensWithLockKey: false, matchesPlaintext: null })
  })

  it('refuses the contract release while a key rotation is in flight', async () => {
    const primary = newKey()
    const next = newKey()
    const rows = rowsFor()
    const r = await sealSlackTokens(fakeTable(rows).client as never, secretKeys({ SECRET_ENCRYPTION_KEY: primary, SECRET_ENCRYPTION_KEY_NEXT: next }), ORG, ACTOR, { dryRun: false })
    expect(r.rotating).toBe(true)
    expect(r.readyForContract).toBe(false)
    // Sealed under the key new writes use, so it outlives the swap.
    expect(await decryptSecret(rows[0].credential_enc as string, next)).toBe('mine-bot-token')
  })

  it('names a row with no plaintext to seal, and never puts a token or ciphertext in its answer', async () => {
    const rows = rowsFor()
    rows[0].config = { default_channel: '#a' }
    const r = await sealSlackTokens(fakeTable(rows).client as never, secretKeys({ SECRET_ENCRYPTION_KEY: newKey() }), ORG, ACTOR, { dryRun: false })
    expect(r.cannotSeal).toEqual(['sc-mine'])
    expect(r.readyForContract).toBe(false)
    const rows2 = rowsFor()
    const r2 = await sealSlackTokens(fakeTable(rows2).client as never, secretKeys({ SECRET_ENCRYPTION_KEY: newKey() }), ORG, ACTOR, { dryRun: false })
    const said = JSON.stringify(r2)
    expect(said).not.toContain('mine-bot-token')
    expect(said).not.toContain(rows2[0].credential_enc as string)
  })

  // The saved Slack copy is not edited by the backfill, which changes the
  // token's home and not the token: the next healthy probe rewrites the copy
  // from the rows (last-good-copies guard exemption). So a sealed row must
  // resolve to the same connection the copy held.
  it('a row it sealed still resolves to the same token, so the next probe keeps the org in the copy', async () => {
    const rows = rowsFor()
    const keys = secretKeys({ SECRET_ENCRYPTION_KEY: newKey() })
    await sealSlackTokens(fakeTable(rows).client as never, keys, ORG, ACTOR, { dryRun: false })
    const resolved = await resolveSlackConnection(rows[0] as never, keys)
    expect(resolved).toMatchObject({ kind: 'connection', source: 'sealed', connection: { bot_token: 'mine-bot-token', default_channel: '#a' } })
  })
})
