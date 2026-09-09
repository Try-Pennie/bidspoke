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
})
