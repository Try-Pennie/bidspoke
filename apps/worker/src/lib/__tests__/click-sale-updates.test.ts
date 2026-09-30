/**
 * The one builder of a click sale's Salesforce updates (#1659), against the
 * Liberty1 click workflow's kept click_patch script it must agree with.
 *
 * The live click writes its Prospect, Submission and Lead bodies from the
 * canvas script; a held click a person marks sent writes them from
 * buildClickSaleUpdates. The two must be the same bodies, field for field and
 * in the same order, or a hand released sale reads differently in Salesforce
 * from a live one. The script cannot import TypeScript, so this test is what
 * holds them together, and the buyer's own words (its consent text and lead
 * sale type) are read OUT of the kept script rather than copied beside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEPT_LIBERTY1_CLICK_SCRIPTS, LIBERTY1_CLICK_WORKFLOW_ID } from '../engine-script-drift'
import { runCanvasScript } from '../../engine/scripts/__tests__/canvas-script'
import { buildClickSaleUpdates, clickScriptTerms, clickPatchScriptFor } from '../click-sale-updates'

const PATCH = KEPT_LIBERTY1_CLICK_SCRIPTS.find((s) => s.namespace === 'click_patch')!.script
const HELD_AT = '2026-09-30T14:03:02.000Z'
const LINK = 'https://bidspoke.trypennie.dev/workflows/wf-1?execution=exec-1'
const LEAD_ID = '00QUy00000gtlZBMAY'
// Liberty1's partner record, as read from partner_configs on 2026-09-30.
const PARTNER = { name: 'Liberty1', external_routing_code: 4 }

type Rec = Record<string, unknown>
async function scriptBodies(route: 'sent' | 'refused', partnerLeadId: string | null, link: string | null) {
  return (await runCanvasScript(PATCH, {
    payload: {},
    steps: { click_send: { output: { _route: route, reason: route, partner_lead_id: partnerLeadId } } },
    execution: link === null ? {} : { bidspoke_link: link },
  })) as { prospect: Rec; submission: Rec; lead: Rec }
}

function liberty1Terms() {
  const read = clickScriptTerms(PATCH)
  if (!read.ok) throw new Error(read.message)
  return { partnerName: PARTNER.name, routingCode: PARTNER.external_routing_code, ...read.terms }
}

describe('buildClickSaleUpdates against the kept Liberty1 click_patch script', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(HELD_AT))
  })
  afterEach(() => vi.useRealTimers())

  it('sent: the same three bodies, byte for byte, as the live click writes', async () => {
    const theirs = await scriptBodies('sent', LEAD_ID, LINK)
    const ours = buildClickSaleUpdates(liberty1Terms(), { exchangeStatus: 'Completed', partnerLeadId: LEAD_ID, timestamp: HELD_AT, runLink: LINK })
    expect(JSON.stringify(ours.prospect)).toBe(JSON.stringify(theirs.prospect))
    expect(JSON.stringify(ours.submission)).toBe(JSON.stringify(theirs.submission))
    expect(JSON.stringify(ours.lead)).toBe(JSON.stringify(theirs.lead))
  })

  it('refused: the same Fail bodies, with no partner lead id', async () => {
    const theirs = await scriptBodies('refused', null, LINK)
    const ours = buildClickSaleUpdates(liberty1Terms(), { exchangeStatus: 'Fail', partnerLeadId: null, timestamp: HELD_AT, runLink: LINK })
    expect(JSON.stringify(ours)).toBe(JSON.stringify({ prospect: theirs.prospect, submission: theirs.submission, lead: theirs.lead }))
  })

  it('no run link drops PDFlow_3__c rather than blanking it, as the script does', async () => {
    const theirs = await scriptBodies('sent', LEAD_ID, null)
    const ours = buildClickSaleUpdates(liberty1Terms(), { exchangeStatus: 'Completed', partnerLeadId: LEAD_ID, timestamp: HELD_AT, runLink: null })
    expect(JSON.stringify(ours.prospect)).toBe(JSON.stringify(theirs.prospect))
    expect(ours.prospect).not.toHaveProperty('PDFlow_3__c')
  })
})

describe('buildClickSaleUpdates for another buyer', () => {
  it('takes the partner name and routing code from the buyer, not from Liberty1', () => {
    const out = buildClickSaleUpdates(
      { partnerName: 'EvaFi', routingCode: 7, consentText: 'EvaFi consent', saleType: 'Form' },
      { exchangeStatus: 'Completed', partnerLeadId: 'X1', timestamp: HELD_AT, runLink: LINK },
    )
    expect(out.prospect).toMatchObject({ ExternalPartnerName__c: 'EvaFi', ExternalRoutingCode__c: 7, TCPA_Consent__c: 'EvaFi consent' })
    expect(out.submission).toMatchObject({ External_Partner_Name__c: 'EvaFi', External_Routing_Code__c: '7' })
    expect(out.lead).toMatchObject({ ExternalPartnerName__c: 'EvaFi', External_Routing_Code__c: '7', TCPAConsent__c: 'EvaFi consent' })
    expect(JSON.stringify(out)).not.toMatch(/Liberty1/)
  })
})

describe('clickScriptTerms', () => {
  it('reads the consent text and the lead sale type out of the kept Liberty1 script', () => {
    const read = clickScriptTerms(PATCH)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.terms.saleType).toBe('Form')
    expect(read.terms.consentText.startsWith('By clicking "Connect with Liberty1 Financial"')).toBe(true)
    expect(read.terms.consentText.endsWith('Text HELP for help or text STOP to cancel.')).toBe(true)
  })

  it('refuses by name a script whose consent is not a plain template literal, rather than writing a wrong consent', () => {
    const interpolated = PATCH.replace('Text HELP for help', '${"x"} Text HELP for help')
    const read = clickScriptTerms(interpolated)
    expect(read).toEqual({ ok: false, message: expect.stringMatching(/consent/i) })
  })

  it('refuses by name a script with no lead sale type', () => {
    const read = clickScriptTerms(PATCH.replace(/LeadSaleType__c: LEAD_SALE_TYPE,/g, ''))
    expect(read).toEqual({ ok: false, message: expect.stringMatching(/lead sale type/i) })
  })
})

describe('clickPatchScriptFor', () => {
  it('finds the kept click_patch script of the Liberty1 click workflow', () => {
    expect(clickPatchScriptFor(LIBERTY1_CLICK_WORKFLOW_ID)).toBe(PATCH)
  })

  it('answers null for a workflow with no kept click script, and for no workflow at all', () => {
    expect(clickPatchScriptFor('00000000-0000-4000-8000-000000000000')).toBeNull()
    expect(clickPatchScriptFor(null)).toBeNull()
  })
})
