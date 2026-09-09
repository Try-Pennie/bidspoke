import { describe, it, expect } from 'vitest'
import { logpushDifferences, PII_BEARING_FIELDS } from '../logpush-drift'
import type { ObservedLogpush } from '../logpush-drift'
import type { ExpectedLogpushJob } from '../../lib/logpush-expectation'

// #1010, and #1007 is why the field list is in scope rather than only the
// destination set. The Better Stack job's destination never changed. What
// changed nothing and harmed everything was output_options.field_names carrying
// Logs, which exported applicant SSNs to a third party for months.

const EXPECTED: ExpectedLogpushJob[] = [
  {
    id: 1740821,
    name: 'logpush-better-stack-logs',
    destinationHost: 's2537399.eu-fsn-3.betterstackdata.com',
    dataset: 'workers_trace_events',
    enabled: true,
    fieldNames: ['DispatchNamespace', 'Entrypoint', 'EventTimestampMs', 'EventType', 'ScriptName', 'ScriptTags', 'ScriptVersion'],
  },
]

function observed(over: Partial<ObservedLogpush['jobs'][number]> = {}): ObservedLogpush {
  return {
    jobs: [
      {
        id: 1740821,
        name: 'logpush-better-stack-logs',
        destinationHost: 's2537399.eu-fsn-3.betterstackdata.com',
        dataset: 'workers_trace_events',
        enabled: true,
        fieldNames: [...EXPECTED[0].fieldNames],
        lastCompleteMs: Date.parse('2026-09-09T16:45:00Z'),
        ...over,
      },
    ],
    unreadable: [],
  }
}

const NOW = Date.parse('2026-09-09T17:00:00Z')

describe('logpushDifferences', () => {
  it('reports nothing when the account matches the expectation', () => {
    expect(logpushDifferences(observed(), EXPECTED, NOW)).toEqual([])
  })

  it('reports a job that is on the account and not in the expectation', () => {
    const o = observed()
    o.jobs.push({
      id: 999, name: 'someone-elses-job', destinationHost: 'logs.vendor.example',
      dataset: 'workers_trace_events', enabled: true, fieldNames: ['ScriptName'], lastCompleteMs: NOW,
    })
    const d = logpushDifferences(o, EXPECTED, NOW)
    expect(d.join(' ')).toContain('logs.vendor.example')
  })

  it('says loudly when an unexpected job carries a PII bearing field', () => {
    const o = observed()
    o.jobs.push({
      id: 999, name: 'someone-elses-job', destinationHost: 'logs.vendor.example',
      dataset: 'workers_trace_events', enabled: true, fieldNames: ['Logs'], lastCompleteMs: NOW,
    })
    const d = logpushDifferences(o, EXPECTED, NOW).join(' ')
    expect(d).toContain('Logs')
    expect(d.toLowerCase()).toContain('personal data')
  })

  it('reports an expected job that has disappeared', () => {
    const d = logpushDifferences({ jobs: [], unreadable: [] }, EXPECTED, NOW)
    expect(d.join(' ')).toContain('logpush-better-stack-logs')
  })

  // The case this whole milestone turned on.
  it('reports a PII bearing field ADDED to a known job, naming the field', () => {
    const o = observed({ fieldNames: [...EXPECTED[0].fieldNames, 'Logs'] })
    const d = logpushDifferences(o, EXPECTED, NOW).join(' ')
    expect(d).toContain('Logs')
    expect(d.toLowerCase()).toContain('personal data')
  })

  it('reports a non-PII field change too, without calling it personal data', () => {
    const o = observed({ fieldNames: [...EXPECTED[0].fieldNames, 'Outcome'] })
    const d = logpushDifferences(o, EXPECTED, NOW).join(' ')
    expect(d).toContain('Outcome')
    expect(d.toLowerCase()).not.toContain('personal data')
  })

  it('reports a job that has been disabled', () => {
    const d = logpushDifferences(observed({ enabled: false }), EXPECTED, NOW).join(' ')
    expect(d.toLowerCase()).toContain('disabled')
  })

  it('reports a job that has stopped delivering', () => {
    const stale = Date.parse('2026-09-08T00:00:00Z')
    const d = logpushDifferences(observed({ lastCompleteMs: stale }), EXPECTED, NOW).join(' ')
    expect(d.toLowerCase()).toContain('delivered')
  })

  // A job that has NEVER delivered is the #1008 shape, and it must not read the
  // same as one that delivered recently.
  it('reports a job that has never delivered at all', () => {
    const d = logpushDifferences(observed({ lastCompleteMs: null }), EXPECTED, NOW).join(' ')
    expect(d.toLowerCase()).toContain('never')
  })

  // L98: an unreadable answer must be its own condition, never silence.
  it('reports an unreadable account rather than reporting no differences', () => {
    const d = logpushDifferences({ jobs: [], unreadable: ['the job list could not be read: 10000'] }, EXPECTED, NOW)
    expect(d.join(' ')).toContain('could not be read')
  })

  it('does not accuse jobs of being missing when the account was unreadable', () => {
    const d = logpushDifferences({ jobs: [], unreadable: ['boom'] }, EXPECTED, NOW).join(' ')
    expect(d).not.toContain('logpush-better-stack-logs')
  })

  it('treats Event, Logs and Exceptions as the PII bearing fields', () => {
    expect([...PII_BEARING_FIELDS].sort()).toEqual(['Event', 'Exceptions', 'Logs'])
  })
})
