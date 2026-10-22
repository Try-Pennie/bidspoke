import { describe, expect, it } from 'vitest'
import { catalogueActions, CATALOGUE } from '../../../schema'
import { resolveRuntimeAction } from '../..'
import { ActionFailure } from '../../failure'
import type { ActionArgs, RuntimeAction } from '../../types'
import { completion, fakeOpenAI, openaiAnswer, openaiError, responseOf } from './fake-openai'

/**
 * The OpenAI actions the Pipedream workflows use (#2337; counted in the export
 * of 2026-09-30, the duplicate project folder left out, steps inside if/else
 * branches counted). Every one has the fixtures each service PR carries: an
 * expired or revoked key, a 429 with Retry-After, a timeout after send, a
 * server error, and, for the two model calls, an answer cut short at its token
 * limit, which is reported apart from a finished one.
 */

function action(key: string): RuntimeAction {
  const resolved = resolveRuntimeAction(key, 1)
  if (!resolved.ok) throw new Error(resolved.message)
  return resolved.action
}

const CHAT = action('openai.chat')
const RESPOND = action('openai.create-response')
const CREATE_CONVERSATION = action('openai.create-conversation')
const ADD_ITEMS = action('openai.add-conversation-items')
const LIST_ITEMS = action('openai.list-conversation-items')
const GET_CONVERSATION = action('openai.get-conversation')

async function failure(promise: Promise<unknown>): Promise<ActionFailure> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ActionFailure)
    return err as ActionFailure
  }
  throw new Error('expected an ActionFailure')
}

const CONVERSATION = 'conv_0PS2337'
const conversation = (over: Record<string, unknown> = {}) =>
  openaiAnswer({ id: CONVERSATION, object: 'conversation', created_at: 1761140000, metadata: { topic: 'marcia' }, ...over })
const itemList = (data: unknown[], hasMore = false) =>
  openaiAnswer({ object: 'list', data, first_id: 'msg_1', last_id: 'msg_2', has_more: hasMore })
const ITEM = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi Sam' }] }

/** Each action with arguments it accepts and an answer OpenAI gives them, for the fixtures every action shares. */
const CASES: ReadonlyArray<{ action: RuntimeAction; args: ActionArgs; ok: () => Response; method: string; url: string }> = [
  { action: CHAT, args: { model: 'gpt-4o-mini', user_message: 'Is 3pm good?' }, ok: () => completion('Yes'), method: 'POST', url: 'https://api.openai.com/v1/chat/completions' },
  { action: RESPOND, args: { model: 'gpt-4o-mini', input: 'Is 3pm good?' }, ok: () => responseOf('Yes'), method: 'POST', url: 'https://api.openai.com/v1/responses' },
  { action: CREATE_CONVERSATION, args: {}, ok: () => conversation(), method: 'POST', url: 'https://api.openai.com/v1/conversations' },
  { action: ADD_ITEMS, args: { conversation_id: CONVERSATION, items: [ITEM] }, ok: () => itemList([ITEM]), method: 'POST', url: `https://api.openai.com/v1/conversations/${CONVERSATION}/items` },
  { action: LIST_ITEMS, args: { conversation_id: CONVERSATION }, ok: () => itemList([ITEM]), method: 'GET', url: `https://api.openai.com/v1/conversations/${CONVERSATION}/items?limit=20` },
  { action: GET_CONVERSATION, args: { conversation_id: CONVERSATION }, ok: () => conversation(), method: 'GET', url: `https://api.openai.com/v1/conversations/${CONVERSATION}` },
]

