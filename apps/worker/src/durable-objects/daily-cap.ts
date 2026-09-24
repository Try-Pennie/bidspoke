/**
 * Daily Cap Durable Object (PRD Section 2.5.1). One object per partner per day.
 *
 * The day lives in the object's NAME, and a new day is a new object with a
 * fresh count. Two names are in use, each derived in one place:
 *
 *   `cap-{partner_slug}-{YYYY-MM-DD}`     the partner bid daily cap, on the
 *                                         EASTERN date (lib/daily-cap-name.ts, #1410)
 *   `clicks-{partner_id}-{YYYY-MM-DD}`    a click sold buyer's count of clicks
 *                                         sent, on the PACIFIC date, keyed on the
 *                                         partner id so a slug rename keeps it
 *                                         (lib/buyer-object-clients.ts, #1542, #1553)
 *
 * Two independent counts live here and never touch each other:
 *   /check-and-increment, /decrement, /get-count, /reset   a plain counter
 *   /add-member, /members                                  a SET of member ids;
 *       the count is the number of distinct members, so adding the same id
 *       twice (a retried click, a repeat send) never counts it twice.
 *
 * All writes are durable (ctx.storage). Two concurrent adds of one member
 * count it once: the Workers suite proves it. That holds today through
 * workerd's input gates alone (the suite still passes with the
 * blockConcurrencyWhile below removed, measured 2026-09-24), so the wrapper is
 * kept only so the property does not depend on the add never gaining a non
 * storage await between its read and its write.
 */

interface CapStorage {
  count: number
}

export interface CapCheckResult {
  allowed: boolean
  count: number
  cap: number | null
}

/** One member of the distinct set, with the instant it was first added. */
export interface CapMember {
  member: string
  added_at: number
}

export interface AddMemberResult {
  added: boolean
  count: number
}

export interface MembersResult {
  count: number
  members: CapMember[]
}

interface StoredMember {
  added_at: number
  seq: number
}

const MEMBER_PREFIX = 'member:'
const MEMBER_SEQ_KEY = 'member_seq'
/** A prospect id is 15 or 18 characters; the bound only stops an unbounded storage key. */
export const MAX_MEMBER_LENGTH = 200

export class DailyCapObject implements DurableObject {
  state: DurableObjectState
  /** Replaced by tests through runInDurableObject; production never touches it. */
  clock: () => number = () => Date.now()

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    switch (path) {
      case '/check-and-increment': return this.handleCheckAndIncrement(request)
      case '/decrement':           return this.handleDecrement()
      case '/get-count':           return this.handleGetCount()
      case '/reset':               return this.handleReset()
      case '/add-member':          return this.handleAddMember(request)
      case '/members':             return this.handleMembers()
      default:
        return new Response('Not found', { status: 404 })
    }
  }

  private async load(): Promise<CapStorage> {
    const stored = await this.state.storage.get<CapStorage>('data')
    return stored ?? { count: 0 }
  }

  private async save(data: CapStorage): Promise<void> {
    await this.state.storage.put('data', data)
  }

  /**
   * Atomically checks if count < cap and increments if allowed.
   * Body: { cap: number | null }
   * Returns: { allowed: boolean, count: number, cap: number | null }
   */
  private async handleCheckAndIncrement(request: Request): Promise<Response> {
    const body = await request.json<{ cap: number | null }>()
    const cap = body.cap
    const data = await this.load()

    // null cap = unlimited
    if (cap === null || data.count < cap) {
      data.count++
      await this.save(data)
      return json<CapCheckResult>({ allowed: true, count: data.count, cap })
    }

    return json<CapCheckResult>({ allowed: false, count: data.count, cap })
  }

  /**
   * Refund a previously-reserved slot. Used when a lead reserved a slot via
   * check-and-increment but was never really submitted (duplicate / error), so
   * the cap reflects actual partner submissions (#68). Floors at 0 so a stray
   * extra refund can't drive the count negative and silently widen the cap.
   */
  private async handleDecrement(): Promise<Response> {
    const data = await this.load()
    data.count = Math.max(0, data.count - 1)
    await this.save(data)
    return json({ count: data.count })
  }

  private async handleGetCount(): Promise<Response> {
    const data = await this.load()
    return json({ count: data.count })
  }

  /**
   * Adds a member to the day's distinct set, once.
   * Body: { member: string }
   * Returns: { added, count }; `added` is false when the member was already there.
   */
  private async handleAddMember(request: Request): Promise<Response> {
    let member: unknown
    try {
      member = (await request.json<{ member?: unknown }>())?.member
    } catch {
      return json({ error: 'bad_member' }, 400)
    }
    if (!isMember(member)) return json({ error: 'bad_member' }, 400)
    return this.state.blockConcurrencyWhile(async () => {
      const key = MEMBER_PREFIX + member
      const existing = await this.state.storage.get<StoredMember>(key)
      if (!existing) {
        const seq = ((await this.state.storage.get<number>(MEMBER_SEQ_KEY)) ?? 0) + 1
        await this.state.storage.put<StoredMember | number>({ [key]: { added_at: this.clock(), seq }, [MEMBER_SEQ_KEY]: seq })
      }
      const count = (await this.state.storage.list({ prefix: MEMBER_PREFIX })).size
      return json<AddMemberResult>({ added: !existing, count })
    })
  }

  /** Every member, in the order first added. */
  private async handleMembers(): Promise<Response> {
    const stored = await this.state.storage.list<StoredMember>({ prefix: MEMBER_PREFIX })
    const members = [...stored.entries()]
      .sort((a, b) => a[1].seq - b[1].seq)
      .map(([key, v]): CapMember => ({ member: key.slice(MEMBER_PREFIX.length), added_at: v.added_at }))
    return json<MembersResult>({ count: members.length, members })
  }

  private async handleReset(): Promise<Response> {
    await this.save({ count: 0 })
    return json({ ok: true, count: 0 })
  }
}

function isMember(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_MEMBER_LENGTH
}

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
