/**
 * The scheduled Slack lookups page Better Stack when nobody can be told (#2063).
 *
 * Only the three `unreachable` results that mean the database did not answer AND
 * no saved copy could stand in (`no_copy`, `org_not_in_copy`, `copy_unreadable`)
 * page; a live answer, a copy answer and "no connection" never do. The page is
 * handed to the tick's waitUntil and never awaited, so a page that hangs or
 * fails cannot delay or fail the job whose lookup raised it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lookupSlackConnection } from '../slack'
import { slackOrgIds } from '../alert-fanout'
import { createScheduledSupabaseClient, registerScheduledSlack } from '../scheduled-slack'
import type { NobodyToldPager } from '../nobody-told-page'
import { NOBODY_TOLD_LINE } from '../nobody-told-page'
import type { CopyUnreachableReason } from '../scheduled-slack'
import type { Env } from '../../env'
import { fakeClient, fakeTimers, kvWith, kvWithCopy, OTHER_KEY, STORED_CONN, TEST_KEY, type Answer } from './_scheduled-slack-doubles'
import { encryptSecret } from '../secret-crypto'
import { SLACK_CONNS_LASTGOOD_KEY } from '../slack-copy'

const ORG = 'org-1'

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

/** A pager that records each page, and settles as the test says. */
function recordingPager(settle: 'resolve' | 'never' | 'reject' = 'resolve') {
  const pages: { orgId: string | null; reason: CopyUnreachableReason }[] = []
  const pager: NobodyToldPager = {
    page(orgId, reason) {
      pages.push({ orgId, reason })
      if (settle === 'never') return new Promise<void>(() => {})
      if (settle === 'reject') return Promise.reject(new Error('page blew up'))
      return Promise.resolve()
    },
  }
  return { pager, pages }
}

async function setup(answers: Answer[], kvKind: 'empty' | 'copy' | 'unreadable', settle: 'resolve' | 'never' | 'reject' = 'resolve') {
  const { client } = fakeClient(answers)
  const kv = kvKind === 'empty'
    ? kvWith()
    : kvKind === 'copy'
      ? await kvWithCopy({ [ORG]: STORED_CONN })
      : kvWith({ [SLACK_CONNS_LASTGOOD_KEY]: await encryptSecret(JSON.stringify({ [ORG]: STORED_CONN }), OTHER_KEY) })
  const { pager, pages } = recordingPager(settle)
  const handed: Promise<unknown>[] = []
  registerScheduledSlack(client, { kv, secretKeys: TEST_KEY, sleep: fakeTimers('never').sleep, pager, waitUntil: (p) => handed.push(p) })
  return { client, pages, handed }
}

describe('a lookup that someone can be told from never pages', () => {
  it.each<[string, Answer[], 'empty' | 'copy']>([
    ['a live answer', [{ data: { config: { bot_token: 'xoxb-live', default_channel: '#live' } } }], 'empty'],
    ['no connection, the database answering', [{ data: null }], 'empty'],
    ['an answer from the saved copy', [{ error: { message: 'boom' } }], 'copy'],
  ])('%s', async (_label, answers, kvKind) => {
    const { client, pages, handed } = await setup(answers, kvKind)
    const result = await lookupSlackConnection(client, ORG)
    expect(result.kind).not.toBe('unreachable')
    expect(pages).toEqual([])
    expect(handed).toEqual([])
  })
})

