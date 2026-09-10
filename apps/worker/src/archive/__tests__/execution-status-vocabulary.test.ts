/**
 * The archive's execution-status vocabulary, checked against the database
 * rather than against itself (#929, #930).
 *
 * The set this guards was wrong from the day it shipped: it claimed `success`,
 * `error`, `rejected`, `timeout` and `cancelled`, none of which anything has
 * ever written, and omitted `completed` and `degraded`, which are 99.75% of
 * production. Nothing caught it because the disposition tests supplied their own
 * status strings, so fixture and code agreed with each other and neither was
 * ever compared to the database (L52).
 *
 * So this suite has two jobs. It checks the code accounts for every value the
 * measured fixture holds, which closes today's instance. And it checks an
 * unrecognised status is its OWN outcome rather than falling into the in-flight
 * default, which closes the class: the retained window is only 7 days, so a rare
 * status can be legitimately absent from the fixture, and an unaccounted value
 * must be indistinguishable from nothing.
 */
import { describe, it, expect } from 'vitest'
import { A_V7_EXECUTION_ID } from './_ids'
import {
  classifyExecutionStatus,
  dispositionFor,
  ARCHIVE_DEADLINE_MS,
  EXPECTED_ORGANIZATION_SLUG,
  type StatusClass,
} from '../disposition'
import { SETTLE_WINDOW_MS } from '../clock'
import measured from '../fixtures/execution-statuses.json'

interface MeasuredStatus {
  status: string
  rows: number
  expected: StatusClass
  note: string
}

const present = measured.statuses as MeasuredStatus[]
const absentButLegitimate = measured.absentButLegitimate as MeasuredStatus[]

const HOUR_START = '2026-08-18T10:00:00.000Z'
const settled = new Date(Date.parse(HOUR_START) + SETTLE_WINDOW_MS + 60_000)
const pastDeadline = new Date(Date.parse(HOUR_START) + SETTLE_WINDOW_MS + ARCHIVE_DEADLINE_MS + 60_000)

const orgs = new Map([['wf-live', { id: 'org-live', slug: EXPECTED_ORGANIZATION_SLUG }]])
const execution = (status: string) => ({
  id: A_V7_EXECUTION_ID,
  workflow_id: 'wf-live',
  status,
  started_at: HOUR_START,
})

describe('the measured status fixture', () => {
  it('records how it was measured, over what window, and what that window cannot show', () => {
    expect(measured.provenance.measuredAt).toBeTruthy()
    expect(measured.provenance.windowStart).toBeTruthy()
    expect(measured.provenance.windowEnd).toBeTruthy()
    // The limitation is load-bearing, not commentary: it is the reason the
    // unrecognised branch below has to exist at all.
    expect(measured.provenance.windowLimitation).toMatch(/7 days/)
  })

  it('holds the four statuses production actually writes, and no invented ones', () => {
    expect(present.map((s) => s.status).sort()).toEqual(['completed', 'degraded', 'failed', 'running'])
    for (const s of present) expect(s.rows).toBeGreaterThan(0)
  })
})

describe('classifyExecutionStatus', () => {
  // The guard #930 asks for: every measured value must be accounted for, and
  // accounted for as the fixture says. A status the code does not know is a
  // failure here, not a silent default at runtime.
  for (const s of [...present, ...absentButLegitimate]) {
    it(`classifies ${s.status} as ${s.expected} (${s.rows} rows measured)`, () => {
      expect(classifyExecutionStatus(s.status)).toBe<StatusClass>(s.expected)
    })
  }

  it('classifies a status nobody accounted for as unrecognised, not as in-flight', () => {
    expect(classifyExecutionStatus('abandoned')).toBe<StatusClass>('unrecognised')
    expect(classifyExecutionStatus('')).toBe<StatusClass>('unrecognised')
  })

  it('does not classify the values the old hand-written set invented', () => {
    for (const invented of measured.measuredAbsent.statuses) {
      expect(classifyExecutionStatus(invented)).toBe<StatusClass>('unrecognised')
    }
  })
})

describe('dispositionFor, against the statuses production writes', () => {
  it('archives every terminal status cleanly, inside the deadline', () => {
    for (const s of present.filter((x) => x.expected === 'terminal')) {
      const d = dispositionFor(execution(s.status), { now: settled, organizationOf: orgs })
      expect(d.action, s.status).toBe('archive')
      expect(d.incomplete, s.status).toBe(false)
    }
  })

  // The bug this suite exists for: 99.75% of production was being refused.
  it('refuses none of the terminal population', () => {
    const terminal = present.filter((x) => x.expected === 'terminal')
    const refused = terminal.filter(
      (s) => dispositionFor(execution(s.status), { now: settled, organizationOf: orgs }).action === 'refuse',
    )
    expect(refused).toEqual([])
    // Guards the direction as well as the outcome: these three are the bulk of
    // the table, so a set that refused them archives essentially nothing.
    const rows = terminal.reduce((n, s) => n + s.rows, 0)
    const all = present.reduce((n, s) => n + s.rows, 0)
    expect(rows / all).toBeGreaterThan(0.99)
  })

  it('refuses an unrecognised status with its own reason, distinct from a running one', () => {
    const unknown = dispositionFor(execution('abandoned'), { now: settled, organizationOf: orgs })
    const running = dispositionFor(execution('running'), { now: settled, organizationOf: orgs })

    expect(unknown.action).toBe('refuse')
    expect(unknown.reason).toMatch(/unrecognised/i)
    expect(unknown.reason).toMatch(/abandoned/)
    // Distinct causes, distinct messages (L11): a status nobody has accounted
    // for must not read as an ordinary in-flight execution, because that is the
    // exact confusion that hid this bug.
    expect(unknown.reason).not.toBe(running.reason)
    expect(running.reason).not.toMatch(/unrecognised/i)
  })

  // An unrecognised status must not be able to hang the watermark forever
  // (L110). The deadline covers it exactly as it covers a stranded run, and the
  // reason still names the status so the cause survives to the alert.
  it('archives an unrecognised status past the deadline rather than blocking the hour forever', () => {
    const d = dispositionFor(execution('abandoned'), { now: pastDeadline, organizationOf: orgs })

    expect(d.action).toBe('archive')
    expect(d.incomplete).toBe(true)
    expect(d.reason).toMatch(/abandoned/)
  })
})
