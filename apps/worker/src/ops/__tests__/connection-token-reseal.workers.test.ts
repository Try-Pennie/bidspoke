/**
 * ConnectionTokenObject.resealLogin (#2333, the reseal; the 2026-10-18 comment
 * on #2333, from #2425): the login a person bound connection's object holds in
 * its own storage is moved to the current ops kid during a rotation of the ops
 * key, as resealConnections moves the service_connections rows. Without it, a
 * rotated login still waiting to be written back would reach the row under the
 * old kid after the reseal had finished, and would open nowhere once the old
 * key is gone.
 *
 * Against the real wrangler.ops.toml in workerd, as the object's other suite.
 * The object's clock is a field set in the FUTURE (CLAUDE.md, #1410), so no
 * alarm fires underneath a test; each is run by runDurableObjectAlarm.
 */
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { open, seal, type KeyRing, type SealedEnvelope } from '@bidspoke/connection-seal'
import { beforeAll, describe, expect, it } from 'vitest'
import type { StoreRotatedEnvelopeAnswer } from '../../lib/ops-gateway-contract'
import { ConnectionTokenObject, type SealKeys, type StoredLogin } from '../connection-token-object'
import type { ResealLoginAnswer } from '../connections/token-object-contract'
import type { OpsEnv } from '../index'
import { KEYGEN_TIMEOUT_MS, opsKeyPair, type OpsKeyPair } from './ops-key-fixture'

const opsEnv = env as unknown as OpsEnv

/** 2027-11-04 15:00 UTC: in the future, so no alarm fires on its own. */
const T = Date.UTC(2027, 10, 4, 15, 0)
const ORG = '11111111-1111-4111-8111-111111112333'
const SERVICE = 'google_user'
const OLD = 'ops-test-old'
const NEW = 'ops-test-new'
const LOGIN = { client_id: 'reseal app client', client_secret: 'reseal app secret', refresh_token: 'reseal refresh token' }

let oldPair: OpsKeyPair
let newPair: OpsKeyPair
beforeAll(async () => {
  ;[oldPair, newPair] = await Promise.all([opsKeyPair(4096), opsKeyPair(4096)])
}, KEYGEN_TIMEOUT_MS)

/** Before the rotation: the old kid only. */
const before = (): SealKeys => ({ privateKeys: { [OLD]: oldPair.privatePem }, publicKeys: { [OLD]: oldPair.publicPem }, kid: OLD })
/** Rotation step 3: both kids held, and new seals go to the new one. */
const during = (): SealKeys => ({
  privateKeys: { [OLD]: oldPair.privatePem, [NEW]: newPair.privatePem },
  publicKeys: { [OLD]: oldPair.publicPem, [NEW]: newPair.publicPem },
  kid: NEW,
})

let n = 0
function connection(): string {
  n += 1
  return `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`
}

function stubFor(connectionId: string): DurableObjectStub<ConnectionTokenObject> {
  return opsEnv.CONNECTION_TOKENS!.get(opsEnv.CONNECTION_TOKENS!.idFromName(connectionId)) as DurableObjectStub<ConnectionTokenObject>
}

const aad = (connectionId: string, generation: number, kid: string) => ({ organization_id: ORG, connection_id: connectionId, service: SERVICE, generation, kid })

function sealUnder(keys: SealKeys, connectionId: string, generation: number): Promise<SealedEnvelope> {
  return seal(keys.publicKeys, JSON.stringify(LOGIN), aad(connectionId, generation, keys.kid as string))
}

async function openWith(ring: KeyRing, connectionId: string, login: StoredLogin): Promise<unknown> {
  return JSON.parse(await open(ring, login.envelope, aad(connectionId, login.generation, login.envelope.kid)))
}

/** OPS_GATEWAY as the object reaches it, answering storeRotatedEnvelope with `answer`. */
function gateway(answer: (request: Record<string, unknown>) => StoreRotatedEnvelopeAnswer | Promise<StoreRotatedEnvelopeAnswer>) {
  const requests: Array<Record<string, unknown>> = []
  const unused = async () => { throw new Error('not used') }
  return {
    requests,
    binding: {
      opsWorkflows: unused, opsTickStarted: unused, opsTickCompleted: unused, opsConnections: unused, moneyIdentities: unused, replaceConnectionEnvelope: unused,
      storeRotatedEnvelope: async (request: unknown) => {
        requests.push(request as Record<string, unknown>)
        return answer(request as Record<string, unknown>)
      },
    },
  }
}

