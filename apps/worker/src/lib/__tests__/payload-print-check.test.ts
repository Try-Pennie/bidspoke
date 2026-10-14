import { describe, it, expect } from 'vitest'
import { checkPayloadPrints, PAYLOAD_PRINT_REMEDY } from '../payload-print-check'
import type { AlertRemedy } from '../export-alerts'

const supabase = {} as never

/** Records what the check would have sent, so the messages are assertable. */
function recordingNotify() {
  const sent: string[][] = []
  const remedies: Array<AlertRemedy | undefined> = []
  return {
    sent,
    remedies,
    notify: async (m: string[], remedy?: AlertRemedy) => { sent.push(m); remedies.push(remedy) },
  }
}

const codeNode = (script: string, namespace = 'scout') => ({
  nodes: [{ id: 'n1', namespace, type: 'code', config: { script } }],
})

describe('checkPayloadPrints', () => {
  it('reports a workflow and node that prints a whole payload', async () => {
    const r = await checkPayloadPrints({}, supabase, {
      readWorkflows: async () => [
        { id: 'w1', name: 'Main Flow', definition: codeNode('console.log(JSON.stringify(parsedBody));') },
      ],
      notify: async () => {},
    })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].workflowName).toBe('Main Flow')
    expect(r.findings[0].identifier).toBe('parsedBody')
    expect(r.alerted).toBe(true)
  })

  it('stays quiet when every print is redacted', async () => {
    const r = await checkPayloadPrints({}, supabase, {
      readWorkflows: async () => [
        { id: 'w1', name: 'Main Flow', definition: codeNode('console.log(JSON.stringify(redactForLog(b)));') },
      ],
      notify: async () => {},
    })
    expect(r.findings).toEqual([])
    expect(r.alerted).toBe(false)
  })

  // L98: the two ways this reports nothing must not look the same.
  it('reports a read failure rather than reporting no findings', async () => {
    const r = await checkPayloadPrints({}, supabase, {
      readWorkflows: async () => { throw new Error('permission denied') },
      notify: async () => {},
    })
    expect(r.alerted).toBe(true)
    expect(r.unreadable.join(' ')).toContain('permission denied')
    expect(r.findings).toEqual([])
  })

  it('treats zero workflows as a read that scanned nothing, not as a clean result', async () => {
    const r = await checkPayloadPrints({}, supabase, { readWorkflows: async () => [], notify: async () => {} })
    expect(r.alerted).toBe(true)
    expect(r.unreadable.join(' ')).toContain('nothing was actually scanned')
  })

  it('scans every workflow rather than stopping at the first with a finding', async () => {
    const r = await checkPayloadPrints({}, supabase, {
      readWorkflows: async () => [
        { id: 'w1', name: 'A', definition: codeNode('console.log(JSON.stringify(x));') },
        { id: 'w2', name: 'B', definition: codeNode('console.log(JSON.stringify(y));') },
      ],
      notify: async () => {},
    })
    expect(r.findings.map((f) => f.workflowName)).toEqual(['A', 'B'])
  })

  it('sends a message naming the workflow, the node and what is being printed', async () => {
    const rec = recordingNotify()
    await checkPayloadPrints({}, supabase, {
      readWorkflows: async () => [
        { id: 'w1', name: 'Main Flow', definition: codeNode('console.log(JSON.stringify(parsedBody));', 'scout') },
      ],
      notify: rec.notify,
    })
    const text = rec.sent.flat().join(' ')
    expect(text).toContain('Main Flow')
    expect(text).toContain('scout')
    expect(text).toContain('parsedBody')
    // Logs left the only Logpush job on 2026-09-09 (logpush-expectation.ts), so
    // the value stays in Workers Logs rather than leaving Bidspoke (#835).
    expect(text).not.toMatch(/off-platform|leaves Bidspoke/)
    expect(text).toMatch(/Workers Logs/)
  })

  it('sends nothing when there is nothing to report', async () => {
    const rec = recordingNotify()
    await checkPayloadPrints({}, supabase, {
      readWorkflows: async () => [
        { id: 'w1', name: 'A', definition: codeNode("console.log('fine');") },
      ],
      notify: rec.notify,
    })
    expect(rec.sent.flat()).toEqual([])
  })

