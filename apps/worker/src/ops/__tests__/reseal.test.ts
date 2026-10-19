/**
 * resealConnections (#2333, phase 3 of #1689, the reseal; plan: discussion
 * #2329, phase 3): during a rotation of the ops key, every ops connection login
 * still sealed under an old kid is opened with that kid's key and sealed, the
 * same login at the same generation, to the current kid, then written back to
 * its one home through OPS_GATEWAY.replaceConnectionEnvelope, a compare and set
 * that changes nothing when the row has moved on. The logins a person bound
 * connection's ConnectionTokenObject holds in its own storage are resealed too,
 * first (the 2026-10-18 comment on #2333).
 *
 * Previews by default. Idempotent: a second run reseals nothing new. Run again
 * until it reports nothing left. A crash between the seal and the write back
 * leaves the old envelope, which still opens under the old key.
 *
 * The bidding side here is a double of replace_connection_envelope's rule (one
 * compare and set on generation and kid), parsing each request with the
 * bidding Worker's own parser; the rule itself is proven in
 * supabase/tests/replace_connection_envelope.test.sql.
 */
import { open, seal, type KeyRing, type SealedEnvelope } from '@bidspoke/connection-seal'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  parseReplaceConnectionEnvelopeRequest, type ReplaceConnectionEnvelopeAnswer, type ReplaceConnectionEnvelopeRequest,
} from '../../lib/ops-gateway-contract'
import type { SealKeys } from '../connection-token-object'
import type { ResealLoginRequest } from '../connections/token-object-contract'
import { resealConnections, type ResealDeps, type ResealReport } from '../reseal'
import { KEYGEN_TIMEOUT_MS, opsKeyPair, type OpsKeyPair } from './ops-key-fixture'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const OTHER_ORG = '7a2d3c9f-1e4b-4d2f-8b66-2c3d4e5f6a71'
const OLD = 'ops-test-old'
const NEW = 'ops-test-new'
const SERVED_AT = '2026-10-19T14:00:00.000Z'
const SERVE_UNTIL = '2026-10-19T20:00:00.000Z'
/** A login a canary can be found in: plain words, never a real credential. */
const loginOf = (id: string) => JSON.stringify({ username: 'reseal canary user', password: `reseal canary password ${id}` })

let oldPair: OpsKeyPair
let newPair: OpsKeyPair
beforeAll(async () => {
  ;[oldPair, newPair] = await Promise.all([opsKeyPair(4096), opsKeyPair(4096)])
}, KEYGEN_TIMEOUT_MS)

const before = (): SealKeys => ({ privateKeys: { [OLD]: oldPair.privatePem }, publicKeys: { [OLD]: oldPair.publicPem }, kid: OLD })
const during = (): SealKeys => ({
  privateKeys: { [OLD]: oldPair.privatePem, [NEW]: newPair.privatePem },
  publicKeys: { [OLD]: oldPair.publicPem, [NEW]: newPair.publicPem },
  kid: NEW,
})

interface Row { id: string; organization_id: string; service: string; generation: number; envelope: SealedEnvelope }

const aadOf = (row: Pick<Row, 'id' | 'organization_id' | 'service' | 'generation'>, kid: string) => ({
  organization_id: row.organization_id, connection_id: row.id, service: row.service, generation: row.generation, kid,
})

