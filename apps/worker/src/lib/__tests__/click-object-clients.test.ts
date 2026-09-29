/**
 * The click sold buyer's two object keys and the counter client (#1542).
 *
 * The click counter is a DailyCapObject named `clicks-{partner id}-{Pacific date}`:
 * Dan's day for clicks ends at midnight PACIFIC, because clicks arrive after
 * offers and an Eastern day would push a late evening click into tomorrow's
 * count. The click claim is a LeadSaleObject under its own `click` kind, which
 * is not a ledger kind, so a click claim can never share an object with a sale.
 *
 * Both are named by the partner ID, never its slug (#1553, L15): a renamed slug
 * must find the same claims and the same count.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { DeadlineError, LEDGER_KINDS, isPartnerId as packageIsPartnerId, type Timers } from '@bidspoke/buyer-profile'
import { CLICK_CLAIM_KIND, CLICK_COUNT_COPY_WRITE_DEADLINE_MS, ClickCounterClient, clickCountCopyKey, clickCounterObjectName, isPartnerId as workerIsPartnerId, LeadSaleClient, leadSaleObjectName, ObjectCallError } from '../buyer-object-clients'

beforeAll(() => {
  // Far from Pacific, so a local Date getter would show up as the wrong day (L504).
  process.env.TZ = 'Europe/Berlin'
})

function namespace(handler: (req: Request) => Promise<Response> | Response) {
  const names: string[] = []
  const requests: Request[] = []
  const ns = {
    idFromName: (name: string) => {
      names.push(name)
      return { name } as unknown as DurableObjectId
    },
    get: () => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init)
        requests.push(req)
        return Promise.resolve(handler(req))
      },
    }),
  } as unknown as DurableObjectNamespace
  return { ns, names, requests }
}

const LIBERTY1 = '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70'
const EVAFI = '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A stand-in for the worker's KV store: what was put, and a put that can be made to fail. */
function memoryKv(opts: { failPut?: boolean; failGet?: boolean; hangPut?: boolean } = {}) {
  const store = new Map<string, string>()
  const puts: Array<{ key: string; value: string; ttl: number | undefined }> = []
  const kv = {
    get: async (key: string) => {
      if (opts.failGet) throw new Error('kv get failed')
      return store.get(key) ?? null
    },
    put: async (key: string, value: string, o?: { expirationTtl?: number }) => {
      if (opts.failPut) throw new Error('kv put failed')
      if (opts.hangPut) return new Promise<void>(() => undefined)
      puts.push({ key, value, ttl: o?.expirationTtl })
      store.set(key, value)
    },
  } as unknown as KVNamespace
  return { kv, store, puts }
}

describe('clickCounterObjectName', () => {
  it('names the counter by partner id and the Pacific date: 11:59pm is today, 12:01am is tomorrow', () => {
    expect(clickCounterObjectName(LIBERTY1, Date.UTC(2027, 8, 21, 6, 59))).toEqual({ name: `clicks-${LIBERTY1}-2027-09-20`, date: '2027-09-20' })
    expect(clickCounterObjectName(LIBERTY1, Date.UTC(2027, 8, 21, 7, 1))).toEqual({ name: `clicks-${LIBERTY1}-2027-09-21`, date: '2027-09-21' })
  })

  it('a 9:30pm Pacific click still counts on the Pacific day, although New York has already rolled', () => {
    expect(clickCounterObjectName(LIBERTY1, Date.UTC(2027, 8, 21, 4, 30)).date).toBe('2027-09-20')
  })

  it('rolls at Pacific midnight on both daylight saving change days', () => {
    expect(clickCounterObjectName(EVAFI, Date.UTC(2027, 2, 14, 7, 59)).date).toBe('2027-03-13')
    expect(clickCounterObjectName(EVAFI, Date.UTC(2027, 2, 14, 8, 1)).date).toBe('2027-03-14')
    expect(clickCounterObjectName(EVAFI, Date.UTC(2027, 10, 7, 6, 59)).date).toBe('2027-11-06')
    expect(clickCounterObjectName(EVAFI, Date.UTC(2027, 10, 7, 7, 1)).date).toBe('2027-11-07')
  })

  it('refuses a slug, or anything that is not a partner id, rather than naming an object by it (#1553)', () => {
    expect(() => clickCounterObjectName('liberty1', 0)).toThrow(/not a partner id/)
    expect(() => clickCounterObjectName('', 0)).toThrow(/not a partner id/)
  })

  it('never shares a name with the partner bid cap object for the same slug and day', () => {
    expect(clickCounterObjectName(LIBERTY1, Date.UTC(2027, 8, 20, 18)).name.startsWith('cap-')).toBe(false)
  })
})

