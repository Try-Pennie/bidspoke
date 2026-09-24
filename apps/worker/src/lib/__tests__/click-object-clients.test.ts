/**
 * The click sold buyer's two object keys and the counter client (#1542).
 *
 * The click counter is a DailyCapObject named `clicks-{slug}-{Pacific date}`:
 * Dan's day for clicks ends at midnight PACIFIC, because clicks arrive after
 * offers and an Eastern day would push a late evening click into tomorrow's
 * count. The click claim is a LeadSaleObject under its own `click` kind, which
 * is not a ledger kind, so a click claim can never share an object with a sale.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { DeadlineError, LEDGER_KINDS, type Timers } from '@bidspoke/buyer-profile'
import { CLICK_CLAIM_KIND, ClickCounterClient, clickCounterObjectName, LeadSaleClient, leadSaleObjectName, ObjectCallError } from '../buyer-object-clients'

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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('clickCounterObjectName', () => {
  it('names the counter by slug and the Pacific date: 11:59pm is today, 12:01am is tomorrow', () => {
    expect(clickCounterObjectName('liberty1', Date.UTC(2027, 8, 21, 6, 59))).toEqual({ name: 'clicks-liberty1-2027-09-20', date: '2027-09-20' })
    expect(clickCounterObjectName('liberty1', Date.UTC(2027, 8, 21, 7, 1))).toEqual({ name: 'clicks-liberty1-2027-09-21', date: '2027-09-21' })
  })

  it('a 9:30pm Pacific click still counts on the Pacific day, although New York has already rolled', () => {
    expect(clickCounterObjectName('liberty1', Date.UTC(2027, 8, 21, 4, 30)).date).toBe('2027-09-20')
  })

  it('rolls at Pacific midnight on both daylight saving change days', () => {
    expect(clickCounterObjectName('evafi', Date.UTC(2027, 2, 14, 7, 59)).date).toBe('2027-03-13')
    expect(clickCounterObjectName('evafi', Date.UTC(2027, 2, 14, 8, 1)).date).toBe('2027-03-14')
    expect(clickCounterObjectName('evafi', Date.UTC(2027, 10, 7, 6, 59)).date).toBe('2027-11-06')
    expect(clickCounterObjectName('evafi', Date.UTC(2027, 10, 7, 7, 1)).date).toBe('2027-11-07')
  })

  it('never shares a name with the partner bid cap object for the same slug and day', () => {
    expect(clickCounterObjectName('liberty1', Date.UTC(2027, 8, 20, 18)).name.startsWith('cap-')).toBe(false)
  })
})

describe('the click claim key', () => {
  it('is a kind of its own, outside the ledger kinds', () => {
    expect(CLICK_CLAIM_KIND).toBe('click')
    expect((LEDGER_KINDS as readonly string[]).includes(CLICK_CLAIM_KIND)).toBe(false)
  })

  it('names the claim object by slug and prospect id under the click kind', () => {
    expect(leadSaleObjectName({ kind: 'click', partner_slug: 'liberty1', prospect_id: 'a0B000000000001AAA' })).toBe('sale:click:liberty1:a0B000000000001AAA')
    // A sale key is unchanged.
    expect(leadSaleObjectName({ kind: 'live', population: 'engine', lead_key: 'k' })).toBe('sale:live:engine:k')
  })

  it('the LeadSaleClient opens the click object by that name', () => {
    const { ns, names } = namespace(() => json({ state: 'free', generation: 0 }))
    new LeadSaleClient(ns, { kind: 'click', partner_slug: 'liberty1', prospect_id: 'p-1' })
    expect(names).toEqual(['sale:click:liberty1:p-1'])
  })
})

describe('ClickCounterClient', () => {
  it('adds a member through /add-member and returns what the object said', async () => {
    const { ns, names, requests } = namespace(() => json({ added: true, count: 3 }))
    const client = new ClickCounterClient(ns, 'liberty1', Date.UTC(2027, 8, 21, 6, 59))
    expect(await client.addMember('p-1')).toEqual({ added: true, count: 3 })
    expect(names).toEqual(['clicks-liberty1-2027-09-20'])
    expect(new URL(requests[0].url).pathname).toBe('/add-member')
    expect(await requests[0].json()).toEqual({ member: 'p-1' })
  })

  it('an object error is an ObjectCallError naming the call, never an answer', async () => {
    const { ns } = namespace(() => json({ error: 'bad_member' }, 400))
    await expect(new ClickCounterClient(ns, 'liberty1', 0).addMember('')).rejects.toBeInstanceOf(ObjectCallError)
  })

  it('an answer that is not the add shape is refused rather than read as a count', async () => {
    const { ns } = namespace(() => json({ added: 'yes' }))
    await expect(new ClickCounterClient(ns, 'liberty1', 0).addMember('p-1')).rejects.toThrow(/click counter add answered an unreadable body/)
  })

  it('carries a deadline, proven with timers fired by hand', async () => {
    const pending: Array<() => void> = []
    const timers: Timers = { setTimeout: (fn) => { pending.push(fn); return pending.length }, clearTimeout: () => undefined }
    const ns = { idFromName: (n: string) => ({ n }), get: () => ({ fetch: () => new Promise(() => undefined) }) } as unknown as DurableObjectNamespace
    const p = new ClickCounterClient(ns, 'liberty1', 0, { timers, deadlineMs: 50 }).addMember('p-1')
    pending.forEach((fn) => fn())
    await expect(p).rejects.toBeInstanceOf(DeadlineError)
  })

  it('reads the members list', async () => {
    const { ns, requests } = namespace(() => json({ count: 1, members: [{ member: 'p-1', added_at: 5 }] }))
    expect(await new ClickCounterClient(ns, 'liberty1', 0).members()).toEqual({ count: 1, members: [{ member: 'p-1', added_at: 5 }] })
    expect(new URL(requests[0].url).pathname).toBe('/members')
  })
})
