/**
 * The validation script guard (#2595, part of #934).
 *
 * Once a workflow has swapped its validation script for the first class lead
 * validation step, nobody may quietly paste a script back. The guard reads every
 * active workflow's definition daily and reports a code node that both returns
 * `status: 'rejected'` and names one of the lead validation reasons.
 *
 * The not flagged cases (the response and credit report scripts that reject with
 * their own reasons) carry as many tests as the flagged ones: this runs daily
 * over every live definition, and a false finding in front of the reader every
 * morning is what teaches them to skip it.
 */
import { describe, it, expect } from 'vitest'
import { LEAD_REJECTION_REASONS } from '@bidspoke/workflow-definition'
import {
  checkValidationScripts,
  endingOf,
  findValidationScripts,
  KNOWN_VALIDATION_SCRIPTS,
  SHARED_REJECTION_REASON,
  VALIDATION_REASONS,
  VALIDATION_SCRIPT_REMEDY,
  type ValidationScriptException,
} from '../validation-script-guard'
import type { AlertRemedy } from '../export-alerts'
import gigfiV24 from '../../../money-gate/swap/replaced/rml-gigfi-v24.json'
import gigfiLive from '../../../money-gate/fixtures/definitions/6624acd0-bf61-4d21-85fc-4371ca7ed77d.json'
import leadEconomy from '../../../money-gate/fixtures/definitions/89b1a6af-7e0f-43de-bc66-1e888184551f.json'
import engineBidding from '../../../money-gate/fixtures/definitions/da82a183-1a4a-417e-b0b8-5f3fe5e14840.json'
import mainFlow from '../../../money-gate/fixtures/definitions/60e2e0bc-5aa2-47db-b333-3a8fe1c62e09.json'
import liberty1Click from '../../../money-gate/fixtures/definitions/8a0f65aa-49a9-441c-a47e-b2a9a5fb2b08.json'
import gmailDelegate from '../../../money-gate/fixtures/definitions/ee8ebc50-07dc-4670-89c7-d8ae47401558.json'

const supabase = {} as never

interface Fixture { id: string; name: string; definition: unknown }
/**
 * The money gate's copies of the live definitions. RML LendSwift's copy is left
 * out: it still holds the script its v26 swap (#2593) retired on 2026-10-22,
 * until the fixture is refreshed, so it says nothing about what LendSwift runs
 * today.
 */
const COMMITTED: Fixture[] = [gigfiLive, leadEconomy, engineBidding, mainFlow, liberty1Click, gmailDelegate] as Fixture[]

type FixtureNode = { namespace?: string; type?: string; config?: { script?: string } }
function nodeOf(fixture: { definition: unknown }, namespace: string): FixtureNode {
  const nodes = (fixture.definition as { nodes: FixtureNode[] }).nodes
  const node = nodes.find((n) => n.namespace === namespace)
  if (!node) throw new Error(`fixture has no ${namespace} node`)
  return node
}
const scriptOf = (fixture: { definition: unknown }, namespace: string): string => {
  const script = nodeOf(fixture, namespace).config?.script
  if (typeof script !== 'string') throw new Error(`${namespace} carries no script`)
  return script
}

const codeNode = (script: string, namespace = 'validate_bidding_and_state') => ({
  nodes: [{ id: 'n1', namespace, type: 'code', config: { script } }],
})

function recordingNotify() {
  const sent: string[][] = []
  const remedies: Array<AlertRemedy | undefined> = []
  return { sent, remedies, notify: async (m: string[], remedy?: AlertRemedy) => { sent.push(m); remedies.push(remedy) } }
}

const NO_EXCEPTIONS: ValidationScriptException[] = []

describe('the reasons the guard looks for', () => {
  it('names the one shared reason, and that reason is on the lead rejection list', () => {
    // If unqualified_lead were respelled or removed from the vocabulary, the
    // exclusion below would silently exclude nothing (L96).
    expect(SHARED_REJECTION_REASON).toBe('unqualified_lead')
    expect(LEAD_REJECTION_REASONS as readonly string[]).toContain(SHARED_REJECTION_REASON)
  })

  it('follows the vocabulary: every lead rejection reason except the shared one', () => {
    expect([...VALIDATION_REASONS]).toEqual(LEAD_REJECTION_REASONS.filter((r) => r !== SHARED_REJECTION_REASON))
  })
})

