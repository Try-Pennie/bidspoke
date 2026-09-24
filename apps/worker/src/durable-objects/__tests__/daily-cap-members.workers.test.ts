/**
 * DailyCapObject's distinct member count against real storage inside workerd
 * (#1542). The click counter adds a prospect id once per buyer per Pacific
 * day: a repeat add of the same id is a no-op, so the count is the number of
 * distinct prospects and a retried or replayed add can never inflate it.
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../index'
import type { DailyCapObject } from '../daily-cap'

const bindings = env as unknown as Pick<Env, 'DAILY_CAP'>
const NOW = Date.UTC(2027, 8, 20, 15, 30)

let seq = 0
function counter(): DurableObjectStub {
  seq += 1
  return bindings.DAILY_CAP.get(bindings.DAILY_CAP.idFromName(`clicks-test-2027-09-20-${seq}`))
}

async function setClock(stub: DurableObjectStub, ms: number): Promise<void> {
  await runInDurableObject(stub, (instance: DailyCapObject) => {
    instance.clock = () => ms
  })
}

function add(stub: DurableObjectStub, member: unknown): Promise<Response> {
  return stub.fetch('http://do/add-member', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member }) })
}

describe('DailyCapObject /add-member and /members', () => {
  it('adds a member once, and a repeat of the same member neither adds nor counts again', async () => {
    const stub = counter()
    await setClock(stub, NOW)
    expect(await (await add(stub, 'a0B000000000001')).json()).toEqual({ added: true, count: 1 })
    expect(await (await add(stub, 'a0B000000000001')).json()).toEqual({ added: false, count: 1 })
    expect(await (await add(stub, 'a0B000000000002')).json()).toEqual({ added: true, count: 2 })
  })

  it('lists every member with the time it was first added, in the order added', async () => {
    const stub = counter()
    await setClock(stub, NOW)
    await add(stub, 'p-1')
    await setClock(stub, NOW + 1000)
    await add(stub, 'p-2')
    await setClock(stub, NOW + 2000)
    await add(stub, 'p-1')
    const res = await stub.fetch('http://do/members')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ count: 2, members: [{ member: 'p-1', added_at: NOW }, { member: 'p-2', added_at: NOW + 1000 }] })
  })

  it('concurrent adds of one member count it once', async () => {
    const stub = counter()
    await setClock(stub, NOW)
    const results = await Promise.all([add(stub, 'same'), add(stub, 'same'), add(stub, 'same')].map(async (p) => (await p).json<{ added: boolean; count: number }>()))
    expect(results.filter((r) => r.added)).toHaveLength(1)
    expect(results.every((r) => r.count === 1)).toBe(true)
  })

  it('refuses a member that is not a non empty string, and counts nothing', async () => {
    const stub = counter()
    for (const bad of ['', '   ', 7, null, 'x'.repeat(201)]) {
      const res = await add(stub, bad)
      expect(res.status, JSON.stringify(bad)).toBe(400)
      expect(await res.json()).toEqual({ error: 'bad_member' })
    }
    expect(await (await stub.fetch('http://do/members')).json()).toEqual({ count: 0, members: [] })
  })

  it('/member-count answers the distinct count and adds nothing, however often it is read (#1543)', async () => {
    const stub = counter()
    await setClock(stub, NOW)
    expect(await (await stub.fetch('http://do/member-count')).json()).toEqual({ count: 0 })
    await add(stub, 'p-1')
    await add(stub, 'p-2')
    await add(stub, 'p-1')
    for (let i = 0; i < 3; i++) expect(await (await stub.fetch('http://do/member-count')).json()).toEqual({ count: 2 })
    expect(await (await stub.fetch('http://do/members')).json()).toEqual({ count: 2, members: [{ member: 'p-1', added_at: NOW }, { member: 'p-2', added_at: NOW }] })
  })

  it('/member-count equals the size of the member list after repeats, concurrent repeats included (#1557: it reads the sequence, one key)', async () => {
    const stub = counter()
    await setClock(stub, NOW)
    for (const m of ['p-1', 'p-2', 'p-1', 'p-3', 'p-2', 'p-1']) await add(stub, m)
    await Promise.all(['p-4', 'p-4', 'p-3', 'p-4'].map((m) => add(stub, m)))
    const listed = await (await stub.fetch('http://do/members')).json<{ count: number; members: unknown[] }>()
    expect(listed.members).toHaveLength(4)
    expect(await (await stub.fetch('http://do/member-count')).json()).toEqual({ count: listed.members.length })
    // The add's own answer is the same number.
    expect(await (await add(stub, 'p-1')).json()).toEqual({ added: false, count: 4 })
  })

  it('/member-count reads one key and never lists the members', async () => {
    const stub = counter()
    await setClock(stub, NOW)
    await add(stub, 'p-1')
    await add(stub, 'p-2')
    await runInDurableObject(stub, async (instance: DailyCapObject, state) => {
      const list = vi.spyOn(state.storage, 'list')
      const res = await instance.fetch(new Request('http://do/member-count'))
      expect(await res.json()).toEqual({ count: 2 })
      expect(list).not.toHaveBeenCalled()
      list.mockRestore()
    })
  })

  it('leaves the existing counter untouched: members are not the check-and-increment count', async () => {
    const stub = counter()
    await setClock(stub, NOW)
    await add(stub, 'p-1')
    expect(await (await stub.fetch('http://do/get-count', { method: 'POST' })).json()).toEqual({ count: 0 })
  })
})
