/**
 * The Liberty1 click send's success line (#1547), as the canvas runs it.
 *
 * Since 2026-09-30 (Dan) the click posts to Liberty1's LeadConnector webhook
 * triggers, which answer HTTP 200 with
 * `{"status":"Success: request sent to trigger execution server","id":"..."}`.
 * That means queued to Liberty1's LeadConnector workflow, not a record created,
 * and the id is LeadConnector's run id. The pattern is read from
 * docs/workflows/liberty1-click/definition.json, compiled the way the node
 * compiles it, and each answer goes through the real response reader
 * (postToPartner) and the node's own classifier, so the HTML rule and the JSON
 * handling are the ones that run in production.
 */
import { describe, expect, it } from 'vitest'
import type { Env } from '../../index'
import workflowFile from '../../../../../docs/workflows/liberty1-click/definition.json'
import replies from '../scripts/__tests__/fixtures/liberty1-leadconnector-replies.json'
import { classifyClickAnswer, compileSuccessPattern } from '../nodes/buyer-click-send'
import { postToPartner } from '../../lib/post-to-partner'

type Reply = { status: number; body: string }

const send = (workflowFile.definition.nodes as Array<{ type: string; config: Record<string, unknown> }>).find((n) => n.type === 'buyer_click_send')
const PATTERN = compileSuccessPattern(String(send?.config.success_pattern))

async function answer(reply: Reply) {
  const res = await postToPartner(
    { slug: 'liberty1', api_endpoint: 'https://services.leadconnectorhq.com/hooks/test/webhook-trigger/test', cf_secret_key: null },
    { leadId1: 'a0P5f00000TestA1AA' },
    {} as Env,
    { traceId: 'trace-1', timeoutMs: 1000, fetchImpl: async () => new Response(reply.body, { status: reply.status }) },
  )
  return classifyClickAnswer(res, PATTERN)
}

describe('the Liberty1 click success line', () => {
  it("confirms LeadConnector's real success reply and takes its run id as the partner lead id", async () => {
    expect(await answer(replies.success)).toEqual({ kind: 'confirmed', partnerLeadId: replies.success.id })
  })

  for (const [name, reply] of Object.entries(replies.rejects as Record<string, Reply>)) {
    it(`${name}: never counted as sent, left unknown for a person to check`, async () => {
      expect((await answer(reply)).kind).toBe('unknown')
    })
  }

  it('is matched against the whole answer, so extra text around a success reply is not a success', async () => {
    expect((await answer({ status: 200, body: `${replies.success.body} trailing` })).kind).toBe('unknown')
  })

  it('a 4xx from LeadConnector is a refusal in its own words, never a success', async () => {
    expect((await answer({ status: 400, body: replies.success.body })).kind).toBe('refused')
  })
})