describe('the click claim key', () => {
  it('is a kind of its own, outside the ledger kinds', () => {
    expect(CLICK_CLAIM_KIND).toBe('click')
    expect((LEDGER_KINDS as readonly string[]).includes(CLICK_CLAIM_KIND)).toBe(false)
  })

  it('names the claim object by partner id and prospect id under the click kind', () => {
    expect(leadSaleObjectName({ kind: 'click', partner_id: LIBERTY1, prospect_id: 'a0B000000000001AAA' })).toBe(`sale:click:${LIBERTY1}:a0B000000000001AAA`)
    // A sale key is unchanged.
    expect(leadSaleObjectName({ kind: 'live', population: 'engine', lead_key: 'k' })).toBe('sale:live:engine:k')
  })

  it('refuses a slug where the partner id belongs (#1553)', () => {
    expect(() => leadSaleObjectName({ kind: 'click', partner_id: 'liberty1', prospect_id: 'p-1' })).toThrow(/not a partner id/)
  })

  it('the LeadSaleClient opens the click object by that name', () => {
    const { ns, names } = namespace(() => json({ state: 'free', generation: 0 }))
    new LeadSaleClient(ns, { kind: 'click', partner_id: LIBERTY1, prospect_id: 'p-1' })
    expect(names).toEqual([`sale:click:${LIBERTY1}:p-1`])
  })
})

describe('ClickCounterClient', () => {
  it('adds a member through /add-member and returns what the object said', async () => {
    const { ns, names, requests } = namespace(() => json({ added: true, count: 3 }))
    const client = new ClickCounterClient(ns, memoryKv().kv, LIBERTY1, Date.UTC(2027, 8, 21, 6, 59))
    expect(await client.addMember('p-1')).toEqual({ added: true, count: 3 })
    expect(names).toEqual([`clicks-${LIBERTY1}-2027-09-20`])
    expect(new URL(requests[0].url).pathname).toBe('/add-member')
    expect(await requests[0].json()).toEqual({ member: 'p-1' })
  })

  it('an object error is an ObjectCallError naming the call, never an answer', async () => {
    const { ns } = namespace(() => json({ error: 'bad_member' }, 400))
    await expect(new ClickCounterClient(ns, memoryKv().kv, LIBERTY1, 0).addMember('')).rejects.toBeInstanceOf(ObjectCallError)
  })

  it('an answer that is not the add shape is refused rather than read as a count', async () => {
    const { ns } = namespace(() => json({ added: 'yes' }))
    await expect(new ClickCounterClient(ns, memoryKv().kv, LIBERTY1, 0).addMember('p-1')).rejects.toThrow(/click counter add answered an unreadable body/)
  })

  it('carries a deadline, proven with timers fired by hand', async () => {
    const pending: Array<() => void> = []
    const timers: Timers = { setTimeout: (fn) => { pending.push(fn); return pending.length }, clearTimeout: () => undefined }
    const ns = { idFromName: (n: string) => ({ n }), get: () => ({ fetch: () => new Promise(() => undefined) }) } as unknown as DurableObjectNamespace
    const p = new ClickCounterClient(ns, memoryKv().kv, LIBERTY1, 0, { timers, deadlineMs: 50 }).addMember('p-1')
    pending.forEach((fn) => fn())
    await expect(p).rejects.toBeInstanceOf(DeadlineError)
  })

  it('reads the members list', async () => {
    const { ns, requests } = namespace(() => json({ count: 1, members: [{ member: 'p-1', added_at: 5 }] }))
    expect(await new ClickCounterClient(ns, memoryKv().kv, LIBERTY1, 0).members()).toEqual({ count: 1, members: [{ member: 'p-1', added_at: 5 }] })
    expect(new URL(requests[0].url).pathname).toBe('/members')
  })

  it('reads the plain count through /member-count, a GET that sends no member (#1543)', async () => {
    const { ns, requests } = namespace(() => json({ count: 49 }))
    expect(await new ClickCounterClient(ns, memoryKv().kv, LIBERTY1, 0).memberCount()).toBe(49)
    expect(new URL(requests[0].url).pathname).toBe('/member-count')
    expect(requests[0].method).toBe('GET')
  })

  it('a count answer that is not a whole number is refused rather than compared with the cap', async () => {
    for (const body of [{}, { count: -1 }, { count: 1.5 }, { count: '3' }]) {
      const { ns } = namespace(() => json(body))
      await expect(new ClickCounterClient(ns, memoryKv().kv, LIBERTY1, 0).memberCount(), JSON.stringify(body)).rejects.toThrow(/click counter count answered an unreadable body/)
    }
  })

  it('a failed count read is an ObjectCallError, never a zero', async () => {
    const { ns } = namespace(() => json({ error: 'boom' }, 500))
    await expect(new ClickCounterClient(ns, memoryKv().kv, LIBERTY1, 0).memberCount()).rejects.toBeInstanceOf(ObjectCallError)
  })
})

