import type { ActionArgument, ActionSchema, ServiceSchema } from '../types'

/**
 * Anthropic (#2337, phase 7 of #1689): an API key for one Anthropic workspace.
 *
 * WHAT THE PIPEDREAM WORKFLOWS USE, counted in the export of 2026-09-30 (the
 * duplicate project folder left out; steps inside an if/else branch counted):
 * 3 steps in 3 workflows, all enabled, all one call to the Messages API.
 *   anthropic-chat (registry)  2 (0.0.9, 0.0.10): a model, one user message
 *                                 and a token limit
 *   a code step (the SDK, this.anthropic.$auth)  1: a system prompt, PDF and
 *                                 image documents as content blocks, and a
 *                                 JSON schema output format
 * No step uses any other Anthropic API (batches, files, token counting), so
 * this is the one action. No step calls api.anthropic.com by fetch.
 *
 * The connection is the key (`{ api_key }`, the static key minter's anthropic
 * placement, sent as x-api-key) and the workspace it runs in (`workspace_id`),
 * which connectionFetch sends on every request as anthropic-workspace-id, so a
 * key is only ever used in the workspace its connection declares, and which
 * verify proves with a free call.
 */

const text = (key: string, required = false): ActionArgument => ({ key, type: 'text', required, allowsVariables: true, parseJson: false })
const json = (key: string, required = false): ActionArgument => ({ key, type: 'text', required, allowsVariables: true, parseJson: true })

export const ANTHROPIC_CHAT_V1: ActionSchema = {
  key: 'anthropic.chat',
  name: 'Chat',
  version: 1,
  arguments: [
    text('model', true),
    // The next user message. Required unless `messages` already ends the conversation.
    text('user_message'),
    // Prior messages: text alternating from the person (as Pipedream took them), or { role, content } objects.
    json('messages'),
    text('system'),
    json('max_tokens', true),
    json('temperature'),
    json('top_p'),
    json('top_k'),
    json('stop_sequences'),
    // The output format, such as { "type": "json_schema", "schema": { ... } }; the answer is then parsed.
    json('output_format'),
  ],
  realSend: 'sends a real request to Claude',
  sideEffect: true,
  idempotent: false,
  idempotentBecause:
    'A model call is billed when Anthropic runs it, whether or not its answer arrives, and a second call writes a different answer, so after an uncertain outcome a person decides whether to pay for another.',
}

export const ANTHROPIC_SERVICE: ServiceSchema = {
  key: 'anthropic',
  name: 'Anthropic',
  actions: [ANTHROPIC_CHAT_V1],
  // The static key minter reads `api_key` from the login (minters/static-key.ts,
  // anthropic); the ops Anthropic entry reads `workspace_id` from the target.
  connection: {
    tile: 'An API key for a workspace',
    auth: 'static_key',
    fields: [
      { key: 'workspace_id', label: 'Workspace ID', input: 'text', required: true, target: 'workspace_id' },
      { key: 'api_key', label: 'API key', input: 'secret', required: true, login: 'api_key' },
    ],
  },
}
