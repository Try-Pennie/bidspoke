import { describe, it, expect } from 'vitest'
import { checkPayloadPrints } from '../payload-print-check'

const supabase = {} as never

/** Records what the check would have sent, so the messages are assertable. */
function recordingNotify() {
  const sent: string[][] = []
  return { sent, notify: async (m: string[]) => { sent.push(m) } }
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

// The nine sites live in production today (#1214). Alerting on them daily until
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
})