async function wire(stub: DurableObjectStub<ConnectionTokenObject>, keys: () => SealKeys, gw?: ReturnType<typeof gateway>) {
  await runInDurableObject(stub, (o: ConnectionTokenObject) => {
    o.clock = () => T
    o.sealKeys = keys
    o.gateway = () => gw?.binding
    o.fetchToken = async () => { throw new Error('the reseal never calls the token endpoint') }
  })
}

/** Plants the login a rotation left in the object's storage. */
async function plant(stub: DurableObjectStub<ConnectionTokenObject>, login: StoredLogin, unanswered?: Array<{ generation: number; iv: string }>) {
  await runInDurableObject(stub, async (_o: ConnectionTokenObject, state: DurableObjectState) => {
    await state.storage.put('login', login)
    if (unanswered) await state.storage.put('unanswered', unanswered)
  })
}

async function storedLogin(stub: DurableObjectStub<ConnectionTokenObject>): Promise<StoredLogin | undefined> {
  return runInDurableObject(stub, (_o: ConnectionTokenObject, state: DurableObjectState) => state.storage.get<StoredLogin>('login'))
}

const ask = (connectionId: string, apply: boolean, over: Record<string, unknown> = {}) => ({ organizationId: ORG, connectionId, service: SERVICE, apply, ...over })

async function pendingLogin(connectionId: string, keys: SealKeys): Promise<StoredLogin> {
  return {
    organizationId: ORG, connectionId, service: SERVICE, generation: 4, envelope: await sealUnder(keys, connectionId, 4),
    committedGeneration: 3, writeBack: 'pending', attempts: 2,
  }
}

describe('resealLogin', () => {
  it('answers none for an object holding no login, which is every connection that is not person bound', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    await wire(stub, during)
    expect(await stub.resealLogin(ask(conn, true))).toEqual<ResealLoginAnswer>({ ok: true, state: 'none', fromKid: null })
    expect(await storedLogin(stub)).toBeUndefined()
  })

  it('previews by default: names a login under an old kid and changes nothing', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    await wire(stub, during)
    const login = await pendingLogin(conn, before())
    await plant(stub, login)
    expect(await stub.resealLogin(ask(conn, false))).toEqual<ResealLoginAnswer>({ ok: true, state: 'would_reseal', fromKid: OLD })
    expect(await stub.resealLogin({ organizationId: ORG, connectionId: conn, service: SERVICE })).toEqual<ResealLoginAnswer>({ ok: true, state: 'would_reseal', fromKid: OLD })
    expect(await storedLogin(stub)).toEqual(login)
  })

  it('reseals the same login to the current kid at the same generation, keeping every other field, and twice reseals nothing new', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    await wire(stub, during)
    const login = await pendingLogin(conn, before())
    await plant(stub, login)
    expect(await stub.resealLogin(ask(conn, true))).toEqual<ResealLoginAnswer>({ ok: true, state: 'resealed', fromKid: OLD })
    const after = (await storedLogin(stub))!
    expect(after.envelope.kid).toBe(NEW)
    expect(after.envelope.iv).not.toBe(login.envelope.iv)
    const { envelope: _a, ...rest } = after
    const { envelope: _b, ...was } = login
    expect(rest).toEqual(was)
    // The new key alone opens it, to the same login: the old key can go.
    expect(await openWith({ [NEW]: newPair.privatePem }, conn, after)).toEqual(LOGIN)
    expect(await stub.resealLogin(ask(conn, true))).toEqual<ResealLoginAnswer>({ ok: true, state: 'current', fromKid: NEW })
    expect((await storedLogin(stub))!.envelope).toEqual(after.envelope)
  })

  it('names a login whose kid it holds no key for, and changes nothing', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    await wire(stub, () => ({ ...during(), privateKeys: { [NEW]: newPair.privatePem } }))
    const login = await pendingLogin(conn, before())
    await plant(stub, login)
    expect(await stub.resealLogin(ask(conn, true))).toEqual<ResealLoginAnswer>({ ok: false, reason: 'no_key' })
    expect(await storedLogin(stub)).toEqual(login)
  })

  it('names an envelope that will not open under its kid, and leaves it as it was', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    // The old kid is held, but by the wrong key.
    await wire(stub, () => ({ ...during(), privateKeys: { [OLD]: newPair.privatePem, [NEW]: newPair.privatePem } }))
    const login = await pendingLogin(conn, before())
    await plant(stub, login)
    expect(await stub.resealLogin(ask(conn, true))).toEqual<ResealLoginAnswer>({ ok: false, reason: 'open_failed' })
    expect(await storedLogin(stub)).toEqual(login)
  })

  it('refuses a request naming another connection, organization or service, or a malformed one, and changes nothing', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    await wire(stub, during)
    const login = await pendingLogin(conn, before())
    await plant(stub, login)
    for (const over of [{ organizationId: '22222222-2222-4222-8222-222222222333' }, { service: 'other_user' }, { connectionId: connection() }]) {
      expect(await stub.resealLogin(ask(conn, true, over))).toEqual<ResealLoginAnswer>({ ok: false, reason: 'refused' })
    }
    expect(await stub.resealLogin('not a request')).toEqual<ResealLoginAnswer>({ ok: false, reason: 'refused' })
    expect(await stub.resealLogin(ask(conn, 'yes' as unknown as boolean))).toEqual<ResealLoginAnswer>({ ok: false, reason: 'refused' })
    expect(await storedLogin(stub)).toEqual(login)
  })

  it('stands aside while a refresh is in flight, so the two never both write a login', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    await wire(stub, during)
    const login = await pendingLogin(conn, before())
    await plant(stub, login)
    await runInDurableObject(stub, (o: ConnectionTokenObject) => {
      // A holder that started a moment ago, as holdFlight records it.
      ;(o as unknown as { inFlight: unknown }).inFlight = { startedAt: T, promise: new Promise(() => {}) }
    })
    expect(await stub.resealLogin(ask(conn, true))).toEqual<ResealLoginAnswer>({ ok: false, reason: 'busy' })
    expect(await storedLogin(stub)).toEqual(login)
  })

  it('answers no_current_kid while no kid is current, and changes nothing', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    await wire(stub, () => ({ ...during(), kid: null }))
    const login = await pendingLogin(conn, before())
    await plant(stub, login)
    expect(await stub.resealLogin(ask(conn, true))).toEqual<ResealLoginAnswer>({ ok: false, reason: 'no_current_kid' })
    expect(await storedLogin(stub)).toEqual(login)
  })
})