describe('a lookup nobody can be told from pages, once, through waitUntil', () => {
  it.each<[CopyUnreachableReason, 'empty' | 'copy' | 'unreadable', string]>([
    ['no_copy', 'empty', ORG],
    ['copy_unreadable', 'unreadable', ORG],
    ['org_not_in_copy', 'copy', 'org-missing'],
  ])('%s', async (reason, kvKind, orgId) => {
    const { client, pages, handed } = await setup([{ error: { message: 'boom' } }], kvKind)
    expect(await lookupSlackConnection(client, orgId)).toEqual({ kind: 'unreachable', reason })
    expect(pages).toEqual([{ orgId, reason }])
    expect(handed).toHaveLength(1)
  })

  it('the all organization list read pages with no organization named', async () => {
    const { client, pages } = await setup([{ error: { message: 'boom' } }], 'empty')
    expect(await slackOrgIds(client, 'test', 'tell-only')).toEqual({ kind: 'unreachable', reason: 'no_copy' })
    expect(pages).toEqual([{ orgId: null, reason: 'no_copy' }])
  })

  it('the all organization list read pages when the saved copy answers with no organization in it', async () => {
    // The copy stands in but names nobody (written while no org had Slack, or
    // every entry unparseable), so the check tells nobody: the same case.
    const { client } = fakeClient([{ error: { message: 'boom' } }])
    const { pager, pages } = recordingPager()
    registerScheduledSlack(client, { kv: await kvWithCopy({}), secretKeys: TEST_KEY, sleep: fakeTimers('never').sleep, pager, waitUntil: () => {} })
    expect(await slackOrgIds(client, 'test', 'tell-only')).toEqual({ kind: 'stored', orgIds: [], ageMs: null })
    expect(pages).toEqual([{ orgId: null, reason: 'org_not_in_copy' }])
  })

  it('a copy that names an organization does not page from the list read', async () => {
    const { client, pages } = await setup([{ error: { message: 'boom' } }], 'copy')
    expect(await slackOrgIds(client, 'test', 'tell-only')).toEqual({ kind: 'stored', orgIds: [ORG], ageMs: null })
    expect(pages).toEqual([])
  })

  it('a check that measures from the database and judges nothing does not page', async () => {
    const { client, pages } = await setup([{ error: { message: 'boom' } }], 'empty')
    expect(await slackOrgIds(client, 'test', 'measure-from-database')).toEqual({ kind: 'unreachable', reason: 'database_not_answering' })
    expect(pages).toEqual([])
  })
})

describe('the page never holds up or fails the tick', () => {
  it('the lookup answers while the page has not settled', async () => {
    const { client, pages } = await setup([{ error: { message: 'boom' } }], 'empty', 'never')
    // Would hang the test (and its timeout would fail it) if the lookup awaited the page.
    expect(await lookupSlackConnection(client, ORG)).toEqual({ kind: 'unreachable', reason: 'no_copy' })
    expect(pages).toHaveLength(1)
  })

  it('a page that rejects does not reject the lookup, and its rejection is handled', async () => {
    const { client, handed } = await setup([{ error: { message: 'boom' } }], 'empty', 'reject')
    expect(await lookupSlackConnection(client, ORG)).toEqual({ kind: 'unreachable', reason: 'no_copy' })
    await expect(Promise.all(handed)).resolves.toBeDefined()
  })
})

describe('the scheduled handler client wires the real pager from the worker secrets', () => {
  const env = (extra: Record<string, unknown>) => ({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
    SECRET_ENCRYPTION_KEY: TEST_KEY,
    IDEMPOTENCY: { get: async () => null, put: async () => {} },
    ...extra,
  }) as unknown as Env
  const unavailable = (async () => new Response('{"message":"unavailable"}', { status: 503, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

  it('posts the fixed line to the configured source when nobody can be told', async () => {
    const posted: { url: string; body: unknown }[] = []
    const pageFetch = (async (url: string, init: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(null, { status: 202 })
    }) as unknown as typeof fetch
    const handed: Promise<unknown>[] = []
    const client = createScheduledSupabaseClient(
      env({ BETTERSTACK_OUTAGE_TOKEN: 'tok', BETTERSTACK_OUTAGE_URL: 'https://s1.betterstackdata.com' }),
      (p) => handed.push(p),
      { fetch: unavailable, pageFetch, sleep: fakeTimers('never').sleep },
    )
    expect(await lookupSlackConnection(client, ORG)).toEqual({ kind: 'unreachable', reason: 'no_copy' })
    await Promise.all(handed)
    expect(posted).toEqual([{ url: 'https://s1.betterstackdata.com', body: expect.objectContaining({ message: NOBODY_TOLD_LINE, organization_id: ORG, reason: 'no_copy' }) }])
  })

  it('posts nothing while the secrets are unset', async () => {
    const pageFetch = vi.fn() as unknown as typeof fetch
    const handed: Promise<unknown>[] = []
    const client = createScheduledSupabaseClient(env({}), (p) => handed.push(p), { fetch: unavailable, pageFetch, sleep: fakeTimers('never').sleep })
    await lookupSlackConnection(client, ORG)
    await Promise.all(handed)
    expect(pageFetch).not.toHaveBeenCalled()
  })
})