async function rowUnder(keys: SealKeys, id: string, generation = 3, organizationId = ORG): Promise<Row> {
  const shell = { id, organization_id: organizationId, service: 'example', generation }
  return { ...shell, envelope: await seal(keys.publicKeys, loginOf(id), aadOf(shell, keys.kid as string)) }
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/**
 * The bidding Worker as resealConnections reaches it: the served list and the
 * compare and set, over rows it holds. `beforeWrite` runs between the read of
 * the row and the write, as a crash, a Reconnect or a removal would.
 */
function bidding(rows: Row[], opts: { complete?: boolean; extra?: unknown[]; beforeWrite?: (request: ReplaceConnectionEnvelopeRequest, store: Map<string, Row>) => void; afterWrite?: () => void } = {}) {
  const store = new Map(rows.map((r) => [r.id, structuredClone(r)]))
  const writes: ReplaceConnectionEnvelopeRequest[] = []
  return {
    store,
    writes,
    fetchConnections: async () => ({
      served_at: SERVED_AT,
      complete: opts.complete ?? true,
      connections: [
        ...[...store.values()].map((r) => ({ ...structuredClone(r), public_config: {}, target: null, serve_until: SERVE_UNTIL })),
        ...(opts.extra ?? []),
      ],
      tombstones: [],
    }),
    replaceEnvelope: async (raw: unknown): Promise<ReplaceConnectionEnvelopeAnswer> => {
      // The bidding Worker's own parse, with the current kid of the rotation under test.
      const request = parseReplaceConnectionEnvelopeRequest(raw, NEW)
      opts.beforeWrite?.(request, store)
      const row = store.get(request.connection_id)
      if (!row || row.organization_id !== request.organization_id) return { outcome: 'not_found', current_generation: null, current_kid: null }
      if (row.generation === request.expected_generation && row.envelope.kid === request.envelope.kid && row.envelope.iv === request.envelope.iv) {
        return { outcome: 'already_replaced', current_generation: row.generation, current_kid: row.envelope.kid }
      }
      if (row.generation !== request.expected_generation || row.envelope.kid !== request.expected_kid) {
        return { outcome: 'moved', current_generation: row.generation, current_kid: row.envelope.kid }
      }
      store.set(row.id, { ...row, envelope: request.envelope })
      writes.push(request)
      opts.afterWrite?.()
      return { outcome: 'replaced', current_generation: row.generation, current_kid: request.envelope.kid }
    },
  }
}

/** The token objects, one per connection, answering from `answers` (none held by default). */
function objects(answers: Record<string, unknown> = {}) {
  const calls: Array<{ connectionId: string; request: ResealLoginRequest }> = []
  return {
    calls,
    reseal: async (connectionId: string, request: ResealLoginRequest): Promise<unknown> => {
      calls.push({ connectionId, request })
      const answer = Object.hasOwn(answers, connectionId) ? answers[connectionId] : { ok: true, state: 'none', fromKid: null }
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

function deps(b: ReturnType<typeof bidding>, o: ReturnType<typeof objects>, keys: SealKeys = during(), over: Partial<ResealDeps> = {}): ResealDeps & { order: string[] } {
  const order: string[] = []
  return {
    order,
    keys,
    fetchConnections: b.fetchConnections,
    replaceEnvelope: async (request) => { order.push(`row ${request.connection_id}`); return b.replaceEnvelope(request) },
    resealObjectLogin: async (connectionId, request) => { order.push(`object ${connectionId}`); return o.reseal(connectionId, request) },
    ...over,
  }
}

function okReport(r: Awaited<ReturnType<typeof resealConnections>>): ResealReport {
  if (!r.ok) throw new Error(`refused: ${r.refused}: ${r.detail}`)
  return r
}

async function opensTo(ring: KeyRing, row: Row): Promise<string> {
  return open(ring, row.envelope, aadOf(row, row.envelope.kid))
}

describe('resealConnections previews by default', () => {
  it('names every row and held login under an old kid, and writes nothing anywhere', async () => {
    const rows = [await rowUnder(before(), id(1)), await rowUnder(before(), id(2)), await rowUnder(during(), id(3))]
    const b = bidding(rows)
    const o = objects({ [id(2)]: { ok: true, state: 'would_reseal', fromKid: OLD } })
    const report = okReport(await resealConnections(deps(b, o), {}))
    expect(report).toMatchObject({ mode: 'preview', current_kid: NEW, complete: true, left: 3, nothing_left: false })
    expect(report.rows).toMatchObject({ would_reseal: 2, current: 1 })
    expect(report.objects).toMatchObject({ none: 2, would_reseal: 1 })
    expect(b.writes).toEqual([])
    expect(o.calls.map((c) => c.request.apply)).toEqual([false, false, false])
    expect([...b.store.values()]).toEqual(rows)
  })
})

describe('resealConnections applied', () => {
  it('reseals each old kid row to the current kid at the same generation, the same login, and leaves current rows alone', async () => {
    const rows = [await rowUnder(before(), id(1), 3), await rowUnder(before(), id(2), 7, OTHER_ORG), await rowUnder(during(), id(3))]
    const b = bidding(rows)
    const report = okReport(await resealConnections(deps(b, objects()), { apply: true }))
    expect(report).toMatchObject({ mode: 'apply', left: 0, nothing_left: true })
    expect(report.rows).toMatchObject({ resealed: 2, current: 1 })
    expect(b.writes.map((w) => [w.organization_id, w.connection_id, w.expected_kid, w.expected_generation, w.envelope.kid])).toEqual([
      [ORG, id(1), OLD, 3, NEW], [OTHER_ORG, id(2), OLD, 7, NEW],
    ])
    for (const r of rows.slice(0, 2)) {
      const after = b.store.get(r.id)!
      expect(after.generation).toBe(r.generation)
      // The new key alone opens it, to the same login, under its own organization and generation.
      expect(await opensTo({ [NEW]: newPair.privatePem }, after)).toBe(loginOf(r.id))
    }
    expect(b.store.get(id(3))).toEqual(rows[2])
  })

  it('reseals the logins the token objects hold first, then the rows, asking each to apply', async () => {
    const rows = [await rowUnder(before(), id(1))]
    const b = bidding(rows)
    const o = objects({ [id(1)]: { ok: true, state: 'resealed', fromKid: OLD } })
    const d = deps(b, o)
    const report = okReport(await resealConnections(d, { apply: true }))
    expect(d.order).toEqual([`object ${id(1)}`, `row ${id(1)}`])
    expect(o.calls).toEqual([{ connectionId: id(1), request: { organizationId: ORG, connectionId: id(1), service: 'example', apply: true } }])
    expect(report.objects).toMatchObject({ resealed: 1 })
    expect(report.nothing_left).toBe(true)
  })

  it('is idempotent: running it twice reseals nothing new, and the second run reports nothing left', async () => {
    const b = bidding([await rowUnder(before(), id(1)), await rowUnder(before(), id(2))])
    okReport(await resealConnections(deps(b, objects()), { apply: true }))
    const stored = structuredClone([...b.store.values()])
    const second = okReport(await resealConnections(deps(b, objects()), { apply: true }))
    expect(second.rows).toMatchObject({ current: 2, resealed: 0 })
    expect(second).toMatchObject({ left: 0, nothing_left: true })
    expect(b.writes).toHaveLength(2)
    expect([...b.store.values()]).toEqual(stored)
  })

  it('a crash between the seal and the write back leaves the old envelope, which still opens under the old key', async () => {
    const row = await rowUnder(before(), id(1))
    const b = bidding([row], { beforeWrite: () => { throw new Error('the Worker was evicted') } })
    const report = okReport(await resealConnections(deps(b, objects()), { apply: true }))
    expect(report.rows).toMatchObject({ write_failed: 1 })
    expect(report).toMatchObject({ left: 1, nothing_left: false })
    expect(report.problems).toEqual([`connection ${id(1)}: write_failed`])
    const after = b.store.get(id(1))!
    expect(after).toEqual(row)
    // The old key alone, as it was before the rotation began.
    expect(await opensTo({ [OLD]: oldPair.privatePem }, after)).toBe(loginOf(id(1)))
  })

  it('an answer lost after the write is caught up by the next run, which finds the row current', async () => {
    let lose = true
    const b = bidding([await rowUnder(before(), id(1))], { afterWrite: () => { if (lose) { lose = false; throw new Error('the answer was lost') } } })
    expect(okReport(await resealConnections(deps(b, objects()), { apply: true })).rows).toMatchObject({ write_failed: 1 })
    const next = okReport(await resealConnections(deps(b, objects()), { apply: true }))
    expect(next.rows).toMatchObject({ current: 1 })
    expect(next.nothing_left).toBe(true)
    expect(await opensTo({ [NEW]: newPair.privatePem }, b.store.get(id(1))!)).toBe(loginOf(id(1)))
  })

  it('changes nothing on a row that moved on between the read and the write, and counts it as left for the next run', async () => {
    const b = bidding([await rowUnder(before(), id(1))], {
      beforeWrite: (request, store) => { store.set(request.connection_id, { ...store.get(request.connection_id)!, generation: 4 }) },
    })
    const report = okReport(await resealConnections(deps(b, objects()), { apply: true }))
    expect(report.rows).toMatchObject({ moved: 1 })
    expect(report.left).toBe(1)
    expect(b.writes).toEqual([])
    expect(b.store.get(id(1))!.envelope.kid).toBe(OLD)
  })

  it('a row removed between the read and the write is not_found, and not left', async () => {
    const b = bidding([await rowUnder(before(), id(1))], { beforeWrite: (request, store) => { store.delete(request.connection_id) } })
    const report = okReport(await resealConnections(deps(b, objects()), { apply: true }))
    expect(report.rows).toMatchObject({ not_found: 1 })
    expect(report).toMatchObject({ left: 0, nothing_left: true })
  })

  it('names a row whose kid this Worker holds no key for, and a row that will not open, writing neither', async () => {
    const stranger = await opsKeyPair(4096)
    const elsewhere: SealKeys = { privateKeys: {}, publicKeys: { 'ops-test-gone': stranger.publicPem }, kid: 'ops-test-gone' }
    const tampered = await rowUnder(before(), id(2))
    tampered.generation = 9 // sealed for generation 3, so the binding no longer opens it
    const b = bidding([await rowUnder(elsewhere, id(1)), tampered])
    const report = okReport(await resealConnections(deps(b, objects()), { apply: true }))
    expect(report.rows).toMatchObject({ no_key: 1, open_failed: 1 })
    expect(report.left).toBe(2)
    expect(report.problems).toEqual([`connection ${id(1)}: no_key`, `connection ${id(2)}: open_failed`])
    expect(b.writes).toEqual([])
  }, KEYGEN_TIMEOUT_MS)

  it('names a row that opened but could not be sealed to the current kid as seal_failed, not open_failed (L11)', async () => {
    const b = bidding([await rowUnder(before(), id(1))])
    // The old key opens it; the current kid's public key is unusable, so the seal is what fails.
    const broken: SealKeys = { ...during(), publicKeys: { [OLD]: oldPair.publicPem, [NEW]: 'not a public key' } }
    const report = okReport(await resealConnections(deps(b, objects(), broken), { apply: true }))
    expect(report.rows).toMatchObject({ seal_failed: 1, open_failed: 0 })
    expect(report.left).toBe(1)
    expect(report.problems).toEqual([`connection ${id(1)}: seal_failed`])
    expect(b.writes).toEqual([])
  })

  it('reseals at most the per run limit of rows, leaving the rest deferred, and the next run takes them', async () => {
    const b = bidding([await rowUnder(before(), id(1)), await rowUnder(before(), id(2)), await rowUnder(before(), id(3))])
    const first = okReport(await resealConnections(deps(b, objects()), { apply: true }, { maxRowReseals: 2, maxObjectReseals: 2 }))
    expect(first.rows).toMatchObject({ resealed: 2, deferred: 1 })
    expect(first).toMatchObject({ left: 1, nothing_left: false })
    const second = okReport(await resealConnections(deps(b, objects()), { apply: true }, { maxRowReseals: 2, maxObjectReseals: 2 }))
    expect(second.rows).toMatchObject({ resealed: 1, current: 2 })
    expect(second.nothing_left).toBe(true)
  })

  it('asks every token object every run, and reseals at most the per run limit of them, so a login past the limit is reached on a later run', async () => {
    const rows = await Promise.all([1, 2, 3, 4, 5].map((n) => rowUnder(during(), id(n))))
    // Objects that each hold a login under the old kid until one is asked to apply.
    const held = new Set(rows.map((r) => r.id))
    const asked: Array<[string, boolean]> = []
    const resealedInOrder: string[] = []
    const o = {
      calls: [],
      reseal: async (connectionId: string, request: ResealLoginRequest): Promise<unknown> => {
        asked.push([connectionId, request.apply])
        if (!held.has(connectionId)) return { ok: true, state: 'current', fromKid: NEW }
        if (!request.apply) return { ok: true, state: 'would_reseal', fromKid: OLD }
        held.delete(connectionId)
        resealedInOrder.push(connectionId)
        return { ok: true, state: 'resealed', fromKid: OLD }
      },
    } as unknown as ReturnType<typeof objects>
    const limits = { maxRowReseals: 100, maxObjectReseals: 2 }
    const runs: ResealReport[] = []
    for (let i = 0; i < 3; i++) runs.push(okReport(await resealConnections(deps(bidding(rows), o), { apply: true }, limits)))
    expect(runs.map((r) => r.objects)).toEqual([
      expect.objectContaining({ resealed: 2, would_reseal: 3 }),
      expect.objectContaining({ resealed: 2, would_reseal: 1, current: 2 }),
      expect.objectContaining({ resealed: 1, current: 4 }),
    ])
    expect(runs.map((r) => r.nothing_left)).toEqual([false, false, true])
    // Every object is asked on every run, and each run reseals the next two still under the old kid.
    expect(resealedInOrder).toEqual([id(1), id(2), id(3), id(4), id(5)])
    expect(asked).toHaveLength(15)
    // Past the limit an object is asked only to preview, so it writes nothing that run.
    expect(asked.slice(2, 5)).toEqual([[id(3), false], [id(4), false], [id(5), false]])
  })
})

describe('what counts as nothing left', () => {
  it('never while the served list is incomplete, or a served row could not be read', async () => {
    const incomplete = okReport(await resealConnections(deps(bidding([await rowUnder(during(), id(1))], { complete: false }), objects()), { apply: true }))
    expect(incomplete).toMatchObject({ complete: false, left: 0, nothing_left: false })
    const unreadable = okReport(await resealConnections(deps(bidding([], { extra: [{ id: id(9), organization_id: ORG }] }), objects()), { apply: true }))
    expect(unreadable.rows).toMatchObject({ unreadable: 1 })
    expect(unreadable).toMatchObject({ complete: false, left: 1, nothing_left: false })
  })

  it('never while a token object could not be asked, answered something unreadable, or refused', async () => {
    const rows = [await rowUnder(during(), id(1)), await rowUnder(during(), id(2)), await rowUnder(during(), id(3)), await rowUnder(during(), id(4))]
    const o = objects({
      [id(1)]: new Error('the object could not be reached'),
      [id(2)]: { ok: true, state: 'maybe' },
      [id(3)]: { ok: false, reason: 'busy' },
      [id(4)]: { ok: false, reason: 'no_key' },
    })
    const report = okReport(await resealConnections(deps(bidding(rows), o), { apply: true }))
    expect(report.objects).toMatchObject({ failed: 2, busy: 1, no_key: 1 })
    expect(report).toMatchObject({ left: 4, nothing_left: false })
    expect(report.problems).toEqual([`token object ${id(1)}: failed`, `token object ${id(2)}: failed`, `token object ${id(3)}: busy`, `token object ${id(4)}: no_key`])
  })
})

describe('resealConnections refuses by name', () => {
  it('when no kid is current, writing and asking nothing', async () => {
    const b = bidding([await rowUnder(before(), id(1))])
    const o = objects()
    expect(await resealConnections(deps(b, o, { ...during(), kid: null }), { apply: true })).toMatchObject({ ok: false, refused: 'no_current_kid' })
    expect(o.calls).toEqual([])
    expect(b.writes).toEqual([])
  })

  it('when the bidding Worker\'s list cannot be fetched or read, writing and asking nothing', async () => {
    const o = objects()
    const down = deps(bidding([]), o, during(), { fetchConnections: async () => { throw new Error('the bidding Worker did not answer') } })
    expect(await resealConnections(down, { apply: true })).toMatchObject({ ok: false, refused: 'connections_unavailable' })
    const garbled = deps(bidding([]), o, during(), { fetchConnections: async () => ({ served_at: 'never' }) })
    expect(await resealConnections(garbled, { apply: true })).toMatchObject({ ok: false, refused: 'connections_unreadable' })
    expect(o.calls).toEqual([])
  })
})

describe('what leaves', () => {
  it('no login reaches the report or the bidding Worker in the clear', async () => {
    const b = bidding([await rowUnder(before(), id(1))], { beforeWrite: () => { throw new Error('evicted') } })
    const report = await resealConnections(deps(b, objects()), { apply: true })
    const ok = bidding([await rowUnder(before(), id(2))])
    await resealConnections(deps(ok, objects()), { apply: true })
    const everything = JSON.stringify([report, ok.writes])
    expect(everything).not.toContain('reseal canary')
    expect(everything).not.toContain(btoa('reseal canary').slice(0, 12))
  })
})
