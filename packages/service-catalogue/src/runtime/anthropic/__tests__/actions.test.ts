import { describe, expect, it } from 'vitest'
import { catalogueActions, CATALOGUE } from '../../../schema'
import { resolveRuntimeAction } from '../..'
import { ActionFailure } from '../../failure'
import type { ActionArgs, JsonValue, RuntimeAction } from '../../types'
import { anthropicAnswer, anthropicError, fakeAnthropic, message } from './fake-anthropic'

/**
 * The Anthropic action the Pipedream workflows use (#2337; counted in the
 * export of 2026-09-30, the duplicate project folder left out, steps inside
 * if/else branches counted): 2 `anthropic-chat` registry steps and 1 code step
 * that sends documents with a system prompt and a JSON schema format, all one
 * call to the Messages API. It has the fixtures every service PR carries: an
 * expired or revoked key, a 429 with Retry-After, a timeout after send, a
 * server error, and an answer cut short at max_tokens, reported apart from a
 * finished one.
 */

function action(key: string): RuntimeAction {
  const resolved = resolveRuntimeAction(key, 1)
  if (!resolved.ok) throw new Error(resolved.message)
  return resolved.action
}

const CHAT = action('anthropic.chat')

async function failure(promise: Promise<unknown>): Promise<ActionFailure> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ActionFailure)
    return err as ActionFailure
  }
  throw new Error('expected an ActionFailure')
}

const ARGS: ActionArgs = { model: 'claude-sonnet-4-5-20250929', user_message: 'Summarise this pitch.', max_tokens: 400 }

describe('anthropic.chat decides its own traits', () => {
  it('is the one Anthropic action, side effecting and never repeated, since it is billed and a second call is a different answer', () => {
    expect(catalogueActions(CATALOGUE).map((a) => `${a.key}@${a.version}`).filter((id) => id.startsWith('anthropic.'))).toEqual(['anthropic.chat@1'])
    expect([CHAT.sideEffect, CHAT.idempotent]).toEqual([true, false])
    expect(CHAT.idempotentBecause).toMatch(/billed/)
  })

  it('takes the arguments Pipedream offered and the code step uses, by the names Anthropic gives them', () => {
    const shape = Object.fromEntries(CHAT.arguments.map((x) => [x.key, [x.type, x.required, x.allowsVariables, x.parseJson]]))
    expect(shape).toEqual({
      model: ['text', true, true, false],
      user_message: ['text', false, true, false],
      messages: ['text', false, true, true],
      system: ['text', false, true, false],
      max_tokens: ['text', true, true, true],
      temperature: ['text', false, true, true],
      top_p: ['text', false, true, true],
      top_k: ['text', false, true, true],
      stop_sequences: ['text', false, true, true],
      output_format: ['text', false, true, true],
    })
  })
})

