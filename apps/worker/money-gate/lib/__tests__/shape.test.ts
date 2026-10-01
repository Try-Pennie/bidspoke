import { describe, it, expect } from 'vitest'
import { buildWorkflowShape, renderShapesFile, summarizeShapes, type ShapesFile } from '../shape'

// Every leaf value in these payloads is a token that must never reach the output.
// The guard is the whole point of the export (L222): it reads production trigger
// payloads, so a value that leaks through here lands in a committed file.
function leaves(v: unknown, out: Array<string | number> = []): Array<string | number> {
  if (Array.isArray(v)) v.forEach((x) => leaves(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => leaves(x, out))
  else if (typeof v === 'string' || typeof v === 'number') out.push(v)
  return out
}

function realisticLead(i: number) {
  return {
    leadUuid: `7f3c2a10-1b2c-4d5e-8f90-${String(100000000000 + i * 7919)}`,
    subAccountUuid: 'c0ffee00-aaaa-4bbb-8ccc-0123456789ab',
    personalInformation: {
      firstName: `Alexandra${i}`,
      lastName: 'Quillfeather',
      email: `aq${i}@corp-mail.net`,
      phone: `21255501${String(10 + i).slice(-2)}`,
      ssn: `5${String(10 + i).slice(-2)}-44-${String(1000 + i)}`,
      dateOfBirth: `198${i % 10}-0${(i % 9) + 1}-1${i % 10}`,
      state: i % 2 ? 'TX' : 'NY',
      address: { street: `${400 + i} Juniper Ridge Rd`, zip: `9${String(1000 + i)}` },
    },
    financialInformation: { annualIncome: 85000 + i * 13, creditScore: 640 + i, debt: [{ amount: 12000 + i * 3, kind: 'card' }] },
    loanInformation: { purpose: 'debt_consolidation', loanAmount: 25000 + i },
    flags: { military: false },
  }
}

describe('buildWorkflowShape', () => {
  const payloads = Array.from({ length: 20 }, (_, i) => realisticLead(i))
  const shape = buildWorkflowShape({ workflow_id: 'wf-1', workflow_name: 'WF', payloads })
  const file: ShapesFile = { version: 1, exported_at: '2026-10-01T00:00:00.000Z', workflows: [shape] }
  const text = renderShapesFile(file)

  it('emits no leaf value of any payload except an allowed small domain', () => {
    const allowedDomain = new Set(['TX', 'NY', 'debt_consolidation', 'card'])
    const leaked = [...new Set(payloads.flatMap((p) => leaves(p)))]
      .filter((v) => !allowedDomain.has(String(v)))
      .filter((v) => String(v).length >= 3 && text.includes(String(v)))
    expect(leaked).toEqual([])
  })

  it('records field paths, value classes and string formats', () => {
    expect(shape.sample_count).toBe(20)
    expect(shape.fields['personalInformation.email'].string?.format).toBe('email')
    expect(shape.fields['personalInformation.ssn'].string?.format).toBe('ssn_like')
    expect(shape.fields['personalInformation.dateOfBirth'].string?.format).toBe('iso_date')
    expect(shape.fields['financialInformation.creditScore'].classes).toEqual({ integer: 20 })
    expect(shape.fields['financialInformation.debt[].amount'].present).toBe(20)
    expect(shape.fields['flags.military'].classes).toEqual({ boolean: 20 })
  })

  it('keeps a small enumerated domain on a non identifying path (positive control)', () => {
    expect(shape.fields['personalInformation.state'].domain).toEqual(['NY', 'TX'])
    expect(shape.fields['loanInformation.purpose'].domain).toEqual(['debt_consolidation'])
  })

  it('never keeps a domain on an identifying path, however often a value repeats', () => {
    expect(shape.fields['personalInformation.lastName'].domain).toBeUndefined()
    expect(shape.fields['subAccountUuid'].domain).toBeUndefined()
  })

  it('never keeps a domain value seen in fewer than three samples', () => {
    const rare = buildWorkflowShape({
      workflow_id: 'wf-2', workflow_name: 'WF2',
      payloads: [{ tier: 'gold' }, { tier: 'gold' }, { tier: 'silver' }, { tier: 'silver' }, { tier: 'silver' }],
    })
    expect(rare.fields.tier.domain).toBeUndefined()
  })

  it('refuses a domain value carrying a digit run or an at sign', () => {
    const p = Array.from({ length: 6 }, () => ({ code: 'A1234', mail: 'x@y.co' }))
    const s = buildWorkflowShape({ workflow_id: 'w', workflow_name: 'w', payloads: p })
    expect(s.fields.code.domain).toBeUndefined()
    expect(s.fields.mail.domain).toBeUndefined()
  })
})

describe('summarizeShapes', () => {
  it('prints counts and paths only', () => {
    const payloads = Array.from({ length: 5 }, (_, i) => realisticLead(i))
    const shape = buildWorkflowShape({ workflow_id: 'wf-1', workflow_name: 'WF', payloads })
    const line = summarizeShapes({ version: 1, exported_at: 'x', workflows: [shape] })
    for (const v of payloads.flatMap((p) => leaves(p))) {
      if (String(v).length >= 3) expect(line).not.toContain(String(v))
    }
    expect(line).toContain('WF')
    expect(line).toContain('5 samples')
  })
})
