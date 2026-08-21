import { describe, it, expect } from 'vitest'
import {
  dispositionFor,
  ARCHIVE_DEADLINE_MS,
  EXPECTED_ORGANIZATION_SLUG,
  type Disposition,
} from '../disposition'
import { SETTLE_WINDOW_MS } from '../clock'

const HOUR_START = '2026-08-18T10:00:00.000Z'
const settled = new Date(Date.parse(HOUR_START) + SETTLE_WINDOW_MS + 60_000)
const pastDeadline = new Date(Date.parse(HOUR_START) + SETTLE_WINDOW_MS + ARCHIVE_DEADLINE_MS + 60_000)

// 'completed' rather than a plausible-looking invented value: this fixture used
// to say 'success', which nothing has ever written, so it agreed with a set that
// was itself wrong and neither was ever checked against the database (L52, #929).
// The measured vocabulary lives in ../fixtures/execution-statuses.json and is
// enforced by ./execution-status-vocabulary.test.ts.
const execution = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'e1',
  workflow_id: 'wf-live',
  status: 'completed',
  started_at: HOUR_START,
  ...over,
})

const orgs = new Map([
  ['wf-live', { id: 'org-live', slug: EXPECTED_ORGANIZATION_SLUG }],
  ['wf-e2e', { id: 'org-e2e', slug: 'E2E Test' }],
])

describe('dispositionFor', () => {
  it('archives a terminal execution from the expected organization', () => {
    const d = dispositionFor(execution(), { now: settled, organizationOf: orgs })

    expect(d.action).toBe<Disposition['action']>('archive')
    expect(d.incomplete).toBe(false)
  })

  // The single-tenant decision is what lets the archive skip a database-layer
  // tenant boundary, and it is a measurement rather than a guarantee: the e2e
  // org creates workflows and has simply never produced an execution. So the
  // claim is enforced where there is real data to judge, not asserted in a doc.
  it('refuses an execution from any other organization', () => {
    const d = dispositionFor(execution({ workflow_id: 'wf-e2e' }), { now: settled, organizationOf: orgs })

    expect(d.action).toBe<Disposition['action']>('refuse')
    expect(d.reason).toMatch(/E2E Test/)
    expect(d.reason).toMatch(new RegExp(EXPECTED_ORGANIZATION_SLUG))
  })

  it('refuses an execution whose workflow it cannot place in any organization', () => {
    const d = dispositionFor(execution({ workflow_id: 'wf-unknown' }), { now: settled, organizationOf: orgs })

    expect(d.action).toBe<Disposition['action']>('refuse')
    expect(d.reason).toMatch(/no organization/)
  })

  it('refuses a still-running execution that is inside the deadline', () => {
    const d = dispositionFor(execution({ status: 'running' }), { now: settled, organizationOf: orgs })

    expect(d.action).toBe<Disposition['action']>('refuse')
    expect(d.reason).toMatch(/still running/)
  })

  // At the deadline the row is archived AS IT STANDS rather than blocking
  // forever. A single permanently stranded execution would otherwise stop all
  // archiving and, by the constraint that no delete runs without a backup, all
  // deletion, with no mechanism able to clear it (L110).
  it('archives a still-running execution past the deadline, marked incomplete', () => {
    const d = dispositionFor(execution({ status: 'running' }), { now: pastDeadline, organizationOf: orgs })

    expect(d.action).toBe<Disposition['action']>('archive')
    expect(d.incomplete).toBe(true)
    expect(d.reason).toMatch(/deadline/)
  })

  it('does not mark a terminal execution incomplete just because it is old', () => {
    const d = dispositionFor(execution(), { now: pastDeadline, organizationOf: orgs })

    expect(d.action).toBe<Disposition['action']>('archive')
    expect(d.incomplete).toBe(false)
  })

  // The tenancy refusal outranks the deadline: archiving another tenant's data
  // "as it stands" would be the one outcome the refusal exists to prevent.
  it('refuses a foreign organization even past the deadline', () => {
    const d = dispositionFor(execution({ workflow_id: 'wf-e2e', status: 'running' }), {
      now: pastDeadline,
      organizationOf: orgs,
    })

    expect(d.action).toBe<Disposition['action']>('refuse')
    expect(d.reason).toMatch(/E2E Test/)
  })

  it('matches the deadline used by the stranded-execution finaliser', () => {
    // finalize_unrecoverable_stranded runs at 26 hours, so a row this job gives
    // up on is one that job has already given up on too.
    expect(ARCHIVE_DEADLINE_MS).toBe(24 * 60 * 60 * 1000)
    expect(ARCHIVE_DEADLINE_MS + SETTLE_WINDOW_MS).toBe(26 * 60 * 60 * 1000)
  })
})
