/**
 * POST /api/admin/re-archive: the only way to fill an archive hour that was
 * missed (#976).
 *
 * The archive advances strictly forward and its watermark only moves on, so
 * before this there was no path back to a skipped hour at all. The deletion gate
 * (#872) clears a day only when its counts reconcile, so one missed hour makes
 * that day permanently unverifiable, and after A5 (#873) the only escape would
 * be a recorded human release authorising deletion of data with no backup.
 *
 * The route is thin on purpose: the parsing rules are covered against their real
 * inputs in `archive/__tests__/rearchive-request.test.ts` and the archiving
 * itself in `execution-archive-rearchive.test.ts`. What is covered here is what
 * only the route decides, which is what the caller is told.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/execution-archive')
vi.mock('../../../lib/execution-archive-send')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { runExecutionArchive } from '../../../lib/execution-archive'
import { CRON_RUN_BUDGET, REQUEST_RUN_BUDGET } from '../../../archive/deadline'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

/** Long settled against any real clock, so the parser's readiness rule passes. */
const SETTLED_HOUR = '2020-01-01T05:00:00.000Z'

const CLEAN = {
  stop: 'caught-up',
  failed: false,
  hoursArchived: 1,
  hoursEmpty: 0,
  executionsArchived: 42,
  executionsRefused: 0,
  hoursBehind: 0,
  detail: 're-archived 1 hours and recorded 0 empty ones',
  subrequestsUsed: { read: 3, send: 1, record: 2, refusal: 0, total: 6 },
}

/**
 * Hours the archive is pretending to already hold. Defaults to "whatever was
 * asked for", so a single hour call reports complete, which is what really
 * happens once that hour is archived.
 */
let recordedHours: string[] | null = null

/**
 * How far behind the live archive is, for the yield rule (#1032). Default is a
 * healthy lag, because that is the ordinary case every other test here means.
 *
 * Reset in a top-level beforeEach rather than per describe: a test that sets it
 * to null leaks that into every later block otherwise, and the symptom lands
 * far away as an unrelated assertion (L205).
 */
const HEALTHY_LAG = () => new Date(Date.now() - 2 * 3_600_000).toISOString()
let watermarkHour: string | null = HEALTHY_LAG()

beforeEach(() => {
  watermarkHour = HEALTHY_LAG()
})

function makeSupabase(hourRows?: Array<{ hour_start: string }>) {
  return {
    from: (table: string) =>
      table === 'execution_archive_progress'
        ? {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: watermarkHour === null ? null : { watermark_hour: watermarkHour },
                    error: null,
                  }),
              }),
            }),
          }
        : table === 'execution_archive_hours'
        ? {
            select: () => ({
              in: (_col: string, hours: string[]) =>
                Promise.resolve({
                  // Postgres shape, NOT the ISO the caller asked with: a route
                  // that compares these raw finds no match, silently redoes
                  // everything, and the treadmill comes back with no symptom.
                  data:
                    hourRows ??
                    (recordedHours ?? hours).map((h) => ({
                      hour_start: h.replace('T', ' ').replace('.000Z', '+00'),
                    })),
                  error: null,
                }),
            }),
          }
        : ({} as Record<string, unknown>),
    rpc: (name: string) =>
      name === 'auth_user_with_allowlist'
        ? Promise.resolve({ data: [{ ...testUser, allowed: true }], error: null })
        : Promise.resolve({ data: [], error: null }),
  }
}

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function post(app: { request: Function }, body: Record<string, unknown>) {
  return app.request(
    '/admin/re-archive',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    testEnv,
    mockCtx
  )
}

describe('POST /admin/re-archive', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    recordedHours = null
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase() as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(runExecutionArchive).mockResolvedValue(
      CLEAN as unknown as Awaited<ReturnType<typeof runExecutionArchive>>
    )
    app = await makeApp()
  })

  it('runs the archiver over exactly the hours it was asked for', async () => {
    const res = await post(app, { hour: SETTLED_HOUR })

    expect(res.status).toBe(200)
    const deps = vi.mocked(runExecutionArchive).mock.calls[0][2] as { hours?: string[] }
    expect(deps.hours).toEqual([SETTLED_HOUR])
  })

  it('runs the hourly job itself rather than a separate recovery path', async () => {
    // A separate tool would be evidence about the tool, not about the archiver,
    // and would drift from it in exactly the situation where nobody is watching.
    await post(app, { hour: SETTLED_HOUR })

    expect(runExecutionArchive).toHaveBeenCalledTimes(1)
  })

  it('refuses a request it cannot act on, without running anything', async () => {
    const res = await post(app, { hour: '2020-01-01T05:30:00.000Z' })

    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toMatch(/hour boundary/)
    expect(runExecutionArchive).not.toHaveBeenCalled()
  })

  it('answers 409, not 200, when the archive is already running', async () => {
    // A locked run did NO work. Answering 200 with a summary of zeros would read
    // as an hour that turned out to be empty, and the caller has to be able to
    // tell "there is nothing there" from "we did not look" (L98).
    vi.mocked(runExecutionArchive).mockResolvedValue({
      ...CLEAN,
      skipped: 'locked',
      hoursArchived: 0,
      executionsArchived: 0,
      detail: 'another invocation has held the run lock for 2 minutes',
    } as unknown as Awaited<ReturnType<typeof runExecutionArchive>>)

    const res = await post(app, { hour: SETTLED_HOUR })

    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toMatch(/already running/)
  })

  it('answers 500 when the repair itself failed, rather than reporting a repair', async () => {
    vi.mocked(runExecutionArchive).mockResolvedValue({
      ...CLEAN,
      failed: true,
      hoursArchived: 0,
      detail: 're-archived 0 of 1 hours; 2020-01-01T05:00:00.000Z: counts did not match',
    } as unknown as Awaited<ReturnType<typeof runExecutionArchive>>)

    const res = await post(app, { hour: SETTLED_HOUR })

    expect(res.status).toBe(500)
  })

  it('requires a valid token like every other admin route', async () => {
    vi.mocked(verifyJwt).mockRejectedValue(new Error('bad token'))

    const res = await post(app, { hour: SETTLED_HOUR })

    expect(res.status).toBe(401)
    expect(runExecutionArchive).not.toHaveBeenCalled()
  })
})