describe('the OpenAI actions decide their own traits', () => {
  it('are the six the workflows use, and nothing more', () => {
    expect(catalogueActions(CATALOGUE).map((a) => `${a.key}@${a.version}`).filter((id) => id.startsWith('openai.'))).toEqual([
      'openai.chat@1', 'openai.create-response@1', 'openai.create-conversation@1', 'openai.add-conversation-items@1',
      'openai.list-conversation-items@1', 'openai.get-conversation@1',
    ])
  })

  it('a model call is side effecting and never repeated: it is billed, and a second call is a different answer', () => {
    for (const a of [CHAT, RESPOND]) {
      expect([a.key, a.sideEffect, a.idempotent]).toEqual([a.key, true, false])
      expect(a.idempotentBecause).toMatch(/billed/)
    }
    expect(RESPOND.idempotentBecause).toMatch(/conversation/)
  })

  it('a conversation write is side effecting and not idempotent, since OpenAI takes no key to deduplicate on', () => {
    for (const a of [CREATE_CONVERSATION, ADD_ITEMS]) {
      expect([a.key, a.sideEffect, a.idempotent]).toEqual([a.key, true, false])
      expect(a.idempotentBecause).toMatch(/twice/)
    }
  })

  it('a conversation read changes nothing, so it is safe to repeat', () => {
    for (const a of [LIST_ITEMS, GET_CONVERSATION]) {
      expect([a.key, a.sideEffect, a.idempotent]).toEqual([a.key, false, true])
    }
  })

  it('takes the arguments the steps use, by the names OpenAI gives them', () => {
    const shape = (a: RuntimeAction) => Object.fromEntries(a.arguments.map((x) => [x.key, [x.required, x.parseJson]]))
    expect(shape(CHAT)).toEqual({
      model: [true, false], user_message: [false, false], system_instructions: [false, false], messages: [false, true],
      response_format: [false, true], max_tokens: [false, true], temperature: [false, true], top_p: [false, true],
      stop: [false, true], presence_penalty: [false, true], frequency_penalty: [false, true], user: [false, false],
    })
    expect(shape(RESPOND)).toEqual({
      model: [true, false], input: [false, false], input_items: [false, true], instructions: [false, false],
      conversation: [false, false], previous_response_id: [false, false], text_format: [false, true], tools: [false, true],
      store: [false, true], temperature: [false, true], max_output_tokens: [false, true], metadata: [false, true],
      truncation: [false, false], include: [false, true], reasoning: [false, true],
    })
    expect(shape(CREATE_CONVERSATION)).toEqual({ metadata: [false, true], items: [false, true] })
    expect(shape(ADD_ITEMS)).toEqual({ conversation_id: [true, false], items: [true, true] })
    expect(shape(LIST_ITEMS)).toEqual({ conversation_id: [true, false], limit: [false, true], order: [false, false], after: [false, false] })
    expect(shape(GET_CONVERSATION)).toEqual({ conversation_id: [true, false] })
    for (const a of [CHAT, RESPOND, CREATE_CONVERSATION, ADD_ITEMS, LIST_ITEMS, GET_CONVERSATION]) {
      for (const x of a.arguments) expect([a.key, x.key, x.type, x.allowsVariables]).toEqual([a.key, x.key, 'text', true])
    }
  })
})