// The sites accepted in the baseline are live in production (#1214). Alerting on them daily until
// the canvas work lands would put a standing, unactionable finding in front of
// whoever reads the alert, which is what teaches people to skip the whole alert
// (L36, L269). They are accepted as a baseline so the check reports only what is
// NEW, and the baseline is the list of what is owed rather than a way of
// forgetting it.
describe('the accepted baseline', () => {
  const known = {
    id: 'w1',
    name: 'Main Flow',
    definition: {
      nodes: [
        { id: 'n1', namespace: 'pennie_or_eligibility', type: 'code', config: { script: 'console.log(JSON.stringify(result));' } },
      ],
    },
  }

  it('does not alert on a site that is already accepted', async () => {
    const rec = recordingNotify()
    const r = await checkPayloadPrints({}, supabase, {
      readWorkflows: async () => [known],
      notify: rec.notify,
    })
    expect(r.alerted).toBe(false)
    expect(rec.sent.flat()).toEqual([])
  })

  it('still counts an accepted site as a finding, so it is never lost', async () => {
    const r = await checkPayloadPrints({}, supabase, {
      readWorkflows: async () => [known],
      notify: async () => {},
    })
    expect(r.findings).toHaveLength(1)
    expect(r.newFindings).toEqual([])
  })

  it('alerts on a NEW site in a workflow that already has accepted ones', async () => {
    const rec = recordingNotify()
    const withNew = {
      ...known,
      definition: {
        nodes: [
          ...known.definition.nodes,
          { id: 'n2', namespace: 'brand_new_node', type: 'code', config: { script: 'console.log(JSON.stringify(applicant));' } },
        ],
      },
    }
    const r = await checkPayloadPrints({}, supabase, { readWorkflows: async () => withNew ? [withNew] : [], notify: rec.notify })
    expect(r.newFindings).toHaveLength(1)
    expect(rec.sent.flat().join(' ')).toContain('brand_new_node')
    expect(rec.sent.flat().join(' ')).not.toContain('pennie_or_eligibility')
  })

  // Added 2026-09-10 after the check's first live alert. This one is accepted on
  // DIFFERENT grounds from the others: it prints one named scalar field off
  // the partner payload (financialInformation.employmentStatus), not a record,
  // and the branch it sits in runs only when that field is absent or not a
  // string. Named here so the reason is testable rather than only asserted in a
  // comment (L407).
  it('does not alert on the accepted LendSwift employment status line', async () => {
    const rec = recordingNotify()
    const r = await checkPayloadPrints({}, supabase, {
      readWorkflows: async () => [
        {
          id: 'w2',
          name: 'RML - Bidding Workflow (LendSwift)',
          definition: {
            nodes: [
              {
                id: 'n1',
                namespace: 'validate_bidding_and_state',
                type: 'code',
                config: { script: 'console.log(`Rejected due to missing employment status: ${JSON.stringify(employmentStatus)}`);' },
              },
            ],
          },
        },
      ],
      notify: rec.notify,
    })
    expect(r.findings).toHaveLength(1)
    expect(r.newFindings).toEqual([])
    expect(rec.sent.flat()).toEqual([])
  })

  // Added 2026-10-09. Version 169 of Main Flow (2026-10-07) gave these two
  // steps the same Engine call code as fallback_engine_under_10000, print line
  // included. Same kind of site as the fallback ones, but accepted on its own
  // decision of 2026-10-09 (see the baseline). The script line is the live
  // one, verbatim.
  it('does not alert on the two Engine no bids steps that share the accepted fallback code', async () => {
    const rec = recordingNotify()
    const engineCall = (id: string, namespace: string) => ({
      id,
      namespace,
      type: 'code',
      config: { script: 'console.log(`Sending body to Engine: ${JSON.stringify(sanitizedBody)}`);' },
    })
    const r = await checkPayloadPrints({}, supabase, {
      readWorkflows: async () => [
        {
          id: 'w1',
          name: 'Main Flow',
          definition: {
            nodes: [engineCall('n1', 'engine_no_bids_call'), engineCall('n2', 'engine_no_bids_call_1')],
          },
        },
      ],
      notify: rec.notify,
    })
    expect(r.findings).toHaveLength(2)
    expect(r.newFindings).toEqual([])
    expect(rec.sent.flat()).toEqual([])
  })

  it('alerts when the same node starts printing a DIFFERENT value', async () => {
    const rec = recordingNotify()
    const changed = {
      ...known,
      definition: {
        nodes: [
          { id: 'n1', namespace: 'pennie_or_eligibility', type: 'code', config: { script: 'console.log(JSON.stringify(applicant));' } },
        ],
      },
    }
    const r = await checkPayloadPrints({}, supabase, { readWorkflows: async () => [changed], notify: rec.notify })
    expect(r.newFindings).toHaveLength(1)
  })
})

// #1166 gave the shared alerter a remedy parameter precisely so a check that is
// not about exported rows stops borrowing the export wording. This check is
// about a workflow definition: nothing was exported, nothing is missing from
// Snowflake, and no credential is involved. Asserted on the words the reader
// would actually see, not on the parameter being non-empty (L440).
describe('the alert says what this check measured', () => {
  it('supplies its own consequence and fix line rather than the export default', async () => {
    const rec = recordingNotify()
    await checkPayloadPrints({}, supabase, {
      readWorkflows: async () => [
        { id: 'w1', name: 'A', definition: codeNode('console.log(JSON.stringify(applicant));') },
      ],
      notify: rec.notify,
    })
    // Asserted defined FIRST: without it the comparison passes when BOTH sides
    // are undefined, which is the exact state this test exists to fail on (L1).
    expect(rec.remedies[0]).toBeDefined()
    expect(rec.remedies[0]).toEqual(PAYLOAD_PRINT_REMEDY)
  })

  it('never sends a remedy that talks about exported rows, Snowflake or credentials', () => {
    const words = `${PAYLOAD_PRINT_REMEDY.consequence} ${PAYLOAD_PRINT_REMEDY.fixHint}`.toLowerCase()
    for (const wrong of ['snowflake', 'exported', 'export', 'credential', 'supabase disk', 'retry']) {
      expect(words).not.toContain(wrong)
    }
  })

  it('says where the reader acts, which is the canvas, not a data pipeline', () => {
    const words = `${PAYLOAD_PRINT_REMEDY.consequence} ${PAYLOAD_PRINT_REMEDY.fixHint}`.toLowerCase()
    expect(words).toContain('canvas')
  })

  // The unreadable case is a different event from a finding, and the remedy has
  // to be true of both, because one alert can carry either (L11).
  it('supplies the same remedy when the scan could not run at all', async () => {
    const rec = recordingNotify()
    await checkPayloadPrints({}, supabase, {
      readWorkflows: async () => { throw new Error('permission denied') },
      notify: rec.notify,
    })
    // Asserted defined FIRST: without it the comparison passes when BOTH sides
    // are undefined, which is the exact state this test exists to fail on (L1).
    expect(rec.remedies[0]).toBeDefined()
    expect(rec.remedies[0]).toEqual(PAYLOAD_PRINT_REMEDY)
  })
})
})