describe('the write back after a reseal', () => {
  it('sends the resealed login on its own schedule, under the current kid, at its generation, and lands', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    const gw = gateway(() => ({ outcome: 'stored', current_generation: 4, current_iv: 'x' }))
    await wire(stub, during, gw)
    await plant(stub, await pendingLogin(conn, before()))
    await stub.resealLogin(ask(conn, true))
    const resealed = (await storedLogin(stub))!
    await runInDurableObject(stub, (_o: ConnectionTokenObject, state: DurableObjectState) => state.storage.setAlarm(T))
    await runDurableObjectAlarm(stub)
    expect(gw.requests).toEqual([{ organization_id: ORG, connection_id: conn, expected_generation: 3, generation: 4, envelope: resealed.envelope }])
    expect(await storedLogin(stub)).toMatchObject({ writeBack: 'landed', committedGeneration: 4, envelope: resealed.envelope })
  })

  it('a send that landed under the old kid, whose answer was lost, is recognised after the reseal and kept, not given up as a Reconnect', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    const login = await pendingLogin(conn, before())
    // The row took the old envelope at generation 4 and the answer never came back; the reseal then gave the object a new iv.
    const gw = gateway(() => ({ outcome: 'moved', current_generation: 4, current_iv: login.envelope.iv }))
    await wire(stub, during, gw)
    await plant(stub, login, [{ generation: 4, iv: login.envelope.iv }])
    await stub.resealLogin(ask(conn, true))
    await runInDurableObject(stub, (_o: ConnectionTokenObject, state: DurableObjectState) => state.storage.setAlarm(T))
    await runDurableObjectAlarm(stub)
    const after = await storedLogin(stub)
    expect(after).toMatchObject({ generation: 4, committedGeneration: 4, writeBack: 'landed' })
    expect(after!.envelope.kid).toBe(NEW)
  })

  it('a reseal landing while a send is on its way is not read as a newer rotation, so the object rests rather than sending forever', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    const login = await pendingLogin(conn, before())
    // The reseal happens while the old envelope's send is in flight, and the row then takes that send. The
    // double runs inside the object's own alarm, so it writes through the object's storage directly.
    let storage!: DurableObjectStorage
    const gw = gateway(async () => {
      await storage.put('login', { ...login, envelope: await sealUnder(during(), conn, 4) })
      return { outcome: 'stored', current_generation: 4, current_iv: login.envelope.iv }
    })
    await wire(stub, during, gw)
    await runInDurableObject(stub, (_o: ConnectionTokenObject, state: DurableObjectState) => { storage = state.storage })
    await plant(stub, login)
    await runInDurableObject(stub, (_o: ConnectionTokenObject, state: DurableObjectState) => state.storage.setAlarm(T))
    await runDurableObjectAlarm(stub)
    expect(await storedLogin(stub)).toMatchObject({ generation: 4, committedGeneration: 4, writeBack: 'landed' })
    expect(gw.requests).toHaveLength(1)
  })
})