describe('the partner id rule is the package one (#1543)', () => {
  it('the worker re-exports the exact function save validation calls', () => {
    expect(workerIsPartnerId).toBe(packageIsPartnerId)
  })
})

describe('the saved copy of the click count (#1632)', () => {
  const AT = Date.UTC(2027, 8, 21, 6, 59) // 2027-09-20 in Pacific

  it('is keyed on the partner id and the Pacific date the counter is for', () => {
    expect(clickCountCopyKey(LIBERTY1, '2027-09-20')).toBe(`click-count:${LIBERTY1}:2027-09-20`)
  })

  it('every add writes the count the object answered to the copy, so the offer check can read it without the object', async () => {
    const { ns } = namespace(() => json({ added: true, count: 7 }))
    const copy = memoryKv()
    const client = new ClickCounterClient(ns, copy.kv, LIBERTY1, AT)
    expect(await client.addMember('p-1')).toEqual({ added: true, count: 7 })
    expect(copy.puts).toEqual([{ key: `click-count:${LIBERTY1}:2027-09-20`, value: '7', ttl: 3 * 24 * 60 * 60 }])
    expect(await client.copyCount()).toBe(7)
  })

  it('a repeat add that counted nothing still writes the unchanged count, so a missing copy is repaired', async () => {
    const { ns } = namespace(() => json({ added: false, count: 7 }))
    const copy = memoryKv()
    await new ClickCounterClient(ns, copy.kv, LIBERTY1, AT).addMember('p-1')
    expect(copy.store.get(`click-count:${LIBERTY1}:2027-09-20`)).toBe('7')
  })

  it('a copy that fails to write never fails the add: the click was counted, and the next offer check falls back to the object', async () => {
    const { ns } = namespace(() => json({ added: true, count: 8 }))
    const copy = memoryKv({ failPut: true })
    expect(await new ClickCounterClient(ns, copy.kv, LIBERTY1, AT).addMember('p-1')).toEqual({ added: true, count: 8 })
  })

  it('a failed add writes no copy', async () => {
    const { ns } = namespace(() => json({ error: 'boom' }, 500))
    const copy = memoryKv()
    await expect(new ClickCounterClient(ns, copy.kv, LIBERTY1, AT).addMember('p-1')).rejects.toBeInstanceOf(ObjectCallError)
    expect(copy.puts).toEqual([])
  })

  it('no copy reads as null, never as zero clicks, and asks nothing of the object', async () => {
    const { ns, requests } = namespace(() => json({ count: 3 }))
    expect(await new ClickCounterClient(ns, memoryKv().kv, LIBERTY1, AT).copyCount()).toBeNull()
    expect(requests).toEqual([])
  })

  it('a stored copy that is not a whole number reads as null rather than as a count', async () => {
    for (const bad of ['', 'abc', '-1', '1.5', 'NaN']) {
      const copy = memoryKv()
      copy.store.set(`click-count:${LIBERTY1}:2027-09-20`, bad)
      expect(await new ClickCounterClient(namespace(() => json({})).ns, copy.kv, LIBERTY1, AT).copyCount(), bad).toBeNull()
    }
  })

  it('a copy for another day or another partner is not read', async () => {
    const copy = memoryKv()
    copy.store.set(`click-count:${LIBERTY1}:2027-09-19`, '40')
    copy.store.set(`click-count:${EVAFI}:2027-09-20`, '40')
    expect(await new ClickCounterClient(namespace(() => json({})).ns, copy.kv, LIBERTY1, AT).copyCount()).toBeNull()
  })

  it('seedCopy writes a count the object answered, for the first check of a day before any click', async () => {
    const copy = memoryKv()
    await new ClickCounterClient(namespace(() => json({})).ns, copy.kv, LIBERTY1, AT).seedCopy(0)
    expect(copy.store.get(`click-count:${LIBERTY1}:2027-09-20`)).toBe('0')
  })
})