describe('findValidationScripts', () => {
  it('finds the validation script GigFi ran before its swap (positive control)', () => {
    const hits = findValidationScripts(gigfiV24.definition)
    expect(hits.map((h) => h.namespace)).toEqual(['validate_bidding_and_state'])
    expect(hits[0].reasons).toEqual(
      expect.arrayContaining(['bidding not active', 'ineligible state', 'invalid name', 'unqualified']),
    )
  })

  it('finds a reason passed through a variable', () => {
    const script = [
      "if (!ok) {",
      "  const reason = 'ineligible state';",
      "  return { response: { status: 200, body: { status: 'rejected', reason } } };",
      "}",
    ].join('\n')
    expect(findValidationScripts(codeNode(script)).map((h) => h.reasons)).toEqual([['ineligible state']])
  })

  it('finds the status in any quote style', () => {
    for (const status of [`"status": "rejected"`, `'status': 'rejected'`, 'status: `rejected`', `status:"rejected"`]) {
      const script = `return { body: { ${status}, reason: "invalid name" } };`
      expect(findValidationScripts(codeNode(script)), status).toHaveLength(1)
    }
  })

  it('reads the React Flow shape and the code key as well as the flat shape', () => {
    const script = `return { body: { status: 'rejected', reason: 'missing phone' } };`
    const definition = {
      nodes: [{ id: 'rf1', data: { namespace: 'check_lead', type: 'code', config: { code: script } } }],
    }
    expect(findValidationScripts(definition).map((h) => h.namespace)).toEqual(['check_lead'])
  })

  it('does not flag GigFi\'s response script, which rejects with unqualified_lead and bid_below_threshold', () => {
    expect(findValidationScripts(codeNode(scriptOf(gigfiV24, 'build_response'), 'build_response'))).toEqual([])
  })

  it('does not flag Engine Bidding\'s credit report script, which rejects with its own reasons', () => {
    const script = scriptOf(engineBidding, 'equifax_credit_report')
    // The control: the script really does return a rejection, so the test is
    // about the reasons and not about a script that rejects nothing.
    expect(script).toMatch(/status:\s*'rejected'/)
    expect(findValidationScripts(codeNode(script, 'equifax_credit_report'))).toEqual([])
  })

  it('does not flag a script rejecting with the response and credit report reasons', () => {
    const script = [
      "if (!report) return { status: 'rejected', reason: 'missing_credit_check' };",
      "if (failed) return { status: 'rejected', reason: 'partner_error' };",
      "if (low) { const reason = 'bid_below_threshold'; return { body: { status: 'rejected', reason } } }",
      "return { body: { status: 'rejected', reason: 'unqualified_lead' } };",
    ].join('\n')
    expect(findValidationScripts(codeNode(script, 'build_response'))).toEqual([])
  })

  it('does not flag a validation reason with no rejection beside it', () => {
    // A script that mentions a reason, a log line or a label, without returning
    // a rejection, is not a validation step.
    expect(findValidationScripts(codeNode(`console.log('invalid name');\nreturn { ok: true };`))).toEqual([])
  })

  it('does not flag a lead validation step', () => {
    const definition = {
      nodes: [{
        id: 'lv1',
        namespace: 'validate_bidding_and_state',
        type: 'lead_validation',
        config: { script: `return { status: 'rejected', reason: 'invalid name' }`, checks: [{ reason: 'invalid name' }] },
      }],
    }
    expect(findValidationScripts(definition)).toEqual([])
  })

  it('does not flag a reason named only in a comment', () => {
    const script = [
      "// rejected here as 'unqualified' before #926",
      "return { body: { status: 'rejected', reason: 'unqualified_lead' } };",
    ].join('\n')
    expect(findValidationScripts(codeNode(script))).toEqual([])
  })

  it('does not catch a validation script whose only reason is unqualified_lead (the named blind spot)', () => {
    // Pinned so the blind spot is a recorded decision rather than a surprise:
    // unqualified_lead is also what the response and credit report scripts
    // send, so a validation script using only it is indistinguishable here.
    const script = `if (!valid) return { response: { body: { status: 'rejected', reason: 'unqualified_lead' } } };`
    expect(findValidationScripts(codeNode(script))).toEqual([])
  })

  it('flags, over the committed definitions, exactly the nodes on the exception list', () => {
    // These are the money gate's copies of the live definitions. When a swap
    // lands and its fixture is refreshed, this fails until the exception it
    // ended is removed, which is the point.
    const flagged = COMMITTED.flatMap((f) => findValidationScripts(f.definition).map((h) => `${f.id}/${h.namespace}`))
    expect(flagged.sort()).toEqual(KNOWN_VALIDATION_SCRIPTS.map((e) => `${e.workflowId}/${e.namespace}`).sort())
  })
})