describe('every OpenAI action', () => {
  for (const c of CASES) {
    describe(c.action.key, () => {
      it('sends one request to api.openai.com through the connection bound fetch, with no key of its own', async () => {
        const f = fakeOpenAI()
        f.respond(c.ok())
        await c.action.run(f.ctx, c.args)
        expect(f.sent.map((s) => [s.method, s.url])).toEqual([[c.method, c.url]])
        // connectionFetch puts the key and the project on the request: the action never holds either.
        expect(f.sent[0].headers.get('authorization')).toBeNull()
        expect(f.sent[0].headers.get('openai-project')).toBeNull()
        expect(f.sent[0].headers.get('content-type')).toBe(c.method === 'POST' ? 'application/json' : null)
      })

      it('an expired or revoked key: what the connection bound fetch throws passes through unchanged, and nothing more is sent', async () => {
        const expired = new Error('needs_reauth: request_refused_after_renew')
        const f = fakeOpenAI()
        f.respond({ throws: expired })
        await expect(c.action.run(f.ctx, c.args)).rejects.toBe(expired)
        expect(f.sent).toHaveLength(1)
      })

      it('a 429 with Retry-After: the requeue passes through unchanged, and nothing waits in the request', async () => {
        const requeue = { kind: 'requeue_at', notBefore: new Date('2026-10-22T15:00:20Z') }
        const f = fakeOpenAI()
        f.respond({ throws: requeue })
        await expect(c.action.run(f.ctx, c.args)).rejects.toBe(requeue)
        expect(f.sent).toHaveLength(1)
      })

      it('a timeout after send passes through unchanged, for the executor to record as outcome unknown', async () => {
        const timeout = new DOMException('The operation timed out.', 'TimeoutError')
        const f = fakeOpenAI()
        f.respond({ throws: timeout })
        await expect(c.action.run(f.ctx, c.args)).rejects.toBe(timeout)
        expect(f.sent).toHaveLength(1)
      })

      it('a server error: a write may have been applied, so its outcome is unknown; a read applied nothing', async () => {
        const f = fakeOpenAI()
        f.respond(openaiError(500, 'server_error', null))
        const failed = await failure(c.action.run(f.ctx, c.args))
        expect([failed.code, failed.outcome]).toEqual(['openai_http_500', c.action.sideEffect ? 'unknown' : 'not_applied'])
      })

      it('a 200 it cannot read: a write may have been applied, so its outcome is unknown', async () => {
        const f = fakeOpenAI()
        f.respond(new Response('<html>edge page</html>', { status: 200 }))
        const failed = await failure(c.action.run(f.ctx, c.args))
        expect([failed.code, failed.outcome]).toEqual(['openai_answer_unreadable', c.action.sideEffect ? 'unknown' : 'not_applied'])
      })

      it("a refused request fails by OpenAI's own error code, as not applied, never quoting OpenAI's message", async () => {
        const f = fakeOpenAI()
        f.respond(openaiError(400, 'invalid_request_error', 'context_length_exceeded', 'This text names Sam Lee'))
        const failed = await failure(c.action.run(f.ctx, c.args))
        expect([failed.code, failed.outcome]).toEqual(['openai_context_length_exceeded', 'not_applied'])
        expect(failed.message).toContain('invalid_request_error')
        expect(failed.message).not.toContain('Sam Lee')
      })
    })
  }

  it('a refusal naming only its type fails by that type, and one naming neither by its status, never a null', async () => {
    const f = fakeOpenAI()
    f.respond(openaiError(403, 'permission_error', null))
    expect((await failure(CHAT.run(f.ctx, CASES[0].args))).code).toBe('openai_permission_error')
    const g = fakeOpenAI()
    g.respond(new Response('Forbidden', { status: 403 }))
    expect((await failure(CHAT.run(g.ctx, CASES[0].args))).code).toBe('openai_http_403')
  })

  it('a 404 is not_found, whatever OpenAI calls it', async () => {
    const f = fakeOpenAI()
    f.respond(openaiError(404, 'invalid_request_error', null, `Conversation ${CONVERSATION} not found`))
    const failed = await failure(GET_CONVERSATION.run(f.ctx, { conversation_id: CONVERSATION }))
    expect([failed.code, failed.outcome]).toEqual(['openai_not_found', 'not_applied'])
  })

  it('a 429 reaching the action is not applied and names the wait; an exhausted quota is named apart, since waiting will not clear it', async () => {
    const f = fakeOpenAI()
    f.respond(openaiError(429, 'requests', 'rate_limit_exceeded', 'slow down', { 'Retry-After': '20' }))
    const limited = await failure(CHAT.run(f.ctx, CASES[0].args))
    expect([limited.code, limited.outcome]).toEqual(['openai_rate_limited', 'not_applied'])
    expect(limited.message).toContain('20')
    const g = fakeOpenAI()
    g.respond(openaiError(429, 'insufficient_quota', 'insufficient_quota'))
    const quota = await failure(CHAT.run(g.ctx, CASES[0].args))
    expect([quota.code, quota.outcome]).toEqual(['openai_insufficient_quota', 'not_applied'])
  })
})

