import { describe, expect, it } from 'vitest'
import { LEAD_REJECTION_REASONS, missingRejectionReasons } from '@bidspoke/workflow-definition'
import { committedDefinitions, definitionsIn, type CommittedDefinition } from './_committed-definitions'

/**
 * #2588, part of #935. LEAD_REJECTION_REASONS is append only, and it must hold
 * every reason a committed definition's validation step sends a partner, spelled
 * exactly. This fails when one is removed from the list (or a fixture refresh
 * brings in a reason nobody added).
 *
 * The validation step is the step at namespace `validate_bidding_and_state`,
 * which every bidding workflow uses for it today. A code step's reasons are read
 * from the script text: each `status: "rejected"` response must carry a literal
 * reason this can read, or the guard fails rather than counting an unread reason
 * as none (L564). A lead validation step's (RML GigFi since 2026-10-22, #2592)
 * are its checks' `reason`, and a check with an id but no reason is unread the same way.
 * Other steps that reject (the credit report, the trade body) send processing
 * outcomes, not validation reasons, and are not in the list.
 */

const VALIDATION_NAMESPACE = 'validate_bidding_and_state'
const REJECTED = /status\s*:\s*["']rejected["']/g
const REJECTED_WITH_REASON = /status\s*:\s*["']rejected["']\s*,\s*reason\s*:\s*["']([^"'\\]+)["']/g

interface StepReasons {
  file: string
  reasons: string[]
  /** Rejections whose reason is not a literal this can read. */
  unread: number
}

function validationReasons(def: CommittedDefinition): StepReasons[] {
  return def.nodes
    .filter((n) => n.namespace === VALIDATION_NAMESPACE && (n.type === 'code' || n.type === 'lead_validation'))
    .map((n) => {
      if (n.type === 'lead_validation') {
        // A check is one rejection: save validation gives every check an id. A
        // reduced copy that kept neither (the workflow values fixture) holds none,
        // as a reduced script holds no `status: "rejected"`.
        const all = Array.isArray(n.config?.checks) ? (n.config.checks as Array<{ id?: unknown; reason?: unknown }>) : []
        const checks = all.filter((c) => typeof c.id === 'string' || c.reason !== undefined)
        const reasons = checks.map((c) => c.reason).filter((r): r is string => typeof r === 'string')
        return { file: def.file, reasons, unread: checks.length - reasons.length }
      }
      const script = typeof n.config?.script === 'string' ? n.config.script : ''
      const reasons = [...script.matchAll(REJECTED_WITH_REASON)].map((m) => m[1])
      const rejections = [...script.matchAll(REJECTED)].length
      return { file: def.file, reasons, unread: rejections - reasons.length }
    })
}

describe('LEAD_REJECTION_REASONS covers every reason a committed validation step sends (#2588)', () => {
  const steps = committedDefinitions().flatMap(validationReasons)
  const used = steps.flatMap((s) => s.reasons)

  it('reads the validation steps of RML GigFi, RML LendSwift and Lead Economy, so a pass is not vacuous', () => {
    for (const id of ['6624acd0', 'e1b810da', '89b1a6af']) {
      const step = steps.find((s) => s.file.includes(`money-gate/fixtures/definitions/${id}`))
      expect(step?.reasons.length ?? 0, `${id} validation step not found or sends no reason`).toBeGreaterThan(0)
    }
  })

  it('every rejection in a validation step carries a literal reason this can read', () => {
    expect(steps.filter((s) => s.unread !== 0).map((s) => s.file)).toEqual([])
  })

  it('every reason used is in the list', () => {
    expect(missingRejectionReasons(used)).toEqual([])
  })

  it('fails when a used reason is removed from the list (the guard seen to fail)', () => {
    for (const reason of new Set(used)) {
      const without = LEAD_REJECTION_REASONS.filter((r) => r !== reason)
      expect(missingRejectionReasons(used, without)).toEqual([reason])
    }
  })

  it('reads a seeded lead validation step: the reason of each check, and a check with none as unread (positive control)', () => {
    const [seeded] = definitionsIn({ nodes: [{
      type: 'lead_validation',
      namespace: VALIDATION_NAMESPACE,
      config: { checks: [{ id: 'a', reason: 'brand new reason' }, { id: 'b' }] },
    }] }, 'seeded.json')
    const [step] = validationReasons(seeded)
    expect(step.reasons).toEqual(['brand new reason'])
    expect(step.unread).toBe(1)
  })

  it('reads a seeded step, and counts a rejection whose reason is not a literal as unread (positive control)', () => {
    const [seeded] = definitionsIn({ nodes: [{
      type: 'code',
      namespace: VALIDATION_NAMESPACE,
      config: { script: [
        'if (!a) return { response: { body: { status: "rejected", reason: "brand new reason" } } }',
        "if (!b) return { response: { body: { status: 'rejected', reason: REASON } } }",
      ].join('\n') },
    }] }, 'seeded.json')
    const [step] = validationReasons(seeded)
    expect(step.reasons).toEqual(['brand new reason'])
    expect(step.unread).toBe(1)
    expect(missingRejectionReasons(step.reasons)).toEqual(['brand new reason'])
  })
})
