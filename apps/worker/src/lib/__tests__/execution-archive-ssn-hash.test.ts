/**
 * The archive writes a person resolver it can actually use (#927).
 *
 * `ssn_hash` is the archive's secondary erasure resolver: A7 (#875) uses it to
 * find a person's archived rows without decompressing 450 GB of bundles. It was
 * shipped as a literal NULL, so the archive had no scalar resolver at all.
 *
 * TIMING is the whole reason this belongs in the shadow phase rather than in
 * A7. After A5 (#873) repoints the purge, the Postgres rows are gone, so any row
 * archived without this can never have it backfilled. Every hour that passes
 * without it is permanently unresolvable by this route.
 *
 * SOURCE, decided 2026-08-22: the execution's own `trigger_payload`, which the
 * archiver already holds in memory when it builds the bundle. The alternative
 * considered was a per-hour join against `lead_sightings`, which costs an extra
 * paged read and, worse, cannot tell an execution that genuinely carried no SSN
 * (a measured 3.5%) from a sightings row already purged: both return nothing.
 * Reading the payload the archiver already has removes that ambiguity entirely.
 *
 * The field path is NOT re-derived here. `extractPersonFields` is the one place
 * that records where an SSN sits in a trigger payload, verified against the live
 * Engine Bidding Workflow, and the hash is the existing peppered `hashSsn`, so
 * A7 hashes an erasure request with the same function over the same
 * normalisation and the two can actually meet.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../index'

vi.mock('../export-alerts', () => ({
  notifyExportFailure: vi.fn().mockResolvedValue(undefined),
  notifyExportRecovery: vi.fn().mockResolvedValue(undefined),
}))

import { runExecutionArchive, type ArchiveRow } from '../execution-archive'
import { notifyExportFailure } from '../export-alerts'
import { EXPECTED_ORGANIZATION_SLUG } from '../../archive/disposition'
import { hashSsn } from '../../engine/persons-crypto'
import { makeArchiveDouble, makeKV, NOW, EXECUTION_ID } from './_archive-double'

const PEPPER = 'test-pepper-927'
const SSN = '123-45-6789'

async function run(opts: { triggerPayload?: unknown; pepper?: string | undefined }) {
  const double = makeArchiveDouble({
    organizationSlug: EXPECTED_ORGANIZATION_SLUG,
    triggerPayload: opts.triggerPayload,
  })
  const sent: ArchiveRow[] = []
  const env = {
    IDEMPOTENCY: makeKV(),
    SSN_HASH_PEPPER: 'pepper' in opts ? opts.pepper : PEPPER,
  } as unknown as Env
  const summary = await runExecutionArchive(env, double.client, {
    sendBatch: async (rows) => { sent.push(...rows) },
    now: () => NOW,
  })
  return { summary, sent, writes: double.writes }
}

beforeEach(() => { vi.clearAllMocks() })

describe('the archive writes a usable person resolver (#927)', () => {
  it('hashes the SSN from the payload the archiver already holds', async () => {
    const { sent } = await run({
      triggerPayload: { personalInformation: { ssn: SSN, firstName: 'Ada', lastName: 'Lovelace' } },
    })

    expect(sent).toHaveLength(1)
    expect(sent[0].executionId).toBe(EXECUTION_ID)
    // Compared against the SHARED hash function, not against a literal. A
    // literal would pass while the archive and the erasure request hashed
    // differently, which is the one way this column can be present and useless.
    expect(sent[0].scalars.ssnHash).toBe(await hashSsn(SSN, PEPPER))
  })

  it('normalises the SSN so a differently formatted one resolves to the same row', async () => {
    const formatted = await run({
      triggerPayload: { personalInformation: { ssn: '123-45-6789' } },
    })
    const bare = await run({
      triggerPayload: { personalInformation: { ssn: '123456789' } },
    })

    // An erasure request arriving in either spelling has to find the row. Two
    // spellings that mean one person must not survive as two hashes (L185).
    expect(formatted.sent[0].scalars.ssnHash).toBe(bare.sent[0].scalars.ssnHash)
  })

  it('writes no hash, and still archives, for an execution carrying no SSN', async () => {
    // A measured 3.5% of executions genuinely carry none. That is a legitimate
    // value, not a failure, and it must not refuse the execution.
    const { sent, summary } = await run({
      triggerPayload: { personalInformation: { firstName: 'Ada' } },
    })

    expect(sent).toHaveLength(1)
    expect(sent[0].scalars.ssnHash).toBeNull()
    expect(summary.executionsArchived).toBe(1)
    expect(summary.executionsRefused).toBe(0)
  })

  it('writes no hash for an execution with no payload at all', async () => {
    const { sent } = await run({ triggerPayload: null })
    expect(sent[0].scalars.ssnHash).toBeNull()
  })

  it('refuses to run at all when the pepper is missing', async () => {
    // Not a per execution refusal: a missing pepper is a configuration fault
    // affecting every row, and a row archived without the hash can never be
    // given one after A5 removes the source. Writing NULL for a whole hour and
    // reporting success is the failure this guards (L67).
    const { summary, sent } = await run({
      triggerPayload: { personalInformation: { ssn: SSN } },
      pepper: undefined,
    })

    expect(sent).toEqual([])
    expect(summary.failed).toBe(true)
    expect(summary.detail).toMatch(/pepper/i)
  })

  // #835: the alert the run sends must carry the pepper remedy, restore the
  // escrowed value and never make a new one, not the general wording.
  it('alerts with the restore the escrowed pepper remedy', async () => {
    vi.mocked(notifyExportFailure).mockClear()
    await run({ triggerPayload: { personalInformation: { ssn: SSN } }, pepper: undefined })
    const remedy = vi.mocked(notifyExportFailure).mock.calls[0]?.[4] as { fixHint?: string } | undefined
    expect(remedy?.fixHint).toMatch(/Restore SSN_HASH_PEPPER from the 1Password item "Bidspoke recovery keys"/)
  })
})