describe('openai.chat@1', () => {
  it('sends the model, the system instructions and the user message, and returns the answer with the messages as Pipedream did', async () => {
    const f = fakeOpenAI()
    f.respond(completion('Yes, 3pm works.'))
    const out = (await CHAT.run(f.ctx, { model: 'gpt-4o-mini', system_instructions: 'Answer briefly.', user_message: 'Is 3pm good?', temperature: 0.2, max_tokens: 50 })) as Record<string, unknown>
    expect(f.sent[0].body).toEqual({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: 'Answer briefly.' }, { role: 'user', content: 'Is 3pm good?' }],
      temperature: 0.2,
      max_completion_tokens: 50,
    })
    expect(out.content).toBe('Yes, 3pm works.')
    expect(out.finish_reason).toBe('stop')
    expect(out.id).toBe('chatcmpl-0PS')
    expect(out.usage).toEqual({ prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 })
    expect(out.original_messages).toEqual(f.sent[0].body?.messages)
    expect(out.original_messages_with_assistant_response).toEqual([...(f.sent[0].body?.messages as unknown[]), { role: 'assistant', content: 'Yes, 3pm works.', refusal: null }])
  })

  it('takes a whole message list, as the code steps send it, and appends the user message when one is given', async () => {
    const messages = [{ role: 'system', content: 'Classify.' }, { role: 'user', content: 'Call me at 3' }]
    const f = fakeOpenAI()
    f.respond(completion('reschedule'))
    await CHAT.run(f.ctx, { model: 'gpt-4o-mini', messages })
    expect(f.sent[0].body?.messages).toEqual(messages)
    const g = fakeOpenAI()
    g.respond(completion('ok'))
    await CHAT.run(g.ctx, { model: 'gpt-4o-mini', messages, user_message: 'And tomorrow?' })
    expect(g.sent[0].body?.messages).toEqual([...messages, { role: 'user', content: 'And tomorrow?' }])
  })

  it('sends every optional setting Pipedream offered, by the names OpenAI takes', async () => {
    const f = fakeOpenAI()
    f.respond(completion('{"ok":true}'))
    await CHAT.run(f.ctx, {
      model: 'gpt-4o-mini', user_message: 'x', top_p: 0.9, stop: ['\n'], presence_penalty: 0.5, frequency_penalty: -0.5, user: 'lead-42',
      response_format: { type: 'json_object' },
    })
    expect(f.sent[0].body).toEqual({
      model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }], top_p: 0.9, stop: ['\n'], presence_penalty: 0.5, frequency_penalty: -0.5,
      user: 'lead-42', response_format: { type: 'json_object' },
    })
  })

  it('parses the answer of a JSON format, and an answer that is not JSON fails by name as applied, since it was billed', async () => {
    const schema = { type: 'json_schema', json_schema: { name: 'slot', schema: { type: 'object' }, strict: true } }
    const f = fakeOpenAI()
    f.respond(completion('{"slot":"15:00"}'))
    const out = (await CHAT.run(f.ctx, { model: 'gpt-4o-mini', user_message: 'x', response_format: schema })) as Record<string, unknown>
    expect(out.parsed).toEqual({ slot: '15:00' })
    const g = fakeOpenAI()
    g.respond(completion('15:00'))
    const failed = await failure(CHAT.run(g.ctx, { model: 'gpt-4o-mini', user_message: 'x', response_format: schema }))
    expect([failed.code, failed.outcome]).toEqual(['openai_answer_not_json', 'applied'])
  })

  it('an answer cut short at its token limit is truncated, reported apart from a finished one, and applied', async () => {
    const f = fakeOpenAI()
    f.respond(completion('Yes, 3pm wo', 'length'))
    const failed = await failure(CHAT.run(f.ctx, { model: 'gpt-4o-mini', user_message: 'x', max_tokens: 3 }))
    expect([failed.code, failed.outcome]).toEqual(['openai_answer_truncated', 'applied'])
  })

  it('a filtered answer, a refusal and an answer that did not finish are each named, and applied', async () => {
    const cases: Array<[Response, string]> = [
      [completion(null, 'content_filter'), 'openai_answer_filtered'],
      [completion(null, 'stop', { refusal: 'I cannot help with that.' }), 'openai_refused'],
      [completion('x', 'tool_calls'), 'openai_answer_unfinished'],
      [completion('x', null), 'openai_answer_unfinished'],
      [openaiAnswer({ id: 'chatcmpl-0PS', choices: [] }), 'openai_answer_unfinished'],
    ]
    for (const [answer, code] of cases) {
      const f = fakeOpenAI()
      f.respond(answer)
      const failed = await failure(CHAT.run(f.ctx, { model: 'gpt-4o-mini', user_message: 'x' }))
      expect([failed.code, failed.outcome], code).toEqual([code, 'applied'])
    }
  })

  it('refuses a step it cannot send before anything is sent', async () => {
    const cases: Array<[ActionArgs, string]> = [
      [{ user_message: 'x' }, 'openai_model_missing'],
      [{ model: ' ', user_message: 'x' }, 'openai_model_missing'],
      [{ model: 'gpt-4o-mini' }, 'openai_messages_missing'],
      [{ model: 'gpt-4o-mini', messages: [] }, 'openai_messages_missing'],
      [{ model: 'gpt-4o-mini', messages: 'hi' }, 'openai_argument_invalid'],
      [{ model: 'gpt-4o-mini', messages: [{ content: 'no role' }] }, 'openai_argument_invalid'],
      [{ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }], system_instructions: 'y' }, 'openai_argument_invalid'],
      [{ model: 'gpt-4o-mini', user_message: 'x', temperature: 'warm' }, 'openai_argument_invalid'],
      [{ model: 'gpt-4o-mini', user_message: 'x', max_tokens: 0 }, 'openai_argument_invalid'],
      [{ model: 'gpt-4o-mini', user_message: 'x', max_tokens: 2.5 }, 'openai_argument_invalid'],
      [{ model: 'gpt-4o-mini', user_message: 'x', stop: [1] }, 'openai_argument_invalid'],
      [{ model: 'gpt-4o-mini', user_message: 'x', response_format: 'json' }, 'openai_argument_invalid'],
      [{ model: 'gpt-4o-mini', user_message: 'x', user: 7 }, 'openai_argument_invalid'],
    ]
    for (const [args, code] of cases) {
      const f = fakeOpenAI()
      const refused = await failure(CHAT.run(f.ctx, args))
      expect([refused.code, refused.outcome], JSON.stringify(args)).toEqual([code, 'not_applied'])
      expect(f.sent).toEqual([])
    }
  })
})