describe('what the caller is told about progress (#1018, #1019)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const DAY = '2020-01-01'
  const dayHours = Array.from({ length: 24 }, (_, i) =>
    new Date(Date.parse(`${DAY}T00:00:00.000Z`) + i * 3600000).toISOString(),
  )

  beforeEach(async () => {
    vi.clearAllMocks()
    recordedHours = null
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase() as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(runExecutionArchive).mockResolvedValue(
      CLEAN as unknown as Awaited<ReturnType<typeof runExecutionArchive>>
    )
    app = await makeApp()
  })

  it('says the day is NOT complete, and how much is left, when most of it is still missing', async () => {
    // Measured on prod 2026-08-23: a day-scoped call answered 200 having recorded
    // 2 of 24 hours, and a driver written against it logged "reported complete"
    // and moved on. The count is read from the records, not from what the run
    // says it did.
    recordedHours = dayHours.slice(0, 2)

    const res = await post(app, { day: DAY })
    const body = await res.json() as { complete: boolean; hoursRecorded: number; hoursRemaining: number }

    expect(body.complete).toBe(false)
    expect(body.hoursRecorded).toBe(2)
    expect(body.hoursRemaining).toBe(22)
  })

  it('answers 202 for a partial day, so a caller reading only the status code is not misled', async () => {
    recordedHours = dayHours.slice(0, 2)

    const res = await post(app, { day: DAY })

    expect(res.status).toBe(202)
  })

  it('answers 200 and complete once every requested hour is recorded', async () => {
    recordedHours = dayHours

    const res = await post(app, { day: DAY })

    expect(res.status).toBe(200)
    expect((await res.json() as { complete: boolean }).complete).toBe(true)
  })

  it('tells the archiver to skip hours already recorded when a whole DAY was asked for', async () => {
    // Without this the run spends its budget redoing the first hours it can
    // afford and the day never advances (#1019).
    recordedHours = dayHours.slice(0, 2)

    await post(app, { day: DAY })

    const deps = vi.mocked(runExecutionArchive).mock.calls[0][2] as { alreadyRecorded?: ReadonlySet<string> }
    expect(deps.alreadyRecorded).toBeInstanceOf(Set)
    expect([...(deps.alreadyRecorded ?? [])].sort()).toEqual(dayHours.slice(0, 2))
  })

  it('does NOT skip anything when a single HOUR was named, so a deliberate redo still works', async () => {
    // The single hour form exists to re-archive an hour that was archived wrongly.
    recordedHours = [SETTLED_HOUR]

    await post(app, { hour: SETTLED_HOUR })

    const deps = vi.mocked(runExecutionArchive).mock.calls[0][2] as { alreadyRecorded?: ReadonlySet<string> }
    expect(deps.alreadyRecorded).toBeUndefined()
  })
})

