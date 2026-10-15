/**
 * The held write capture and the replay tool share ONE rule for "Salesforce
 * rejected this write" (#2054): `salesforceRejectedTheWrite`, imported from the
 * Salesforce node. A capture that kept its own copy of the rule would agree with
 * the replay only until one of them changed (L263, L370), so this replaces the
 * imported rule with a spy and checks the capture follows it wherever it goes: a
 * copied rule never calls the spy and ignores what it answers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ResolvedStepInput } from '../../types'

vi.mock('../nodes/salesforce', async (importOriginal) => {
  const real = await importOriginal<typeof import('../nodes/salesforce')>()
  return { ...real, salesforceRejectedTheWrite: vi.fn(real.salesforceRejectedTheWrite) }
})
vi.mock('../durability', async (importOriginal) => {
  const real = await importOriginal<typeof import('../durability')>()
  return { ...real, recordOutcomeDeadLetter: vi.fn().mockResolvedValue(true) }
})

import { salesforceRejectedTheWrite } from '../nodes/salesforce'
import { captureFailedWriteback } from '../writeback-deadletter'

const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 54)).toString('base64')
const request: ResolvedStepInput = {
  template: {},
  resolved: { operation: 'update', object: 'Prospect__c', record_id: 'a06Ui00002sLkNuIAK', body: { BidStatus__c: 'Rejected' } },
}

async function capture(status: number, text: string) {
  const inserts: Record<string, unknown>[] = []
  const supabase = {
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        inserts.push(row)
        return { error: null }
      },
    }),
  } as unknown as SupabaseClient
  await captureFailedWriteback(
    {
      orgId: '11111111-1111-1111-1111-111111112054',
      workflowId: '44444444-4444-4444-4444-444444442054',
      workflowName: 'Engine Bidding Workflow',
      executionId: '01920000-0000-7000-8000-000000002054',
      stepNamespace: 'patch_prospect_reject',
      nodeType: 'salesforce',
      errorType: 'permanent',
      error: new Error(`Salesforce API error (${status}): ${text}`),
      resolvedInput: request,
      salesforceAnswer: { status, text },
      isTest: false,
    },
    { supabase, kv: { get: async () => null, put: async () => {}, delete: async () => {} }, orgId: '11111111-1111-1111-1111-111111112054', appUrl: 'https://app', encryptionKeys: KEY },
  )
  return inserts[0]
}

beforeEach(() => vi.mocked(salesforceRejectedTheWrite).mockClear())

describe('the capture decides refused by the replay tool\'s rule, imported (#2054)', () => {
  it('asks the rule about Salesforce\'s answer to the write, its status and its text', async () => {
    await capture(403, '[{"errorCode":"INSUFFICIENT_ACCESS_OR_READONLY"}]')
    expect(salesforceRejectedTheWrite).toHaveBeenCalledWith(403, '[{"errorCode":"INSUFFICIENT_ACCESS_OR_READONLY"}]')
  })

  it('stores refused whenever the rule says Salesforce rejected the write, whatever the status', async () => {
    vi.mocked(salesforceRejectedTheWrite).mockReturnValueOnce(true)
    expect(await capture(401, '[{"errorCode":"INVALID_SESSION_ID"}]')).toMatchObject({ status: 'refused', replayable: false })
  })

  it('stores pending whenever the rule says it did not, whatever the status', async () => {
    vi.mocked(salesforceRejectedTheWrite).mockReturnValueOnce(false)
    expect(await capture(400, '[{"errorCode":"INVALID_FIELD"}]')).toMatchObject({ status: 'pending', replayable: true, finished_at: null })
  })
})