describe('openai.create-response@1', () => {
  it('sends a turn into a conversation with a JSON schema format, and returns the text and its parse', async () => {
    const f = fakeOpenAI()
    f.respond(responseOf('{"reply":"See you at 3"}'))
    const textFormat = { type: 'json_schema', name: 'marcia', schema: { type: 'object' }, strict: true }
    const out = (await RESPOND.run(f.ctx, {
      model: 'gpt-4o-mini', conversation: CONVERSATION, instructions: 'Be brief.',
      input_items: [{ role: 'user', content: [{ type: 'input_text', text: 'Can we talk at 3?' }] }],
      text_format: textFormat, store: true,
    })) as Record<string, unknown>
    expect(f.sent[0].body).toEqual({
      model: 'gpt-4o-mini', conversation: CONVERSATION, instructions: 'Be brief.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Can we talk at 3?' }] }],
      text: { format: textFormat }, store: true,
    })
    expect(out.output_text).toBe('{"reply":"See you at 3"}')
    expect(out.parsed).toEqual({ reply: 'See you at 3' })
    expect(out.id).toBe('resp_0PS')
    expect(out.status).toBe('completed')
  })

  it('sends a plain text input and every other setting by the names OpenAI takes, never streaming or in the background', async () => {
    const f = fakeOpenAI()
    f.respond(responseOf('ok'))
    const tools = [{ type: 'file_search', vector_store_ids: ['vs_0PS'] }]
    await RESPOND.run(f.ctx, {
      model: 'gpt-4o-mini', input: 'What does the policy say?', previous_response_id: 'resp_prev', tools, temperature: 0.1,
      max_output_tokens: 400, metadata: { lead: '42' }, truncation: 'auto', include: ['file_search_call.results'], reasoning: { effort: 'low' },
    })
    expect(f.sent[0].body).toEqual({
      model: 'gpt-4o-mini', input: 'What does the policy say?', previous_response_id: 'resp_prev', tools, temperature: 0.1,
      max_output_tokens: 400, metadata: { lead: '42' }, truncation: 'auto', include: ['file_search_call.results'], reasoning: { effort: 'low' },
    })
    expect(f.sent[0].body).not.toHaveProperty('stream')
    expect(f.sent[0].body).not.toHaveProperty('background')
  })

  it('joins the text of every output message, and a response with no message (a tool call) has empty text', async () => {
    const f = fakeOpenAI()
    f.respond(openaiAnswer({
      id: 'resp_0PS', status: 'completed', output: [
        { type: 'file_search_call', id: 'fs_1', status: 'completed' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'One. ' }, { type: 'output_text', text: 'Two.' }] },
      ],
    }))
    expect(((await RESPOND.run(f.ctx, { model: 'gpt-4o-mini', input: 'x' })) as Record<string, unknown>).output_text).toBe('One. Two.')
    const g = fakeOpenAI()
    g.respond(openaiAnswer({ id: 'resp_0PS', status: 'completed', output: [{ type: 'function_call', name: 'book', arguments: '{}' }] }))
    expect(((await RESPOND.run(g.ctx, { model: 'gpt-4o-mini', input: 'x' })) as Record<string, unknown>).output_text).toBe('')
  })

  it('an answer cut short at max_output_tokens is truncated, reported apart from a completed one, and applied', async () => {
    const f = fakeOpenAI()
    f.respond(responseOf('{"reply":"See y', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }))
    const failed = await failure(RESPOND.run(f.ctx, { model: 'gpt-4o-mini', input: 'x', max_output_tokens: 5 }))
    expect([failed.code, failed.outcome]).toEqual(['openai_answer_truncated', 'applied'])
  })

  it('a filtered, an otherwise incomplete, a refused, a failed and an unfinished response are each named', async () => {
    const cases: Array<[Response, string, string]> = [
      [responseOf('', { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }), 'openai_answer_filtered', 'applied'],
      [responseOf('', { status: 'incomplete', incomplete_details: null }), 'openai_answer_incomplete', 'applied'],
      [responseOf('', {}, { type: 'refusal', refusal: 'I cannot help with that.' }), 'openai_refused', 'applied'],
      [responseOf('', { status: 'failed', error: { code: 'server_error', message: 'x' } }), 'openai_response_failed', 'unknown'],
      [responseOf('', { status: 'in_progress' }), 'openai_response_unfinished', 'unknown'],
      [openaiAnswer({ id: 'resp_0PS' }), 'openai_response_unfinished', 'unknown'],
    ]
    for (const [answer, code, outcome] of cases) {
      const f = fakeOpenAI()
      f.respond(answer)
      const failed = await failure(RESPOND.run(f.ctx, { model: 'gpt-4o-mini', input: 'x' }))
      expect([failed.code, failed.outcome], code).toEqual([code, outcome])
    }
  })

  it('a JSON format whose text is not JSON fails by name as applied', async () => {
    const f = fakeOpenAI()
    f.respond(responseOf('See you at 3'))
    const failed = await failure(RESPOND.run(f.ctx, { model: 'gpt-4o-mini', input: 'x', text_format: { type: 'json_object' } }))
    expect([failed.code, failed.outcome]).toEqual(['openai_answer_not_json', 'applied'])
  })

  it('refuses a step it cannot send before anything is sent', async () => {
    const cases: Array<[ActionArgs, string]> = [
      [{ input: 'x' }, 'openai_model_missing'],
      [{ model: 'gpt-4o-mini' }, 'openai_input_missing'],
      [{ model: 'gpt-4o-mini', input: 'x', input_items: [] }, 'openai_argument_invalid'],
      [{ model: 'gpt-4o-mini', input_items: 'x' }, 'openai_argument_invalid'],
      [{ model: 'gpt-4o-mini', input: 'x', text_format: 'json' }, 'openai_argument_invalid'],
      [{ model: 'gpt-4o-mini', input: 'x', tools: { type: 'file_search' } }, 'openai_argument_invalid'],
      [{ model: 'gpt-4o-mini', input: 'x', store: 'yes' }, 'openai_argument_invalid'],
      [{ model: 'gpt-4o-mini', input: 'x', metadata: { lead: 42 } }, 'openai_argument_invalid'],
      [{ model: 'gpt-4o-mini', input: 'x', truncation: 'sometimes' }, 'openai_argument_invalid'],
      [{ model: 'gpt-4o-mini', input: 'x', include: 'all' }, 'openai_argument_invalid'],
      [{ model: 'gpt-4o-mini', input: 'x', max_output_tokens: -1 }, 'openai_argument_invalid'],
    ]
    for (const [args, code] of cases) {
      const f = fakeOpenAI()
      const refused = await failure(RESPOND.run(f.ctx, args))
      expect([refused.code, refused.outcome], JSON.stringify(args)).toEqual([code, 'not_applied'])
      expect(f.sent).toEqual([])
    }
  })
})