describe('reading Postgres timestamps back', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const DAY = '2020-01-01'
  const dayHours = Array.from({ length: 24 }, (_, i) =>
    new Date(Date.parse(`${DAY}T00:00:00.000Z`) + i * 3600000).toISOString(),
  )

  beforeEach(async () => {
    vi.clearAllMocks()
    recordedHours = null
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase() as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(runExecutionArchive).mockResolvedValue(
      CLEAN as unknown as Awaited<ReturnType<typeof runExecutionArchive>>
    )
    app = await makeApp()
  })

  it('matches every rendering the database and the caller can disagree on', async () => {
    // NOT left to Date.parse's tolerance. A space separator instead of a T, a
    // two digit offset instead of four, a fractional second: these are all the
    // same instant, and whether a given engine parses them is
    // implementation-defined. Getting it wrong does not throw, it returns an
    // empty set, which means "skip nothing" and silently restores the treadmill.
    for (const rendering of [
      '2020-01-01 00:00:00+00',
      '2020-01-01T00:00:00+00:00',
      '2020-01-01 00:00:00.000+00',
      '2020-01-01T00:00:00Z',
    ]) {
      vi.mocked(runExecutionArchive).mockClear()
      recordedHours = null
      // The shared double, given this rendering, rather than a second one
      // written inline: a second copy answers a different set of tables and
      // drifts from the real client exactly where nobody is looking (L52).
      vi.mocked(createSupabaseClient).mockReturnValue(
        makeSupabase([{ hour_start: rendering }]) as unknown as ReturnType<typeof createSupabaseClient>
      )

      await post(app, { day: DAY })

      const deps = vi.mocked(runExecutionArchive).mock.calls[0][2] as { alreadyRecorded?: ReadonlySet<string> }
      expect([...(deps.alreadyRecorded ?? [])], `"${rendering}" was not recognised as hour 00`).toEqual([dayHours[0]])
    }
  })
})

/**
 * The repair yields to the live archive (#1027, #1032).
 *
 * They take the same lock. On 2026-08-23 a script drove this route every three
 * minutes for three hours, every hourly run answered skipped-locked, and the
 * live watermark sat still for 3.6 hours while the standstill alert blamed
 * Snowflake, which was fine.
 */
describe('POST /api/admin/re-archive yields to the live archive', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload as never)
    vi.mocked(runExecutionArchive).mockResolvedValue(CLEAN as never)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase() as unknown as ReturnType<typeof createSupabaseClient>
    )
    app = await makeApp()
  })

  it('runs normally while the archive is keeping up', async () => {
    const res = await post(app, { hour: SETTLED_HOUR })

    expect(res.status).not.toBe(409)
    expect(vi.mocked(runExecutionArchive)).toHaveBeenCalled()
  })

  it('refuses BEFORE taking the lock when the archive has lost ground', async () => {
    watermarkHour = new Date(Date.now() - 9 * 3_600_000).toISOString()

    const res = await post(app, { hour: SETTLED_HOUR })

    expect(res.status).toBe(409)
    // Refusing after the work started would have already displaced the hours
    // the refusal exists to protect (L667).
    expect(vi.mocked(runExecutionArchive)).not.toHaveBeenCalled()
    const body = await res.json() as { error: string; hoursBehind: number }
    expect(body.hoursBehind).toBeGreaterThan(4)
    expect(body.error).toContain('hours behind')
  })

  it('refuses when it cannot tell how far behind the archive is', async () => {
    watermarkHour = null

    const res = await post(app, { hour: SETTLED_HOUR })

    expect(res.status).toBe(409)
    expect(vi.mocked(runExecutionArchive)).not.toHaveBeenCalled()
  })

  it('goes ahead when the caller forces it in that request', async () => {
    watermarkHour = new Date(Date.now() - 40 * 3_600_000).toISOString()

    const res = await post(app, { hour: SETTLED_HOUR, force: true })

    expect(res.status).not.toBe(409)
    expect(vi.mocked(runExecutionArchive)).toHaveBeenCalled()
  })
})

/**
 * The re-archive runs to the budget its CONTEXT allows (#1048).
 *
 * This route is a fetch handler and the archive's default budget is sized
 * inside the platform's CRON limit. Measured 2026-08-24: the request was killed
 * at 218 seconds with Cloudflare 1102 partway through its second hour, while
 * the scheduled run did two comparable hours in 390 seconds the same night. A
 * run killed by the platform writes no record and sends no alert, so it ended
 * in the least informative way available, every time.
 */
describe('POST /api/admin/re-archive sizes its run for a request', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload as never)
    vi.mocked(runExecutionArchive).mockResolvedValue(CLEAN as never)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase() as unknown as ReturnType<typeof createSupabaseClient>
    )
  })

  it('passes the request budget rather than inheriting the cron one', async () => {
    const app = await makeApp()
    await post(app, { hour: SETTLED_HOUR })

    const deps = vi.mocked(runExecutionArchive).mock.calls[0][2] as { budget?: { wallMs: number; maxHours: number } }
    expect(deps.budget).toEqual(REQUEST_RUN_BUDGET)
  })

  it('commits to at most one hour, and stops before the observed kill', async () => {
    // Named against the measurements rather than restating the constant, so a
    // future edit that raises either one past what the context allows fails
    // here instead of in production (L63).
    expect(REQUEST_RUN_BUDGET.maxHours).toBe(1)
    // An hour of real data costs 202 to 257 seconds, and the request context
    // was killed at 218. One hour is the most it can honestly promise, and the
    // wall budget has to stop the run before the platform does.
    expect(REQUEST_RUN_BUDGET.wallMs).toBeLessThan(218_000)
    expect(REQUEST_RUN_BUDGET.wallMs).toBeLessThan(CRON_RUN_BUDGET.wallMs)
    expect(REQUEST_RUN_BUDGET.maxHours).toBeLessThan(CRON_RUN_BUDGET.maxHours)
  })
})
