import { describe, expect, it } from 'vitest'
import { catalogueActions, CATALOGUE } from '../../../schema'
import { resolveRuntimeAction } from '../..'
import { ActionFailure } from '../../failure'
import type { ActionArgs, RuntimeAction } from '../../types'
import { fakeSlack, posted, slackAnswer } from './fake-slack'

/**
 * The Slack action the Pipedream workflows use (#2337; counted in the export
 * of 2026-09-30, the duplicate project folder left out): every one of the 23
 * Slack message steps posts one message through chat.postMessage, whichever of
 * Pipedream's five send message components it was built from. It has the
 * fixtures every service PR carries: an expired login, revoked consent, a 429
 * with Retry-After, and the timeout after send that a non idempotent action
 * leaves to the executor as outcome unknown. A partial batch does not apply:
 * one post is one request, which Slack applies whole or not at all.
 */

function action(key: string): RuntimeAction {
  const resolved = resolveRuntimeAction(key, 1)
  if (!resolved.ok) throw new Error(resolved.message)
  return resolved.action
}

const SEND = action('slack.send-message')

async function failure(promise: Promise<unknown>): Promise<ActionFailure> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ActionFailure)
    return err as ActionFailure
  }
  throw new Error('expected an ActionFailure')
}

const ARGS: ActionArgs = { channel: 'C0OPS1', text: 'Daily report: *12* enrollments' }

describe('slack.send-message decides its own traits', () => {
  it('is the one Slack action, side effecting and not idempotent, and says why', () => {
    expect(catalogueActions(CATALOGUE).map((a) => `${a.key}@${a.version}`).filter((id) => id.startsWith('slack.'))).toEqual(['slack.send-message@1'])
    expect([SEND.sideEffect, SEND.idempotent]).toEqual([true, false])
    expect(SEND.idempotentBecause).toMatch(/twice/)
  })

  it('takes the conversation and the text, both required, and the rest optional', () => {
    const shape = Object.fromEntries(SEND.arguments.map((a) => [a.key, [a.type, a.required, a.allowsVariables, a.parseJson]]))
    expect(shape).toEqual({
      channel: ['text', true, true, false],
      text: ['text', true, true, false],
      thread_ts: ['text', false, true, false],
      reply_broadcast: ['text', false, true, true],
      mrkdwn: ['text', false, true, true],
      unfurl_links: ['text', false, true, true],
      unfurl_media: ['text', false, true, true],
      username: ['text', false, true, false],
      icon_emoji: ['text', false, true, false],
    })
  })
})

