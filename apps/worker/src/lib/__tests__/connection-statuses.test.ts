/**
 * The Connections page's statuses (#2338, build PR 4; R3, R22, D22): how an
 * ops status reads on the page, and the last known statuses kept for when the
 * login checks do not answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONNECTION_STATUSES } from '../../ops/run-vocabulary'
import type { HealthRow } from '../ops-connections-contract'
import { STORED_COPY_RECONFIRM_AFTER_MS } from '../stored-copy-age'
import {
  connectionStatusesCopyKey,
  forgetConnectionStatusesMemory,
  pageStatusOf,
  readConnectionStatuses,
  rememberConnectionStatuses,
} from '../connection-statuses'

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'
const CONN = '33333333-3333-4333-8333-333333333333'
const T0 = Date.parse('2026-10-20T15:52:00Z')

const row = (status: string, over: Partial<HealthRow> = {}): HealthRow => ({
  connection_id: CONN,
  service: 'salesforce',
  generation: 1,
  status,
  last_check_ok_at: '2026-10-20T15:48:00Z',
  last_check_failed_at: null,
  last_check_cause: null,
  needs_reauth_at: null,
  needs_reauth_cause: null,
  reauth_cleared_at: null,
  ...over,
})

function memoryKv() {
  const store = new Map<string, string>()
  return {
    store,
    puts: 0,
    failPut: false,
    failGet: false,
    async get(key: string) {
      if (this.failGet) throw new Error('KV get failed')
      return store.get(key) ?? null
    },
    async put(key: string, value: string) {
      if (this.failPut) throw new Error('KV put failed: 429 Too Many Requests')
      this.puts++
      store.set(key, value)
    },
  }
}

afterEach(() => {
  forgetConnectionStatusesMemory()
  vi.restoreAllMocks()
})

describe('pageStatusOf: the five ops statuses in the page\'s three words (Dan, 2026-10-20)', () => {
  it('maps each ops status to its word', () => {
    expect(pageStatusOf('healthy')).toBe('ok')
    // Saved only after its verify passed, so not yet checked reads Working.
    expect(pageStatusOf('unchecked')).toBe('ok')
    expect(pageStatusOf('needs_reauth')).toBe('reauth')
    expect(pageStatusOf('check_failing')).toBe('failing')
    // Dan's decision: a token endpoint that keeps failing reads Check failing.
    expect(pageStatusOf('refresh_failing')).toBe('failing')
  })

  it('maps every status ops can derive, so a new one cannot ship unread', () => {
    for (const s of CONNECTION_STATUSES) expect(pageStatusOf(s)).not.toBeNull()
  })

  it('answers no status for one this Worker does not know, rather than making one up', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(pageStatusOf('quarantined')).toBeNull()
  })
})

describe('the last known statuses', () => {
  it('reads back what was remembered, with the time it was confirmed', async () => {
    const kv = memoryKv()
    await rememberConnectionStatuses(kv, ORG_A, [row('needs_reauth')], T0)
    const read = await readConnectionStatuses(kv, ORG_A)
    expect(read).toEqual({ kind: 'read', as_of: new Date(T0).toISOString(), rows: [row('needs_reauth')] })
  })

  it('is kept per organization, and never answers another organization\'s copy', async () => {
    const kv = memoryKv()
    await rememberConnectionStatuses(kv, ORG_A, [row('healthy')], T0)
    expect((await readConnectionStatuses(kv, ORG_B)).kind).toBe('absent')
    // A value planted under B's key that names A is refused, not served to B.
    kv.store.set(connectionStatusesCopyKey(ORG_B), kv.store.get(connectionStatusesCopyKey(ORG_A))!)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await readConnectionStatuses(kv, ORG_B)).kind).toBe('unreadable')
  })

  it('writes again only when the statuses change or the copy is due to be confirmed again', async () => {
    const kv = memoryKv()
    await rememberConnectionStatuses(kv, ORG_A, [row('healthy')], T0)
    await rememberConnectionStatuses(kv, ORG_A, [row('healthy')], T0 + 60_000)
    expect(kv.puts).toBe(1)
    await rememberConnectionStatuses(kv, ORG_A, [row('check_failing')], T0 + 61_000)
    expect(kv.puts).toBe(2)
    const later = T0 + 61_000 + STORED_COPY_RECONFIRM_AFTER_MS
    await rememberConnectionStatuses(kv, ORG_A, [row('check_failing')], later)
    expect(kv.puts).toBe(3)
    expect((await readConnectionStatuses(kv, ORG_A))).toMatchObject({ as_of: new Date(later).toISOString() })
  })

  it('a refused write never throws: the list still answers, and the next request tries again', async () => {
    const kv = memoryKv()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    kv.failPut = true
    await expect(rememberConnectionStatuses(kv, ORG_A, [row('healthy')], T0)).resolves.toBeUndefined()
    expect(error.mock.calls.flat().join(' ')).toContain('connection_statuses_copy_unwritten')
    kv.failPut = false
    await rememberConnectionStatuses(kv, ORG_A, [row('healthy')], T0 + 1000)
    expect(kv.puts).toBe(1)
  })

  it('says which of absent, unreadable and failed read it met', async () => {
    const kv = memoryKv()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await readConnectionStatuses(kv, ORG_A)).toEqual({ kind: 'absent' })
    kv.store.set(connectionStatusesCopyKey(ORG_A), 'not json')
    expect((await readConnectionStatuses(kv, ORG_A)).kind).toBe('unreadable')
    kv.store.set(connectionStatusesCopyKey(ORG_A), JSON.stringify({ organization_id: ORG_A, as_of: 'yesterday', rows: [] }))
    expect((await readConnectionStatuses(kv, ORG_A)).kind).toBe('unreadable')
    kv.failGet = true
    expect((await readConnectionStatuses(kv, ORG_A)).kind).toBe('unreadable')
  })

  it('with no KV binding there is nothing to keep or read', async () => {
    await expect(rememberConnectionStatuses(undefined, ORG_A, [row('healthy')], T0)).resolves.toBeUndefined()
    expect(await readConnectionStatuses(undefined, ORG_A)).toEqual({ kind: 'absent' })
  })
})