describe('the known exceptions', () => {
  it('each names the workflow, the step and the issue that ends it', () => {
    expect(KNOWN_VALIDATION_SCRIPTS.length).toBeGreaterThan(0)
    for (const e of KNOWN_VALIDATION_SCRIPTS) {
      expect(e.workflowId).toMatch(/^[0-9a-f-]{36}$/)
      expect(e.namespace).not.toBe('')
      expect(e.endedBy).toMatch(/^#\d+$/)
    }
  })
})

describe('checkValidationScripts', () => {
  it('reports a workflow with a validation script that is not a known exception', async () => {
    const rec = recordingNotify()
    const r = await checkValidationScripts({}, supabase, {
      readWorkflows: async () => [{ id: 'w1', name: 'RML GigFi', definition: gigfiV24.definition }],
      exceptions: NO_EXCEPTIONS,
      notify: rec.notify,
    })
    expect(r.newFindings.map((f) => `${f.workflowName}/${f.namespace}`)).toEqual(['RML GigFi/validate_bidding_and_state'])
    expect(rec.sent).toHaveLength(1)
    expect(rec.sent[0].join('\n')).toContain('RML GigFi / validate_bidding_and_state')
    expect(rec.remedies[0]).toBe(VALIDATION_SCRIPT_REMEDY)
    expect(r.alerted).toBe(true)
  })

  it('keeps a known exception in its findings but does not page on it', async () => {
    const rec = recordingNotify()
    const r = await checkValidationScripts({}, supabase, {
      readWorkflows: async () => [{ id: 'w1', name: 'Lead Economy', definition: gigfiV24.definition }],
      exceptions: [{ workflowId: 'w1', namespace: 'validate_bidding_and_state', label: 'Lead Economy', endedBy: '#2594' }],
      notify: rec.notify,
    })
    expect(r.findings).toHaveLength(1)
    expect(r.newFindings).toEqual([])
    expect(r.staleExceptions).toEqual([])
    expect(rec.sent).toEqual([[]])
    expect(r.alerted).toBe(false)
  })

  it('reports a known exception that matches nothing, naming the issue that ended it', async () => {
    const rec = recordingNotify()
    const r = await checkValidationScripts({}, supabase, {
      readWorkflows: async () => [{ id: 'w1', name: 'Lead Economy', definition: codeNode('return { ok: true }') }],
      exceptions: [{ workflowId: 'w1', namespace: 'validate_bidding_and_state', label: 'Lead Economy', endedBy: '#2594' }],
      notify: rec.notify,
    })
    expect(r.staleExceptions.map((e) => e.endedBy)).toEqual(['#2594'])
    expect(rec.sent[0]).toHaveLength(1)
    expect(rec.sent[0][0]).toContain('Lead Economy / validate_bidding_and_state')
    expect(rec.sent[0][0]).toContain('#2594')
    expect(r.alerted).toBe(true)
  })

  it('pages a failed read rather than reporting clean, and judges no exception stale', async () => {
    const rec = recordingNotify()
    const r = await checkValidationScripts({}, supabase, {
      readWorkflows: async () => { throw new Error('permission denied for table workflows') },
      exceptions: [{ workflowId: 'w1', namespace: 'validate_bidding_and_state', label: 'Lead Economy', endedBy: '#2594' }],
      notify: rec.notify,
    })
    expect(r.unreadable.join(' ')).toContain('permission denied')
    expect(r.staleExceptions).toEqual([])
    expect(rec.sent[0]).toHaveLength(1)
    expect(rec.sent[0][0]).toMatch(/could not run/)
    expect(r.alerted).toBe(true)
  })

  it('treats a read returning no workflows as nothing scanned, not as clean', async () => {
    const rec = recordingNotify()
    const r = await checkValidationScripts({}, supabase, { readWorkflows: async () => [], exceptions: KNOWN_VALIDATION_SCRIPTS, notify: rec.notify })
    expect(r.unreadable.join(' ')).toContain('no workflows were returned')
    expect(r.staleExceptions).toEqual([])
    expect(r.alerted).toBe(true)
  })

  it('sends an empty list on a clean run, which stands a standing page down', async () => {
    const rec = recordingNotify()
    const r = await checkValidationScripts({}, supabase, {
      readWorkflows: async () => [{ id: 'w1', name: 'Main Flow', definition: codeNode('return { ok: true }') }],
      exceptions: NO_EXCEPTIONS,
      notify: rec.notify,
    })
    expect(rec.sent).toEqual([[]])
    expect(r.alerted).toBe(false)
  })

  it('scans every workflow rather than stopping at the first finding', async () => {
    const script = `return { body: { status: 'rejected', reason: 'invalid name' } };`
    const r = await checkValidationScripts({}, supabase, {
      readWorkflows: async () => [
        { id: 'w1', name: 'A', definition: codeNode(script) },
        { id: 'w2', name: 'B', definition: codeNode(script) },
      ],
      exceptions: NO_EXCEPTIONS,
      notify: async () => {},
    })
    expect(r.newFindings.map((f) => f.workflowName)).toEqual(['A', 'B'])
  })
})

describe('endingOf', () => {
  const base = { findings: [], newFindings: [], staleExceptions: [], unreadable: [], alerted: false, scanned: 3 }

  it('is ok on a clean run', () => {
    expect(endingOf(base).outcome).toBe('ok')
  })

  it('is findings on a new script or a stale exception', () => {
    expect(endingOf({ ...base, newFindings: [{ workflowId: 'w', workflowName: 'A', namespace: 'n', nodeId: 'n', reasons: ['invalid name'] }] }).outcome).toBe('findings')
    expect(endingOf({ ...base, staleExceptions: [KNOWN_VALIDATION_SCRIPTS[0]] }).outcome).toBe('findings')
  })

  it('is unmeasured when the workflows could not be read', () => {
    expect(endingOf({ ...base, unreadable: ['the read failed'], scanned: 0 }).outcome).toBe('unmeasured')
  })
})
