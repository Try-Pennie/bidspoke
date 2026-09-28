/**
 * Re-locking every stored secret with SECRET_ENCRYPTION_KEY_NEXT (#384).
 *
 * The step between setting NEXT and swapping the primary. It must leave every
 * stored value readable by NEXT alone, never overwrite a value somebody saved
 * while it ran, name (never silently skip) a value no key can read, and preview
 * by default because it rewrites every credential the engine uses.
 */
import { describe, it, expect } from 'vitest'
import { decryptSecret, encryptSecret, secretKeys } from '../secret-crypto'
import { reencryptSecrets } from '../secret-reencrypt'

function newKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
}

type Row = Record<string, unknown>

/**
 * A stand-in for the two tables. Updates honour every `eq` filter, so a write
 * whose compare value no longer matches changes nothing, exactly as PostgREST
 * does; `beforeUpdate` lets a test change a row between the read and the write.
 */
function fakeSupabase(tables: Record<string, Row[]>, beforeUpdate?: (table: string) => void, failWrites = false) {
  return {
    from(table: string) {
      const filters: [string, unknown][] = []
      let patch: Row | null = null
      const builder = {
        select() {
          return builder
        },
        eq(col: string, val: unknown) {
          filters.push([col, val])
          return builder
        },
        not() {
          return builder
        },
        update(p: Row) {
          patch = p
          return builder
        },
        then(resolve: (r: { data: Row[]; error: null }) => void) {
          if (patch && failWrites) {
            resolve({ data: null, error: { message: 'write boom' } } as never)
          } else if (patch) {
            beforeUpdate?.(table)
            const hit = tables[table].filter((r) => filters.every(([c, v]) => r[c] === v))
            hit.forEach((r) => Object.assign(r, patch))
            resolve({ data: hit.map((r) => ({ ...r })), error: null })
          } else {
            const rows = tables[table].filter((r) => filters.every(([c, v]) => r[c] === v))
            resolve({ data: rows.map((r) => ({ ...r })), error: null })
          }
        },
      }
      return builder
    },
  }
}

async function setup() {
  const primary = newKey()
  const next = newKey()
  const tables: Record<string, Row[]> = {
    environment_variables: [
      { id: 'e1', key: 'EQ_PASS', is_secret: true, value: await encryptSecret('eq-pass', primary) },
      { id: 'e2', key: 'SCOUT_KEY', is_secret: true, value: await encryptSecret('scout', primary) },
      { id: 'e3', key: 'EMPTY', is_secret: true, value: null },
    ],
    app_settings: [{ organization_id: 'o1', key: 'anthropic_api_key', value_encrypted: await encryptSecret('sk-ant-x', primary) }],
  }
  return { primary, next, tables, keys: secretKeys({ SECRET_ENCRYPTION_KEY: primary, SECRET_ENCRYPTION_KEY_NEXT: next }) }
}

describe('reencryptSecrets', () => {
  it('re-locks every stored value so the next key alone reads it', async () => {
    const { next, tables, keys } = await setup()
    const result = await reencryptSecrets(fakeSupabase(tables) as never, keys, { dryRun: false })

    expect(result.ok).toBe(true)
    expect(await decryptSecret(tables.environment_variables[0].value as string, next)).toBe('eq-pass')
    expect(await decryptSecret(tables.environment_variables[1].value as string, next)).toBe('scout')
    expect(await decryptSecret(tables.app_settings[0].value_encrypted as string, next)).toBe('sk-ant-x')
    expect(result.tables.map((t) => [t.table, t.relocked])).toEqual([
      ['environment_variables', 2],
      ['app_settings', 1],
    ])
  })

  it('changes nothing on a preview, and reports what it would re-lock', async () => {
    const { primary, tables, keys } = await setup()
    const before = JSON.stringify(tables)
    const result = await reencryptSecrets(fakeSupabase(tables) as never, keys, { dryRun: true })

    expect(JSON.stringify(tables)).toBe(before)
    expect(result.tables[0].relocked).toBe(2)
    expect(await decryptSecret(tables.environment_variables[0].value as string, primary)).toBe('eq-pass')
  })

  it('is a no-op the second time, counting every row as already current', async () => {
    const { tables, keys } = await setup()
    await reencryptSecrets(fakeSupabase(tables) as never, keys, { dryRun: false })
    const again = await reencryptSecrets(fakeSupabase(tables) as never, keys, { dryRun: false })

    expect(again.ok).toBe(true)
    expect(again.tables.map((t) => [t.relocked, t.alreadyCurrent])).toEqual([
      [0, 2],
      [0, 1],
    ])
  })

  it('names a value no key can read, leaves it untouched, and is not ok', async () => {
    const { tables, keys } = await setup()
    const foreign = await encryptSecret('lost', newKey())
    tables.environment_variables[1].value = foreign
    const result = await reencryptSecrets(fakeSupabase(tables) as never, keys, { dryRun: false })

    expect(result.ok).toBe(false)
    expect(result.tables[0].undecryptable).toEqual(['SCOUT_KEY'])
    expect(tables.environment_variables[1].value).toBe(foreign)
  })

  it('does not overwrite a value saved while it ran, and reports it', async () => {
    const { next, tables, keys } = await setup()
    const saved = await encryptSecret('eq-pass-new', next)
    let done = false
    const supabase = fakeSupabase(tables, (table) => {
      if (table === 'environment_variables' && !done) {
        done = true
        tables.environment_variables[0].value = saved
      }
    })
    const result = await reencryptSecrets(supabase as never, keys, { dryRun: false })

    expect(tables.environment_variables[0].value).toBe(saved)
    expect(result.tables[0].changedMeanwhile).toEqual(['EQ_PASS'])
    expect(result.ok).toBe(false)
  })

  it('throws on a read error rather than reporting zero rows as success', async () => {
    const { keys } = await setup()
    const broken = {
      from: () => ({
        select: () => ({ eq: () => ({ then: (r: (v: unknown) => void) => r({ data: null, error: { message: 'boom' } }) }) }),
      }),
    }
    await expect(reencryptSecrets(broken as never, keys, { dryRun: true })).rejects.toThrow(/boom/)
  })
  it('throws on a write error rather than counting it as a value changed meanwhile', async () => {
    const { tables, keys } = await setup()
    await expect(reencryptSecrets(fakeSupabase(tables, undefined, true) as never, keys, { dryRun: false })).rejects.toThrow(
      /write boom/,
    )
  })
})
