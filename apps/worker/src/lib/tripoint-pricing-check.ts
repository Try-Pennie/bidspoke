/**
 * Reading the Salesforce Tripoint revenue formula back and comparing it with
 * Bidspoke's Tripoint price, daily (#1166).
 *
 * The decision is in `tripoint-pricing-drift.ts` and is pure. This is the half
 * that goes and asks: the partner config out of Postgres, the formula text out of
 * Salesforce's Tooling API.
 *
 * WHY A SCHEDULED CHECK. Both numbers are settings that a person edits by hand,
 * in two different products, and neither product knows the other exists. On
 * 2026-06-11 the Salesforce side moved to 0.0012 and Bidspoke went on bidding
 * 0.0013 for three months; nothing could have said so except a comparison, and
 * a value whose effect is on money is asserted on a schedule rather than audited
 * at change time (L502).
 *
 * A FAILED READ IS ITS OWN FINDING, never silence. A formula that could not be
 * fetched, or that has changed into a shape this cannot read, has not been
 * compared, and answering "no differences" there would make a broken check and
 * agreement the same output (L98, L11).
 *
 * IT COMPARES THE MAIN FLOW RULE ONLY, DELIBERATELY. The Engine Bidding
 * Workflow prices the same partner on a different basis (a lookup table in its
 * own patch_prospect_body code node, booking through
 * Prospect__c.ExternalExchangeRevenue__c), and that difference is intended
 * rather than drift: see docs/adr/0010-engine-and-main-flow-price-tripoint-differently.md
 * (#1178). This check is silent about the Engine rule because Bidspoke holds no
 * copy of it to compare against.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { parseJson } from './json'
import { getSalesforceToken } from '../engine/nodes/salesforce'
import { requireSalesforceCreds, resolveSalesforceCredentialOrg } from './salesforce-creds'
import {
  parseTripointRevenueFormula,
  tripointPricingDifferences,
  type PricingDifference,
  type TripointRule,
} from './tripoint-pricing-drift'
import type { Env } from '../index'

export const TRIPOINT_PRICING_JOB = 'tripoint-pricing-drift'

/**
 * What the alert says, in the vocabulary of the place the reader will act
 * (L399). The shared alerter's default sentences are about exported rows and
 * Snowflake, and this check has neither: it compares two settings. True for
 * every line this check can send, because each line names which case it is.
 */
export const TRIPOINT_PRICING_REMEDY: AlertRemedy = {
  consequence:
    "Bidspoke's Tripoint price and the Salesforce revenue formula were compared and either disagree or " +
    'could not be compared. This is about two settings, not data: nothing was sent anywhere and nothing is missing. ' +
    'The lines below say which case this is:',
  fixHint:
    'A multiplier or boundary that disagrees: open Partners, Tripoint, and set the tier-based multiplier to what ' +
    'the Salesforce formula books, or have the formula changed, whichever is the wrong one. A formula that could ' +
    'not be read or recognised: the check itself needs attention (the Worker\'s Salesforce credentials, its Tooling ' +
    'API access, or a rewritten formula); run POST /api/admin/tripoint-pricing-check to see the current answer.',
  /**
   * A comparison of two settings that RAN has not failed (#1210), and this one
   * says so itself, in the words 'nothing was sent anywhere and nothing is
   * missing'.
   *
   * Deliberately not 'found a price that disagrees': this alert also carries the
   * case where the two could not be compared at all, and a verb claiming a
   * disagreement would be a statement the check did not measure (L11).
   */
  headlineVerb: 'has findings',
  itemNoun: { one: 'finding', many: 'findings' },
}

/** The Salesforce field whose formula books Main Flow Tripoint revenue. */
export const LEAD_REVENUE_FIELD = { object: 'Lead', developerName: 'ExternalRevenue' } as const

export interface TripointPricingCheckResult {
  /** The Salesforce rule as read, or null when it could not be read or recognised. */
  salesforce: TripointRule | null
  /** Disagreements and refusals, each under its own code. Alerted. */
  differences: PricingDifference[]
  /** Standing facts about the two rules. Logged, never alerted. */
  notes: PricingDifference[]
  alerted: boolean
}

export interface TripointPricingDeps {
  /** Returns the formula text. Injected so the check is testable without Salesforce (L196). */
  readFormula?: () => Promise<string>
}

/**
 * NEVER THROWS. It reports, including about itself: its caller is a `waitUntil`
 * where a rejection reaches only a console nobody is watching (L71).
 */
export async function checkTripointPricing(
  env: Env,
  supabase: SupabaseClient,
  deps: TripointPricingDeps = {},
): Promise<TripointPricingCheckResult> {
  try {
    return await runCheck(env, supabase, deps.readFormula ?? salesforceFormulaReader(env, supabase))
  } catch (err) {
    const detail = `the Tripoint pricing check itself failed: ${formatErr(err)}`
    console.error(`[tripoint-pricing] ${detail}`)
    await alertQuietly(supabase, env, [detail])
    return { salesforce: null, differences: [{ code: 'failed', message: detail }], notes: [], alerted: true }
  }
}

/**
 * Send the alert, and never let the alerter's own failure become the result.
 * AN EMPTY LIST IS STILL SENT: `notifyExportFailure` reads no errors as the
 * recovery signal and clears its alert state with it.
 */