describe('slack.send-message@1', () => {
  it('posts one message through chat.postMessage, through the connection bound fetch, and returns what Slack answered', async () => {
    const f = fakeSlack()
    f.respond(posted())
    expect(await SEND.run(f.ctx, ARGS)).toEqual({
      ok: true,
      channel: 'C0OPS1',
      ts: '1729600000.000100',
      message: { type: 'message', text: 'hello', ts: '1729600000.000100', bot_id: 'B0OPS' },
    })
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0].url).toBe('https://slack.com/api/chat.postMessage')
    expect(f.sent[0].method).toBe('POST')
    // The connection applies the login: the action never holds or sends one.
    expect(f.sent[0].headers.get('authorization')).toBeNull()
    expect(f.sent[0].form).toEqual({ channel: 'C0OPS1', text: 'Daily report: *12* enrollments' })
  })

  it('sends every optional setting Pipedream offered and the steps carry, as Slack names them', async () => {
    const f = fakeSlack()
    f.respond(posted())
    await SEND.run(f.ctx, {
      ...ARGS,
      thread_ts: '1729500000.000200',
      reply_broadcast: true,
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: true,
      username: 'Ops reports',
      icon_emoji: ':bar_chart:',
    })
    expect(f.sent[0].form).toEqual({
      channel: 'C0OPS1',
      text: 'Daily report: *12* enrollments',
      thread_ts: '1729500000.000200',
      reply_broadcast: 'true',
      mrkdwn: 'false',
      unfurl_links: 'false',
      unfurl_media: 'true',
      username: 'Ops reports',
      icon_emoji: ':bar_chart:',
    })
  })

  it('sends a text that is not a string as JSON, as the Pipedream action did', async () => {
    const f = fakeSlack()
    f.respond(posted())
    await SEND.run(f.ctx, { channel: 'C0OPS1', text: { enrolled: 12 } })
    expect(f.sent[0].form.text).toBe('{"enrolled":12}')
    const g = fakeSlack()
    g.respond(posted())
    await SEND.run(g.ctx, { channel: 'C0OPS1', text: 42 })
    expect(g.sent[0].form.text).toBe('42')
  })

  it('refuses a missing conversation or text, and a setting of the wrong kind, before anything is sent', async () => {
    const cases: Array<[ActionArgs, string]> = [
      [{ text: 'x' }, 'slack_channel_missing'],
      [{ channel: '  ', text: 'x' }, 'slack_channel_missing'],
      [{ channel: 'C1' }, 'slack_text_missing'],
      [{ channel: 'C1', text: '' }, 'slack_text_missing'],
      [{ channel: 'C1', text: null }, 'slack_text_missing'],
      [{ channel: 'C1', text: 'x', mrkdwn: 'yes' }, 'slack_argument_invalid'],
      [{ channel: 'C1', text: 'x', unfurl_links: 1 }, 'slack_argument_invalid'],
      [{ channel: 'C1', text: 'x', thread_ts: 17 }, 'slack_argument_invalid'],
      [{ channel: 'C1', text: 'x', username: ['a'] }, 'slack_argument_invalid'],
    ]
    for (const [args, code] of cases) {
      const f = fakeSlack()
      const refused = await failure(SEND.run(f.ctx, args))
      expect([refused.code, refused.outcome], JSON.stringify(args)).toEqual([code, 'not_applied'])
      expect(f.sent).toEqual([])
    }
  })

  it('an ok:false answer fails with Slack\'s own error code, never a null, as not applied', async () => {
    for (const code of ['channel_not_found', 'not_in_channel', 'is_archived', 'msg_too_long', 'missing_scope']) {
      const f = fakeSlack()
      f.respond(slackAnswer({ ok: false, error: code }))
      const refused = await failure(SEND.run(f.ctx, ARGS))
      expect([refused.code, refused.outcome]).toEqual([`slack_${code}`, 'not_applied'])
      expect(refused.message).toContain(code)
    }
  })

  it('an ok:false answer that names no code still fails, by name, as not applied', async () => {
    const f = fakeSlack()
    f.respond(slackAnswer({ ok: false }))
    const refused = await failure(SEND.run(f.ctx, ARGS))
    expect([refused.code, refused.outcome]).toEqual(['slack_refused_without_code', 'not_applied'])
  })

  it('an expired login: what the connection bound fetch throws is passed on unchanged, and nothing more is sent', async () => {
    const expired = new Error('needs_reauth: request_refused_after_renew')
    const f = fakeSlack()
    f.respond({ throws: expired })
    await expect(SEND.run(f.ctx, ARGS)).rejects.toBe(expired)
    expect(f.sent).toHaveLength(1)
  })

  it('revoked consent: a token Slack revoked, or a scope it no longer grants, fails by Slack\'s code as not applied', async () => {
    // connectionFetch reads token_revoked as the login expiring (slack-service.ts), so on ops it arrives as a
    // needs_reauth refusal, as above. Reaching the action as an answer, it is still Slack's code, never a null.
    for (const code of ['token_revoked', 'account_inactive', 'missing_scope']) {
      const f = fakeSlack()
      f.respond(slackAnswer({ ok: false, error: code, needed: 'chat:write', provided: 'channels:read' }))
      const refused = await failure(SEND.run(f.ctx, ARGS))
      expect([refused.code, refused.outcome]).toEqual([`slack_${code}`, 'not_applied'])
    }
  })

  it('a 429 with Retry-After: a requeue from the connection bound fetch passes through unchanged, and nothing waits in the request', async () => {
    // connectionFetch answers a 429 with a RequeueAt carrying its not_before (connection-fetch.ts); the action
    // never sleeps (its ctx.sleep throws here) and never sends again.
    const requeue = { kind: 'requeue_at', notBefore: new Date('2026-10-22T15:00:20Z') }
    const f = fakeSlack()
    f.respond({ throws: requeue })
    await expect(SEND.run(f.ctx, ARGS)).rejects.toBe(requeue)
    expect(f.sent).toHaveLength(1)
  })

  it('a 429 that reaches the action as an answer is not applied, and names the wait', async () => {
    const f = fakeSlack()
    f.respond(slackAnswer({ ok: false, error: 'ratelimited' }, 429, { 'Retry-After': '30' }))
    const limited = await failure(SEND.run(f.ctx, ARGS))
    expect([limited.code, limited.outcome]).toEqual(['slack_rate_limited', 'not_applied'])
    expect(limited.message).toContain('30')
    expect(f.sent).toHaveLength(1)
  })

  it('a timeout after send is passed on unchanged: the executor records it as outcome unknown and never retries, since the action is not idempotent', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError')
    const f = fakeSlack()
    f.respond({ throws: timeout })
    await expect(SEND.run(f.ctx, ARGS)).rejects.toBe(timeout)
    expect(f.sent).toHaveLength(1)
    expect(SEND.idempotent).toBe(false)
  })

  it('a server error after send cannot say whether the message was posted, so its outcome is unknown', async () => {
    const f = fakeSlack()
    f.respond(new Response('<html>bad gateway</html>', { status: 502 }))
    const failed = await failure(SEND.run(f.ctx, ARGS))
    expect([failed.code, failed.outcome]).toEqual(['slack_http_502', 'unknown'])
  })

  it('a client error status is a request Slack refused, so it was not applied', async () => {
    const f = fakeSlack()
    f.respond(new Response('{"ok":false}', { status: 400 }))
    const failed = await failure(SEND.run(f.ctx, ARGS))
    expect([failed.code, failed.outcome]).toEqual(['slack_http_400', 'not_applied'])
  })

  it('a 200 whose body cannot be read may have posted, so its outcome is unknown', async () => {
    const f = fakeSlack()
    f.respond(new Response('<html>edge page</html>', { status: 200 }))
    const failed = await failure(SEND.run(f.ctx, ARGS))
    expect([failed.code, failed.outcome]).toEqual(['slack_answer_unreadable', 'unknown'])
  })

  it('an ok answer that names no message is applied, so it is never repeated', async () => {
    const f = fakeSlack()
    f.respond(slackAnswer({ ok: true }))
    const failed = await failure(SEND.run(f.ctx, ARGS))
    expect([failed.code, failed.outcome]).toEqual(['slack_answer_incomplete', 'applied'])
  })
})