describe('anthropic.chat@1', () => {
  it('sends one message through the connection bound fetch, with the API version and no key of its own, and returns what Pipedream returned', async () => {
    const f = fakeAnthropic()
    f.respond(message(['A lender pitch, ', 'in short.']))
    const out = (await CHAT.run(f.ctx, ARGS)) as Record<string, unknown>
    expect(f.sent.map((s) => [s.method, s.url])).toEqual([['POST', 'https://api.anthropic.com/v1/messages']])
    expect(f.sent[0].headers.get('anthropic-version')).toBe('2023-06-01')
    expect(f.sent[0].headers.get('content-type')).toBe('application/json')
    // connectionFetch puts the key and the workspace on the request: the action never holds either.
    expect(f.sent[0].headers.get('x-api-key')).toBeNull()
    expect(f.sent[0].headers.get('anthropic-workspace-id')).toBeNull()
    expect(f.sent[0].body).toEqual({ model: 'claude-sonnet-4-5-20250929', max_tokens: 400, messages: [{ role: 'user', content: 'Summarise this pitch.' }] })
    expect(out.id).toBe('msg_0PS')
    expect(out.text).toBe('A lender pitch, in short.')
    expect(out.stop_reason).toBe('end_turn')
    expect(out.original_messages).toEqual(['Summarise this pitch.'])
    expect(out.original_messages_with_assistant_response).toEqual(['Summarise this pitch.', 'A lender pitch, in short.'])
  })

  it('reads prior messages as Pipedream did, alternating from the person, and appends the user message', async () => {
    const f = fakeAnthropic()
    f.respond(message(['ok']))
    await CHAT.run(f.ctx, { ...ARGS, messages: ['Hi', 'Hello, how can I help?'] })
    expect(f.sent[0].body?.messages).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello, how can I help?' },
      { role: 'user', content: 'Summarise this pitch.' },
    ])
  })

  it('takes whole messages with content blocks, a system prompt and a JSON schema format, as the code step sends them, and parses the answer', async () => {
    const content: JsonValue[] = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' }, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Review the loan documents.' },
    ]
    const format = { type: 'json_schema', schema: { type: 'object', properties: { verdict: { type: 'string' } } } }
    const f = fakeAnthropic()
    f.respond(message(['{"verdict":"eligible"}']))
    const out = (await CHAT.run(f.ctx, {
      model: 'claude-opus-5', max_tokens: 4000, system: 'You review loan documents.', messages: [{ role: 'user', content }], output_format: format,
      temperature: 0, top_p: 0.9, top_k: 40, stop_sequences: ['END'],
    })) as Record<string, unknown>
    expect(f.sent[0].body).toEqual({
      model: 'claude-opus-5', max_tokens: 4000, system: 'You review loan documents.', messages: [{ role: 'user', content }],
      output_config: { format }, temperature: 0, top_p: 0.9, top_k: 40, stop_sequences: ['END'],
    })
    expect(out.parsed).toEqual({ verdict: 'eligible' })
    expect(out.original_messages).toEqual([content])
  })

  it('an answer cut short at max_tokens is truncated, reported apart from a finished one, and applied', async () => {
    const f = fakeAnthropic()
    f.respond(message(['A lender pi'], 'max_tokens'))
    const failed = await failure(CHAT.run(f.ctx, ARGS))
    expect([failed.code, failed.outcome]).toEqual(['anthropic_answer_truncated', 'applied'])
  })

  it('a refusal, a full context window and an answer that did not finish are each named, and applied', async () => {
    const cases: Array<[Response, string]> = [
      [message([], 'refusal'), 'anthropic_refused'],
      [message(['x'], 'model_context_window_exceeded'), 'anthropic_context_window_exceeded'],
      [message(['x'], 'pause_turn'), 'anthropic_answer_unfinished'],
      [message(['x'], 'tool_use'), 'anthropic_answer_unfinished'],
      [message(['x'], null), 'anthropic_answer_unfinished'],
    ]
    for (const [answer, code] of cases) {
      const f = fakeAnthropic()
      f.respond(answer)
      const failed = await failure(CHAT.run(f.ctx, ARGS))
      expect([failed.code, failed.outcome], code).toEqual([code, 'applied'])
    }
  })

  it('a stop sequence is a finished answer', async () => {
    const f = fakeAnthropic()
    f.respond(message(['done'], 'stop_sequence', { stop_sequence: 'END' }))
    expect(((await CHAT.run(f.ctx, { ...ARGS, stop_sequences: ['END'] })) as Record<string, unknown>).text).toBe('done')
  })

  it('a JSON format whose text is not JSON fails by name as applied, since it was billed', async () => {
    const f = fakeAnthropic()
    f.respond(message(['eligible']))
    const failed = await failure(CHAT.run(f.ctx, { ...ARGS, output_format: { type: 'json_schema', schema: { type: 'object' } } }))
    expect([failed.code, failed.outcome]).toEqual(['anthropic_answer_not_json', 'applied'])
  })

  it('an expired or revoked key: what the connection bound fetch throws passes through unchanged, and nothing more is sent', async () => {
    const expired = new Error('needs_reauth: request_refused_after_renew')
    const f = fakeAnthropic()
    f.respond({ throws: expired })
    await expect(CHAT.run(f.ctx, ARGS)).rejects.toBe(expired)
    expect(f.sent).toHaveLength(1)
  })

  it('a 429 with Retry-After: the requeue passes through unchanged, and nothing waits in the request', async () => {
    const requeue = { kind: 'requeue_at', notBefore: new Date('2026-10-22T15:00:20Z') }
    const f = fakeAnthropic()
    f.respond({ throws: requeue })
    await expect(CHAT.run(f.ctx, ARGS)).rejects.toBe(requeue)
    expect(f.sent).toHaveLength(1)
  })

  it('a timeout after send passes through unchanged, for the executor to record as outcome unknown and never retry', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError')
    const f = fakeAnthropic()
    f.respond({ throws: timeout })
    await expect(CHAT.run(f.ctx, ARGS)).rejects.toBe(timeout)
    expect(f.sent).toHaveLength(1)
    expect(CHAT.idempotent).toBe(false)
  })

  it('a server error may have run the model, so its outcome is unknown; an overloaded refusal ran nothing', async () => {
    const f = fakeAnthropic()
    f.respond(anthropicError(500, 'api_error'))
    const failed = await failure(CHAT.run(f.ctx, ARGS))
    expect([failed.code, failed.outcome]).toEqual(['anthropic_api_error', 'unknown'])
    const g = fakeAnthropic()
    g.respond(anthropicError(529, 'overloaded_error'))
    const overloaded = await failure(CHAT.run(g.ctx, ARGS))
    expect([overloaded.code, overloaded.outcome]).toEqual(['anthropic_overloaded_error', 'not_applied'])
    const h = fakeAnthropic()
    h.respond(new Response('<html>bad gateway</html>', { status: 502 }))
    expect((await failure(CHAT.run(h.ctx, ARGS))).code).toBe('anthropic_http_502')
  })

  it('a 200 it cannot read may have run the model, so its outcome is unknown', async () => {
    const f = fakeAnthropic()
    f.respond(new Response('<html>edge page</html>', { status: 200 }))
    const failed = await failure(CHAT.run(f.ctx, ARGS))
    expect([failed.code, failed.outcome]).toEqual(['anthropic_answer_unreadable', 'unknown'])
  })

  it("a refused request fails by Anthropic's own error type, as not applied, never quoting Anthropic's message", async () => {
    const cases: Array<[Response, string]> = [
      [anthropicError(400, 'invalid_request_error', 'prompt about Sam Lee is too long'), 'anthropic_invalid_request_error'],
      [anthropicError(403, 'permission_error'), 'anthropic_permission_error'],
      [anthropicError(404, 'not_found_error'), 'anthropic_not_found_error'],
      [anthropicError(413, 'request_too_large'), 'anthropic_request_too_large'],
      [new Response('Forbidden', { status: 403 }), 'anthropic_http_403'],
    ]
    for (const [answer, code] of cases) {
      const f = fakeAnthropic()
      f.respond(answer)
      const failed = await failure(CHAT.run(f.ctx, ARGS))
      expect([failed.code, failed.outcome], code).toEqual([code, 'not_applied'])
      expect(failed.message).not.toContain('Sam Lee')
    }
  })

  it('a 429 reaching the action is not applied and names the wait', async () => {
    const f = fakeAnthropic()
    f.respond(anthropicError(429, 'rate_limit_error', 'slow down', { 'retry-after': '20' }))
    const limited = await failure(CHAT.run(f.ctx, ARGS))
    expect([limited.code, limited.outcome]).toEqual(['anthropic_rate_limit_error', 'not_applied'])
    expect(limited.message).toContain('20')
  })

  it('an answer with no content list is unreadable, and its outcome unknown', async () => {
    const f = fakeAnthropic()
    f.respond(anthropicAnswer({ id: 'msg_0PS', type: 'message', stop_reason: 'end_turn' }))
    const failed = await failure(CHAT.run(f.ctx, ARGS))
    expect([failed.code, failed.outcome]).toEqual(['anthropic_answer_unreadable', 'unknown'])
  })

  it('refuses a step it cannot send before anything is sent', async () => {
    const cases: Array<[ActionArgs, string]> = [
      [{ user_message: 'x', max_tokens: 10 }, 'anthropic_model_missing'],
      [{ model: 'claude-opus-5', max_tokens: 10 }, 'anthropic_messages_missing'],
      [{ model: 'claude-opus-5', max_tokens: 10, messages: [] }, 'anthropic_messages_missing'],
      [{ model: 'claude-opus-5', user_message: 'x' }, 'anthropic_max_tokens_missing'],
      [{ model: 'claude-opus-5', user_message: 'x', max_tokens: 0 }, 'anthropic_argument_invalid'],
      [{ model: 'claude-opus-5', user_message: 'x', max_tokens: 1.5 }, 'anthropic_argument_invalid'],
      [{ model: 'claude-opus-5', user_message: 'x', max_tokens: 10, messages: 'hi' }, 'anthropic_argument_invalid'],
      [{ model: 'claude-opus-5', user_message: 'x', max_tokens: 10, messages: ['hi', { role: 'assistant', content: 'mixed' }] }, 'anthropic_argument_invalid'],
      [{ model: 'claude-opus-5', max_tokens: 10, messages: [{ content: 'no role' }] }, 'anthropic_argument_invalid'],
      [{ model: 'claude-opus-5', user_message: 'x', max_tokens: 10, temperature: 'warm' }, 'anthropic_argument_invalid'],
      [{ model: 'claude-opus-5', user_message: 'x', max_tokens: 10, top_k: 2.5 }, 'anthropic_argument_invalid'],
      [{ model: 'claude-opus-5', user_message: 'x', max_tokens: 10, stop_sequences: 'END' }, 'anthropic_argument_invalid'],
      [{ model: 'claude-opus-5', user_message: 'x', max_tokens: 10, output_format: { schema: {} } }, 'anthropic_argument_invalid'],
    ]
    for (const [args, code] of cases) {
      const f = fakeAnthropic()
      const refused = await failure(CHAT.run(f.ctx, args))
      expect([refused.code, refused.outcome], JSON.stringify(args)).toEqual([code, 'not_applied'])
      expect(f.sent).toEqual([])
    }
  })
})
