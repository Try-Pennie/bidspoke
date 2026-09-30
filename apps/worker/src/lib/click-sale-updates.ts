/**
 * What a click sale writes to Salesforce (#1659): the Prospect__c, Submission__c
 * and Lead update bodies, built in ONE place for every path that is not the
 * canvas.
 *
 * The live click writes these from the click workflow's click_patch code node
 * (engine/scripts/liberty1-click/liberty1_click_patch.js, the kept copy of the
 * canvas script). A held click a person marks sent writes them from here. A
 * canvas script cannot import TypeScript, so the two are held together by a
 * test (lib/__tests__/click-sale-updates.test.ts) that runs the kept script and
 * requires these bodies byte for byte, and the drift check already holds the
 * kept script to the canvas.
 *
 * WHERE EACH PART COMES FROM.
 *
 *   partner name, routing code   the buyer's partner record (partner_configs
 *                                name and external_routing_code), so the next
 *                                click buyer (EvaFi) needs no code here.
 *   consent text, lead sale type the buyer's OWN click_patch script, read out of
 *                                its kept copy (clickScriptTerms). The consent
 *                                is Liberty1's legal disclosure, the words on
 *                                the button the person pressed; it belongs to
 *                                that buyer's click flow and exists once, in its
 *                                script. Copying it into this file or into a
 *                                database column would make a second copy that
 *                                nothing keeps equal to what the live click
 *                                writes, so a legal text could drift apart on
 *                                two paths for one sale. Reading the kept script
 *                                means an edit to the canvas consent reaches
 *                                this path through the same drift check and PR
 *                                that update the kept file. The sale type sits
 *                                beside it in the same script for the same
 *                                reason.
 *   timestamp, lead id, link      the event: the caller's.
 *
 * Field names and order are the script's, which are Brian's.
 */
import { KEPT_CANVAS_WORKFLOWS } from './engine-script-drift'

export type ClickExchangeStatus = 'Completed' | 'Fail'

export interface ClickSaleTerms {
  partnerName: string
  /** A Number on the Prospect, text on the Submission and the Lead. */
  routingCode: number
  consentText: string
  saleType: string
}

export interface ClickSaleEvent {
  exchangeStatus: ClickExchangeStatus
  /** The buyer's lead id; written only with Completed, as the script does. */
  partnerLeadId: string | null
  /** ISO 8601, written as ExternalTimestamp__c / External_Timestamp__c. */
  timestamp: string
  /** The Bidspoke run link for PDFlow_3__c; null drops the field. */
  runLink: string | null
}

export interface ClickSaleUpdates {
  prospect: Record<string, unknown>
  submission: Record<string, unknown>
  lead: Record<string, unknown>
}

/** Undefined values are dropped so nothing is blanked, exactly as the script does. */
function dropUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
}

export function buildClickSaleUpdates(terms: ClickSaleTerms, event: ClickSaleEvent): ClickSaleUpdates {
  const status = event.exchangeStatus
  const partnerLeadId = status === 'Completed' && event.partnerLeadId ? event.partnerLeadId : undefined
  const link = event.runLink || undefined
  const code = String(terms.routingCode)
  return {
    prospect: dropUndefined({
      ExternalExchangeStatus__c: status,
      ExternalPartnerLeadId__c: partnerLeadId,
      ExternalPartnerName__c: terms.partnerName,
      ExternalRoutingCode__c: terms.routingCode,
      TCPA_Consent__c: terms.consentText,
      ExternalTimestamp__c: event.timestamp,
      PDFlow_3__c: link,
      LeadSaleType__c: terms.saleType,
    }),
    submission: dropUndefined({
      External_Exchange_Status__c: status,
      External_Partner_Lead_Id__c: partnerLeadId,
      External_Partner_Name__c: terms.partnerName,
      External_Routing_Code__c: code,
      External_TCPA_Consent__c: terms.consentText,
      External_Timestamp__c: event.timestamp,
      PDFlow_3__c: link,
      LeadSaleType__c: terms.saleType,
    }),
    lead: dropUndefined({
      External_Exchange_Status__c: status,
      ExternalPartnerLeadId__c: partnerLeadId,
      ExternalPartnerName__c: terms.partnerName,
      External_Routing_Code__c: code,
      TCPAConsent__c: terms.consentText,
      External_Timestamp__c: event.timestamp,
      LeadSaleType__c: terms.saleType,
    }),
  }
}

/** The namespace of a click workflow's Salesforce body node, in the Liberty1 workflow and every clone of it. */
export const CLICK_PATCH_NAMESPACE = 'click_patch'

/** The kept click_patch script of a click workflow, or null when Bidspoke keeps none for it. */
export function clickPatchScriptFor(workflowId: string | null): string | null {
  if (!workflowId) return null
  const kept = KEPT_CANVAS_WORKFLOWS.find((w) => w.workflowId === workflowId)
  return kept?.scripts.find((s) => s.namespace === CLICK_PATCH_NAMESPACE)?.script ?? null
}

export type ClickScriptTermsRead =
  | { ok: true; terms: Pick<ClickSaleTerms, 'consentText' | 'saleType'> }
  | { ok: false; message: string }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The consent text and lead sale type a click_patch script writes, read from
 * the constants its Prospect body names (`TCPA_Consent__c: X`, `LeadSaleType__c: Y`).
 *
 * Refuses by name anything it cannot read exactly: a consent that is not one
 * plain template literal (an interpolation would be evaluated on the canvas and
 * not here), or a sale type that is not one double quoted string. A refusal
 * writes nothing, which is better than writing a consent the person never saw.
 */
export function clickScriptTerms(script: string): ClickScriptTermsRead {
  const consentName = /\bTCPA_Consent__c:\s*([A-Za-z_$][\w$]*)\s*,/.exec(script)?.[1]
  if (!consentName) return { ok: false, message: 'the click script names no consent constant on the Prospect (TCPA_Consent__c)' }
  const consent = new RegExp(`\\bconst\\s+${escape(consentName)}\\s*=\\s*\`([^\`]*)\`\\s*;`).exec(script)?.[1]
  if (consent === undefined || consent.includes('${') || consent.includes('\\')) {
    return { ok: false, message: `the click script's consent text ${consentName} is not one plain template literal, so it cannot be read outside the canvas` }
  }

  const saleName = /\bLeadSaleType__c:\s*([A-Za-z_$][\w$]*)\s*,/.exec(script)?.[1]
  if (!saleName) return { ok: false, message: 'the click script names no lead sale type constant (LeadSaleType__c)' }
  const sale = new RegExp(`\\bconst\\s+${escape(saleName)}\\s*=\\s*"([^"\\\\]*)"\\s*;`).exec(script)?.[1]
  if (sale === undefined) return { ok: false, message: `the click script's lead sale type ${saleName} is not one plain double quoted string` }

  return { ok: true, terms: { consentText: consent, saleType: sale } }
}