describe('the conversation actions', () => {
  it('create-conversation sends its metadata and opening items, and returns the conversation', async () => {
    const f = fakeOpenAI()
    f.respond(conversation())
    const out = await CREATE_CONVERSATION.run(f.ctx, { metadata: { external_id: '42', topic: 'marcia' }, items: [ITEM] })
    expect(f.sent[0].body).toEqual({ metadata: { external_id: '42', topic: 'marcia' }, items: [ITEM] })
    expect(out).toEqual({ id: CONVERSATION, object: 'conversation', created_at: 1761140000, metadata: { topic: 'marcia' } })
    const g = fakeOpenAI()
    g.respond(conversation())
    await CREATE_CONVERSATION.run(g.ctx, {})
    expect(g.sent[0].body).toEqual({})
  })

  it('an answer that names no conversation id was applied, so it is never repeated', async () => {
    const f = fakeOpenAI()
    f.respond(openaiAnswer({ object: 'conversation' }))
    const failed = await failure(CREATE_CONVERSATION.run(f.ctx, {}))
    expect([failed.code, failed.outcome]).toEqual(['openai_answer_incomplete', 'applied'])
  })

  it('add-conversation-items sends up to 20 items in one request, which OpenAI applies whole, and refuses more rather than split them', async () => {
    const f = fakeOpenAI()
    f.respond(itemList([ITEM]))
    const out = (await ADD_ITEMS.run(f.ctx, { conversation_id: CONVERSATION, items: Array(20).fill(ITEM) })) as Record<string, unknown>
    expect((f.sent[0].body?.items as unknown[]).length).toBe(20)
    expect(out.data).toEqual([ITEM])
    const g = fakeOpenAI()
    // A partial batch cannot happen: more than one request's worth is refused before anything is sent.
    const refused = await failure(ADD_ITEMS.run(g.ctx, { conversation_id: CONVERSATION, items: Array(21).fill(ITEM) }))
    expect([refused.code, refused.outcome]).toEqual(['openai_too_many_items', 'not_applied'])
    expect(g.sent).toEqual([])
  })

  it('list-conversation-items reads one page, as asked, and says whether there is more', async () => {
    const f = fakeOpenAI()
    f.respond(itemList([ITEM, ITEM], true))
    const out = await LIST_ITEMS.run(f.ctx, { conversation_id: CONVERSATION, limit: 2, order: 'asc', after: 'msg_0' })
    expect(f.sent[0].url).toBe(`https://api.openai.com/v1/conversations/${CONVERSATION}/items?limit=2&order=asc&after=msg_0`)
    expect(out).toEqual({ data: [ITEM, ITEM], has_more: true, first_id: 'msg_1', last_id: 'msg_2' })
  })

  it('a list answer with no data array is unreadable by name', async () => {
    const f = fakeOpenAI()
    f.respond(openaiAnswer({ object: 'list' }))
    const failed = await failure(LIST_ITEMS.run(f.ctx, { conversation_id: CONVERSATION }))
    expect([failed.code, failed.outcome]).toEqual(['openai_answer_unreadable', 'not_applied'])
  })

  it('get-conversation returns the conversation', async () => {
    const f = fakeOpenAI()
    f.respond(conversation())
    expect(await GET_CONVERSATION.run(f.ctx, { conversation_id: CONVERSATION })).toEqual({ id: CONVERSATION, object: 'conversation', created_at: 1761140000, metadata: { topic: 'marcia' } })
  })

  it('refuses a step it cannot send before anything is sent, a conversation id that would leave its path included', async () => {
    const cases: Array<[RuntimeAction, ActionArgs, string]> = [
      [CREATE_CONVERSATION, { metadata: { n: 1 } }, 'openai_argument_invalid'],
      [CREATE_CONVERSATION, { metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])) }, 'openai_argument_invalid'],
      [CREATE_CONVERSATION, { items: Array(21).fill(ITEM) }, 'openai_too_many_items'],
      [CREATE_CONVERSATION, { items: 'x' }, 'openai_argument_invalid'],
      [ADD_ITEMS, { items: [ITEM] }, 'openai_conversation_missing'],
      [ADD_ITEMS, { conversation_id: '../responses', items: [ITEM] }, 'openai_argument_invalid'],
      [ADD_ITEMS, { conversation_id: CONVERSATION, items: [] }, 'openai_argument_invalid'],
      [ADD_ITEMS, { conversation_id: CONVERSATION }, 'openai_argument_invalid'],
      [LIST_ITEMS, { conversation_id: 'conv_1?limit=100' }, 'openai_argument_invalid'],
      [LIST_ITEMS, { conversation_id: CONVERSATION, limit: 101 }, 'openai_argument_invalid'],
      [LIST_ITEMS, { conversation_id: CONVERSATION, order: 'newest' }, 'openai_argument_invalid'],
      [GET_CONVERSATION, {}, 'openai_conversation_missing'],
      [GET_CONVERSATION, { conversation_id: 'conv/1' }, 'openai_argument_invalid'],
    ]
    for (const [a, args, code] of cases) {
      const f = fakeOpenAI()
      const refused = await failure(a.run(f.ctx, args))
      expect([a.key, refused.code, refused.outcome], JSON.stringify(args)).toEqual([a.key, code, 'not_applied'])
      expect(f.sent).toEqual([])
    }
  })
})
