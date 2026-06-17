/**
 * Wiring for the bid-matrix problem alert (#182): notifyMatrixProblems groups
 * sync results by org, drops configs with no problems, and fires one validation
 * alert per org. The Slack send itself is mocked here (covered in
 * bid-matrix-sync.test.ts); this asserts the aggregation glue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../slack', () => ({
  sendMatrixValidationAlert: vi.fn().mockResolvedValue(true),
  sendMatrixChangeAlert: vi.fn().mockResolvedValue(true),
}))

import { notifyMatrixProblems, type SyncResult } from '../bid-matrix-sync'
import { sendMatrixValidationAlert } from '../slack'
import type { MatrixProblem } from '../bid-matrix-validate'

function result(p: Partial<SyncResult> & { organization_id: string; config_slug: string }): SyncResult {
  return {
    config_id: `cfg-${p.config_slug}`,
    config_name: p.config_slug,
    rows_fetched: 0,
    rows_upserted: 0,
    rows_deleted: 0,
    last_synced_at: '2024-01-15T18:00:00.000Z',
    diff: null,
    problems: [],
    ...p,
  }
}

const overlap: MatrixProblem = { kind: 'overlap', axis: 'row', is_sell_off: false, detail: 'score 600-720 overlaps 700-800' }
const supabase = {} as never

describe('notifyMatrixProblems (#182)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not alert when no config has problems', async () => {
    await notifyMatrixProblems(supabase, [
      result({ organization_id: 'org-1', config_slug: 'sofi' }),
      result({ organization_id: 'org-1', config_slug: 'amone' }),
    ])
    expect(vi.mocked(sendMatrixValidationAlert)).not.toHaveBeenCalled()
  })

  it('fires one alert per org and drops clean configs from the payload', async () => {
    await notifyMatrixProblems(supabase, [
      result({ organization_id: 'org-1', config_slug: 'sofi', config_name: 'SoFi default', problems: [overlap] }),
      result({ organization_id: 'org-1', config_slug: 'amone', problems: [] }), // clean — excluded
      result({ organization_id: 'org-2', config_slug: 'tlg', problems: [overlap] }),
    ])

    expect(vi.mocked(sendMatrixValidationAlert)).toHaveBeenCalledTimes(2)

    const org1 = vi.mocked(sendMatrixValidationAlert).mock.calls.find((c) => c[1] === 'org-1')!
    expect(org1[2]).toBeNull() // no channel override
    const payload = org1[3]
    expect(payload.configs).toHaveLength(1) // amone (clean) dropped
    expect(payload.configs[0]).toMatchObject({ partner_slug: 'sofi', config_name: 'SoFi default' })
    expect(payload.configs[0].problems).toEqual([overlap])

    const org2 = vi.mocked(sendMatrixValidationAlert).mock.calls.find((c) => c[1] === 'org-2')!
    expect(org2[3].configs[0].partner_slug).toBe('tlg')
  })
})
