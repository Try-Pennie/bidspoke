import type { ActionArgument, ActionSchema, ServiceSchema } from '../types'

/**
 * OpenAI (#2337, phase 7 of #1689): an API key for one OpenAI project.
 *
 * WHAT THE PIPEDREAM WORKFLOWS USE, counted in the export of 2026-09-30 (the
 * duplicate project folder left out; steps inside an if/else branch counted).
 * Registry steps, 28:
 *   openai-chat-with-assistant      14 (1 disabled)  Assistants API
 *   openai-create-thread            12 (2 disabled)  Assistants API
 *   openai-chat                      1               chat completions
 *   openai-chat-using-file-search    1               Responses API, file_search
 * Code steps reaching api.openai.com, 37, all enabled (the key from
 * process.env, or the SDK), by what they call (a step may call several):
 *   POST /v1/responses                24 steps, 29 calls (1 step by the SDK)
 *   POST /v1/chat/completions         12 steps
 *   POST /v1/conversations            13 steps, 18 calls
 *   GET  /v1/conversations/{id}/items  3 steps
 *   GET  /v1/conversations/{id}        2 steps
 *   POST /v1/conversations/{id}/items  1 step (a migration, batched by 20)
 *   /v1/threads/...                   11 steps, 16 calls, Assistants API
 * The Assistants API (threads, runs, assistants) was shut down by OpenAI on
 * 2026-08-26 (its deprecations page: replaced by the Responses and
 * Conversations APIs), so none of its 26 registry steps or its thread calls is
 * built here: those steps already fail, and the workflows' newer versions
 * moved to conversations. What is built covers every other call: the two model
 * calls and the four conversation calls.
 *
 * The connection is the key (`{ api_key }`, the static key minter's bearer
 * placement) and the project it belongs to (`project_id`), which connectionFetch
 * sends on every request as OpenAI-Project, so a key is only ever used in the
 * project its connection declares, and which verify proves with a free call.
 */

const text = (key: string, required = false): ActionArgument => ({ key, type: 'text', required, allowsVariables: true, parseJson: false })
const json = (key: string, required = false): ActionArgument => ({ key, type: 'text', required, allowsVariables: true, parseJson: true })

const MODEL_CALL_BILLED =
  'A model call is billed when OpenAI runs it, whether or not its answer arrives, and a second call writes a different answer, so after an uncertain outcome a person decides whether to pay for another.'

export const OPENAI_CHAT_V1: ActionSchema = {
  key: 'openai.chat',
  name: 'Chat',
  version: 1,
  arguments: [
    text('model', true),
    // The next user message. Required unless `messages` already ends the conversation.
    text('user_message'),
    // The system message, when `messages` is not given.
    text('system_instructions'),
    // A whole message list ({ role, content } objects), as the code steps build it.
    json('messages'),
    // { "type": "json_object" } or { "type": "json_schema", "json_schema": { name, schema, strict } }.
    json('response_format'),
    json('max_tokens'),
    json('temperature'),
    json('top_p'),
    // A string or up to four strings.
    json('stop'),
    json('presence_penalty'),
    json('frequency_penalty'),
    // A stable id for the person the text is about, for OpenAI's abuse monitoring.
    text('user'),
  ],
  sideEffect: true,
  idempotent: false,
  idempotentBecause: MODEL_CALL_BILLED,
}

export const OPENAI_CREATE_RESPONSE_V1: ActionSchema = {
  key: 'openai.create-response',
  name: 'Create response',
  version: 1,
  arguments: [
    text('model', true),
    // A plain text input, or `input_items` (a list of input items): one of the two.
    text('input'),
    json('input_items'),
    text('instructions'),
    // A conversation id: the turn is added to it.
    text('conversation'),
    text('previous_response_id'),
    // The text.format: { "type": "json_schema", name, schema, strict } or { "type": "json_object" }.
    json('text_format'),
    // Tools, such as { "type": "file_search", "vector_store_ids": [...] }.
    json('tools'),
    json('store'),
    json('temperature'),
    json('max_output_tokens'),
    // Up to 16 keys, each value text.
    json('metadata'),
    // auto or disabled.
    text('truncation'),
    json('include'),
    json('reasoning'),
  ],
  sideEffect: true,
  idempotent: false,
  idempotentBecause: `${MODEL_CALL_BILLED} With a conversation, or stored, a repeat also adds the turn to the conversation twice.`,
}

export const OPENAI_CREATE_CONVERSATION_V1: ActionSchema = {
  key: 'openai.create-conversation',
  name: 'Create conversation',
  version: 1,
  arguments: [
    // Up to 16 keys, each value text.
    json('metadata'),
    // Up to 20 opening items.
    json('items'),
  ],
  sideEffect: true,
  idempotent: false,
  idempotentBecause:
    'OpenAI takes no key to deduplicate a new conversation on, so creating it again after an uncertain outcome makes it twice, and the step keeps only one of the two ids.',
}

export const OPENAI_ADD_CONVERSATION_ITEMS_V1: ActionSchema = {
  key: 'openai.add-conversation-items',
  name: 'Add conversation items',
  version: 1,
  arguments: [
    text('conversation_id', true),
    // 1 to 20 items, applied in one request.
    json('items', true),
  ],
  sideEffect: true,
  idempotent: false,
  idempotentBecause:
    'OpenAI takes no key to deduplicate added items on, so adding them again after an uncertain outcome puts them in the conversation twice.',
}

export const OPENAI_LIST_CONVERSATION_ITEMS_V1: ActionSchema = {
  key: 'openai.list-conversation-items',
  name: 'List conversation items',
  version: 1,
  arguments: [
    text('conversation_id', true),
    // 1 to 100; 20 when not given.
    json('limit'),
    // asc or desc.
    text('order'),
    // The item id to read on from.
    text('after'),
  ],
  sideEffect: false,
  idempotent: true,
  idempotentBecause: 'It only reads the conversation, so reading it again changes nothing.',
}

export const OPENAI_GET_CONVERSATION_V1: ActionSchema = {
  key: 'openai.get-conversation',
  name: 'Get conversation',
  version: 1,
  arguments: [text('conversation_id', true)],
  sideEffect: false,
  idempotent: true,
  idempotentBecause: 'It only reads the conversation, so reading it again changes nothing.',
}

export const OPENAI_SERVICE: ServiceSchema = {
  key: 'openai',
  name: 'OpenAI',
  actions: [
    OPENAI_CHAT_V1,
    OPENAI_CREATE_RESPONSE_V1,
    OPENAI_CREATE_CONVERSATION_V1,
    OPENAI_ADD_CONVERSATION_ITEMS_V1,
    OPENAI_LIST_CONVERSATION_ITEMS_V1,
    OPENAI_GET_CONVERSATION_V1,
  ],
  // The static key minter reads `api_key` from the login (minters/static-key.ts,
  // bearer); the ops OpenAI entry reads `project_id` from the target.
  connection: {
    tile: 'An API key for a project',
    auth: 'static_key',
    fields: [
      { key: 'project_id', label: 'Project ID', input: 'text', required: true, target: 'project_id' },
      { key: 'api_key', label: 'API key', input: 'secret', required: true, login: 'api_key' },
    ],
  },
}