describe('the saved copy never moves down (#1632 review)', () => {
  const AT = Date.UTC(2027, 8, 21, 6, 59)
  const KEY = `click-count:${LIBERTY1}:2027-09-20`

  it('an add whose answer is below the stored copy leaves the copy alone, so two adds landing out of order cannot lower it', async () => {
    const copy = memoryKv()
    copy.store.set(KEY, '11')
    await new ClickCounterClient(namespace(() => json({ added: true, count: 10 })).ns, copy.kv, LIBERTY1, AT).addMember('p-1')
    expect(copy.store.get(KEY)).toBe('11')
    expect(copy.puts).toEqual([])
  })

  it('an add above the stored copy raises it', async () => {
    const copy = memoryKv()
    copy.store.set(KEY, '11')
    await new ClickCounterClient(namespace(() => json({ added: true, count: 12 })).ns, copy.kv, LIBERTY1, AT).addMember('p-1')
    expect(copy.store.get(KEY)).toBe('12')
  })

  it('a seed cannot overwrite a higher count a click wrote meanwhile', async () => {
    const copy = memoryKv()
    copy.store.set(KEY, '11')
    await new ClickCounterClient(namespace(() => json({})).ns, copy.kv, LIBERTY1, AT).seedCopy(10)
    expect(copy.store.get(KEY)).toBe('11')
  })

  it('a stored copy that cannot be read is overwritten by the count the object answered', async () => {
    const copy = memoryKv()
    copy.store.set(KEY, 'garbage')
    await new ClickCounterClient(namespace(() => json({ added: true, count: 4 })).ns, copy.kv, LIBERTY1, AT).addMember('p-1')
    expect(copy.store.get(KEY)).toBe('4')
  })

  it('a copy write that never answers is abandoned at its deadline, and the add still returns the count', async () => {
    const pending: Array<() => void> = []
    const deadlines: number[] = []
    const timers: Timers = { setTimeout: (fn, ms) => { deadlines.push(ms); pending.push(fn); return pending.length }, clearTimeout: () => undefined }
    const copy = memoryKv({ hangPut: true })
    const p = new ClickCounterClient(namespace(() => json({ added: true, count: 5 })).ns, copy.kv, LIBERTY1, AT, { timers }).addMember('p-1')
    for (let i = 0; i < 10 && pending.length < 2; i++) await Promise.resolve()
    pending.splice(0).forEach((fn) => fn())
    expect(await p).toEqual({ added: true, count: 5 })
    expect(deadlines).toContain(CLICK_COUNT_COPY_WRITE_DEADLINE_MS)
  })
})