async function alertQuietly(supabase: SupabaseClient, env: Env, messages: string[]): Promise<void> {
  try {
    await notifyExportFailure(supabase, TRIPOINT_PRICING_JOB, messages, env.IDEMPOTENCY, TRIPOINT_PRICING_REMEDY)
  } catch (err) {
    console.error('[tripoint-pricing] could not send its alert:', formatErr(err))
  }
}

async function finish(
  supabase: SupabaseClient,
  env: Env,
  result: Omit<TripointPricingCheckResult, 'alerted'>,
): Promise<TripointPricingCheckResult> {
  await alertQuietly(supabase, env, result.differences.map((d) => d.message))
  // Logged on every run including a clean one, so a working check is visible
  // from the outside rather than only heard from when it complains.
  const sf = result.salesforce
  const rule = sf ? `sf=${sf.lowBand.multiplier}/${sf.highBand.multiplier}@${sf.highBand.from}` : 'sf=unread'
  console.log(
    `[tripoint-pricing] ${rule} differences=${result.differences.length} notes=${result.notes.map((n) => n.code).join(',')}`,
  )
  return { ...result, alerted: result.differences.length > 0 }
}

async function runCheck(
  env: Env,
  supabase: SupabaseClient,
  readFormula: () => Promise<string>,
): Promise<TripointPricingCheckResult> {
  const { data, error } = await supabase
    .from('partner_configs')
    .select('bid_resolver_config')
    .eq('slug', 'tripoint')
    .maybeSingle()

  if (error) {
    return finish(supabase, env, {
      salesforce: null,
      notes: [],
      differences: [
        { code: 'config-unreadable', message: `the Tripoint partner config could not be read: ${formatErr(error)}` },
      ],
    })
  }
  const cfg = (data as { bid_resolver_config?: unknown } | null)?.bid_resolver_config
  if (!cfg || typeof cfg !== 'object') {
    return finish(supabase, env, {
      salesforce: null,
      notes: [],
      differences: [
        {
          code: 'config-missing',
          message: 'no partner_configs row has slug tripoint with a bid_resolver_config, so there is no Bidspoke price to compare',
        },
      ],
    })
  }

  let formula: string
  try {
    formula = await readFormula()
  } catch (err) {
    return finish(supabase, env, {
      salesforce: null,
      notes: [],
      differences: [
        {
          code: 'formula-unreadable',
          message: `the Salesforce formula behind ${LEAD_REVENUE_FIELD.object}.${LEAD_REVENUE_FIELD.developerName}__c could not be read: ${formatErr(err)}`,
        },
      ],
    })
  }

  const rule = parseTripointRevenueFormula(formula)
  if (rule === null) {
    return finish(supabase, env, {
      salesforce: null,
      notes: [],
      differences: [
        {
          code: 'formula-unrecognised',
          message:
            `the Salesforce formula behind ${LEAD_REVENUE_FIELD.object}.${LEAD_REVENUE_FIELD.developerName}__c no longer has ` +
            `the two-band shape this check reads, so Bidspoke's price was NOT compared. It reads: ${formula.replace(/\s+/g, ' ').slice(0, 300)}`,
        },
      ],
    })
  }

  const compared = tripointPricingDifferences(rule, cfg as Record<string, unknown>)
  return finish(supabase, env, { salesforce: rule, differences: compared.differences, notes: compared.notes })
}

/**
 * The real reader: the Tooling API's `CustomField.Metadata.formula`, through the
 * one credential resolver (#1174) and the cached per-organization token.
 *
 * Tooling, not the data API, because the data API can return the field's VALUE
 * on a record but never the rule that produced it. A non-2xx answer THROWS with
 * the status and body, so a connected app without Tooling access shows up as
 * `formula-unreadable` naming the 403, rather than as agreement.
 */
export function salesforceFormulaReader(env: Env, supabase: SupabaseClient): () => Promise<string> {
  return async () => {
    const { orgId, error } = await resolveSalesforceCredentialOrg(supabase)
    if (!orgId) throw new Error(error ?? 'no_org_holds_salesforce_credentials')
    const { instanceUrl, clientId, clientSecret } = await requireSalesforceCreds(
      env,
      supabase,
      orgId,
      'the Tripoint pricing check',
    )
    const token = await getSalesforceToken(env, orgId, instanceUrl, clientId, clientSecret)

    const soql =
      `SELECT Metadata FROM CustomField WHERE TableEnumOrId='${LEAD_REVENUE_FIELD.object}' ` +
      `AND DeveloperName='${LEAD_REVENUE_FIELD.developerName}'`
    const res = await fetch(`${instanceUrl}/services/data/v60.0/tooling/query?q=${encodeURIComponent(soql)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Tooling query failed (${res.status}): ${text.slice(0, 500)}`)
    }
    const body = await parseJson<{ records?: Array<{ Metadata?: { formula?: unknown } }> }>(res)
    const formula = body.records?.[0]?.Metadata?.formula
    if (typeof formula !== 'string' || !formula.trim()) {
      throw new Error(
        `Tooling returned ${body.records?.length ?? 0} record(s) for ${LEAD_REVENUE_FIELD.object}.${LEAD_REVENUE_FIELD.developerName} and no formula text`,
      )
    }
    return formula
  }
}
