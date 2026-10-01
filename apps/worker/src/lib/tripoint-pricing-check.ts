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
 * IT COMPARES THE MAIN FLOW RULE ONLY, DELIBERATELY, AND REPORTS THE ENGINE
 * RULE BESIDE IT. Engine leads are priced on a different basis, and that
 * difference is intended rather than drift: see
 * docs/adr/0010-engine-and-main-flow-price-tripoint-differently.md (#1178).
 * Since the buyer profiles shipped (#1413), Bidspoke holds Tripoint's Engine
 * price as pricing tiers for the `engine` population, read through the same
 * loader the buyer_select node uses, so each daily answer carries both rules
 * under their population names. The Engine rule is a note, never compared with
 * the Lead formula; a failure to read it is a finding, never "no tiers" (L98).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { notifyExportFailure, type TitledRemedy } from './export-alerts'
import { salesforceGet } from './salesforce-read'
import { resolveSalesforceCredentialOrg } from './salesforce-creds'
import {
  describeEngineTiers,
  parseTripointRevenueFormula,
  tripointPricingDifferences,
  underPopulation,
  type PricingDifference,
  type TripointRule,
} from './tripoint-pricing-drift'
import type { Env } from '../index'
import type { PricingTier } from '@bidspoke/buyer-profile'
import { loadBuyerProfiles } from './buyer-profile-loader'

export const TRIPOINT_PRICING_JOB = 'tripoint-pricing-drift'

/**
 * What the alert says (Dan, 2026-10-01: "It's so hard to understand right
 * now"). A plain title and one line per finding, nothing else. Two titles,
 * because a mismatch and a check that never compared need different things
 * done, and a title claiming a mismatch over a refusal would say something the
 * check did not measure (L11).
 */
export const TRIPOINT_PRICING_MISMATCH_REMEDY: TitledRemedy = {
  title: "Tripoint rates don't match Salesforce",
  fixHint:
    "Decide which rate is right. If it's Salesforce, change the rate in Bidspoke under Partners > Tripoint. " +
    "If it's Bidspoke, change the External Revenue formula on the Salesforce Lead.",
}

/** No fix line: the finding itself says what could not be read, and that is where to look. */
export const TRIPOINT_PRICING_UNREADABLE_REMEDY: TitledRemedy = {
  title: "Tripoint rate check couldn't run",
}

/** The differences that are a disagreement between two rules that were both read. Everything else is a refusal. */
const MISMATCH_CODES = new Set([
  'boundary-disagrees',
  'low-multiplier-disagrees',
  'high-multiplier-disagrees',
  'floor-disagrees',
])

/** Who last changed the Salesforce formula, as the alert's context line. */
export interface FormulaChange {
  /** Salesforce's LastModifiedDate. */
  at: string
  /** The editor's name, or null when it could not be read. */
  by: string | null
}

function changedLine(change: FormulaChange | null): string | undefined {
  if (!change) return undefined
  const when = new Date(change.at.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  if (Number.isNaN(when.getTime())) return undefined
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).format(when)
  return change.by
    ? `The Salesforce formula was last changed ${day} by ${change.by}.`
    : `The Salesforce formula was last changed ${day}.`
}

/** The Salesforce field whose formula books Main Flow Tripoint revenue. */
export const LEAD_REVENUE_FIELD = { object: 'Lead', developerName: 'ExternalRevenue' } as const

export interface TripointPricingCheckResult {
  /** The Salesforce Main Flow rule as read, or null when it could not be read or recognised. */
  salesforce: TripointRule | null
  /**
   * Tripoint's Engine tiers as the buyer_select node reads them: null when no
   * enabled profile holds them or they could not be read (the notes and
   * differences say which), never compared with `salesforce`.
   */
  engine_tiers: PricingTier[] | null
  /** Disagreements and refusals, each under its own code and population. Alerted. */
  differences: PricingDifference[]
  /** Standing facts about the rules, each under its population. Logged, never alerted. */
  notes: PricingDifference[]
  alerted: boolean
}

export interface TripointPricingDeps {
  /** Returns the formula text. Injected so the check is testable without Salesforce (L196). */
  readFormula?: () => Promise<string>
  /** Tripoint's enabled profile tiers, or null when no enabled profile exists. Injected for the same reason. */
  readEngineTiers?: () => Promise<PricingTier[] | null>
  /** When and by whom the formula last changed, for the alert's context line. Injected for the same reason. */
  readFormulaChange?: () => Promise<FormulaChange | null>
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
    return await runCheck(
      env,
      supabase,
      deps.readFormula ?? salesforceFormulaReader(env, supabase),
      deps.readEngineTiers ?? engineTiersReader(env, supabase),
      deps.readFormulaChange ?? formulaChangeReader(env, supabase),
    )
  } catch (err) {
    const detail = `The check itself failed: ${formatErr(err)}`
    console.error(`[tripoint-pricing] ${detail}`)
    await alertQuietly(supabase, env, [detail], TRIPOINT_PRICING_UNREADABLE_REMEDY)
    return { salesforce: null, engine_tiers: null, differences: [{ code: 'failed', message: detail }], notes: [], alerted: true }
  }
}

/**
 * Send the alert, and never let the alerter's own failure become the result.
 * AN EMPTY LIST IS STILL SENT: `notifyExportFailure` reads no errors as the
 * recovery signal and clears its alert state with it.
 */
async function alertQuietly(supabase: SupabaseClient, env: Env, messages: string[], remedy: TitledRemedy): Promise<void> {
  try {
    await notifyExportFailure(supabase, TRIPOINT_PRICING_JOB, messages, env.IDEMPOTENCY, remedy)
  } catch (err) {
    console.error('[tripoint-pricing] could not send its alert:', formatErr(err))
  }
}

async function finish(
  supabase: SupabaseClient,
  env: Env,
  result: Omit<TripointPricingCheckResult, 'alerted'>,
  readFormulaChange: () => Promise<FormulaChange | null>,
): Promise<TripointPricingCheckResult> {
  await alertQuietly(supabase, env, result.differences.map((d) => d.message), await remedyFor(result.differences, readFormulaChange))
  // Logged on every run including a clean one, so a working check is visible
  // from the outside rather than only heard from when it complains.
  const sf = result.salesforce
  const rule = sf ? `sf=${sf.lowBand.multiplier}/${sf.highBand.multiplier}@${sf.highBand.from}` : 'sf=unread'
  const engine = result.engine_tiers
    ? `engine=${result.engine_tiers.map((t) => `${t.debtFrom}-${t.debtTo ?? 'up'}@${t.multiplier}`).join(',')}`
    : 'engine=none'
  console.log(
    `[tripoint-pricing] ${rule} ${engine} differences=${result.differences.length} notes=${result.notes.map((n) => n.code).join(',')}`,
  )
  return { ...result, alerted: result.differences.length > 0 }
}

/**
 * The mismatch title when every difference is one, with who changed the
 * formula; the could not run title otherwise. A failed lookup of who changed it
 * drops only that line, never the alert.
 */
async function remedyFor(
  differences: PricingDifference[],
  readFormulaChange: () => Promise<FormulaChange | null>,
): Promise<TitledRemedy> {
  if (differences.length === 0 || !differences.every((d) => MISMATCH_CODES.has(d.code))) {
    return TRIPOINT_PRICING_UNREADABLE_REMEDY
  }
  let change: FormulaChange | null = null
  try {
    change = await readFormulaChange()
  } catch (err) {
    console.error('[tripoint-pricing] could not read who last changed the formula:', formatErr(err))
  }
  const context = changedLine(change)
  return context ? { ...TRIPOINT_PRICING_MISMATCH_REMEDY, context } : TRIPOINT_PRICING_MISMATCH_REMEDY
}

/**
 * The Main Flow half: the legacy config against the Lead formula. Its notes are
 * labelled Main Flow, because the Engine notes sit beside them. Its differences
 * are not: only this rule is ever compared, and they are the alert's lines.
 */
async function compareMainFlow(
  supabase: SupabaseClient,
  readFormula: () => Promise<string>,
): Promise<Pick<TripointPricingCheckResult, 'salesforce' | 'differences' | 'notes'>> {
  const mf = (d: PricingDifference) => underPopulation('main_flow', d)
  const { data, error } = await supabase
    .from('partner_configs')
    .select('bid_resolver_config')
    .eq('slug', 'tripoint')
    .maybeSingle()

  if (error) {
    return {
      salesforce: null,
      notes: [],
      differences: [{ code: 'config-unreadable', message: `The check couldn't read Bidspoke's Tripoint rates: ${formatErr(error)}` }],
    }
  }
  const cfg = (data as { bid_resolver_config?: unknown } | null)?.bid_resolver_config
  if (!cfg || typeof cfg !== 'object') {
    return {
      salesforce: null,
      notes: [],
      differences: [
        { code: 'config-missing', message: "Bidspoke has no Tripoint rates set, so there's nothing to compare." },
      ],
    }
  }

  let formula: string
  try {
    formula = await readFormula()
  } catch (err) {
    return {
      salesforce: null,
      notes: [],
      differences: [
        { code: 'formula-unreadable', message: `The check couldn't read the Salesforce formula: ${formatErr(err)}` },
      ],
    }
  }

  const rule = parseTripointRevenueFormula(formula)
  if (rule === null) {
    return {
      salesforce: null,
      notes: [],
      differences: [
        {
          code: 'formula-unrecognised',
          message: `The Salesforce formula has been rewritten in a form the check can't read. It now says: ${formula.replace(/\s+/g, ' ').slice(0, 300)}`,
        },
      ],
    }
  }

  const compared = tripointPricingDifferences(rule, cfg as Record<string, unknown>)
  return { salesforce: rule, differences: compared.differences, notes: compared.notes.map(mf) }
}

/** The Engine half: the buyer profile tiers, reported. A failed read is a difference, never an empty note. */
async function reportEngine(
  readEngineTiers: () => Promise<PricingTier[] | null>,
): Promise<{ engine_tiers: PricingTier[] | null; differences: PricingDifference[]; notes: PricingDifference[] }> {
  try {
    const tiers = await readEngineTiers()
    const engine_tiers = tiers === null ? null : tiers.filter((t) => t.population === 'engine')
    return { engine_tiers, differences: [], notes: [describeEngineTiers(tiers)] }
  } catch (err) {
    return {
      engine_tiers: null,
      notes: [],
      differences: [
        { code: 'engine-tiers-unreadable', message: `The check couldn't read Tripoint's Engine rates: ${formatErr(err)}` },
      ],
    }
  }
}

async function runCheck(
  env: Env,
  supabase: SupabaseClient,
  readFormula: () => Promise<string>,
  readEngineTiers: () => Promise<PricingTier[] | null>,
  readFormulaChange: () => Promise<FormulaChange | null>,
): Promise<TripointPricingCheckResult> {
  const mainFlow = await compareMainFlow(supabase, readFormula)
  const engine = await reportEngine(readEngineTiers)
  return finish(supabase, env, {
    salesforce: mainFlow.salesforce,
    engine_tiers: engine.engine_tiers,
    differences: [...mainFlow.differences, ...engine.differences],
    notes: [...mainFlow.notes, ...engine.notes],
  }, readFormulaChange)
}

/**
 * The real Engine tiers reader: Tripoint's enabled buyer profile through the one
 * loader the buyer_select node uses (the only sanctioned reader of the profile
 * tables), for the organization that holds the Salesforce credentials, which is
 * the one the formula is read for. Null when no enabled Tripoint profile exists.
 */
export function engineTiersReader(env: Env, supabase: SupabaseClient): () => Promise<PricingTier[] | null> {
  return async () => {
    const { orgId, error } = await resolveSalesforceCredentialOrg(supabase)
    if (!orgId) throw new Error(error ?? 'no_org_holds_salesforce_credentials')
    const snapshot = await loadBuyerProfiles(orgId, env.WORKFLOW_CACHE, supabase)
    const tripoint = snapshot.buyers.find((b) => b.partner.slug === 'tripoint')
    return tripoint ? [...tripoint.profile.tiers] : null
  }
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
    const soql =
      `SELECT Metadata FROM CustomField WHERE TableEnumOrId='${LEAD_REVENUE_FIELD.object}' ` +
      `AND DeveloperName='${LEAD_REVENUE_FIELD.developerName}'`
    const body = await salesforceGet<{ records?: Array<{ Metadata?: { formula?: unknown } }> }>(
      env,
      supabase,
      `tooling/query?q=${encodeURIComponent(soql)}`,
      'the Tripoint pricing check',
    )
    const formula = body.records?.[0]?.Metadata?.formula
    if (typeof formula !== 'string' || !formula.trim()) {
      throw new Error(
        `Tooling returned ${body.records?.length ?? 0} record(s) for ${LEAD_REVENUE_FIELD.object}.${LEAD_REVENUE_FIELD.developerName} and no formula text`,
      )
    }
    return formula
  }
}

/**
 * When the Lead formula last changed and who changed it, for the alert. Two
 * reads: Tooling for the field's LastModifiedById, the data API for that user's
 * name, since a Tooling CustomField cannot follow the LastModifiedBy
 * relationship. A name that cannot be read is null, so the line still gives the
 * day.
 */
export function formulaChangeReader(env: Env, supabase: SupabaseClient): () => Promise<FormulaChange | null> {
  return async () => {
    const soql =
      `SELECT LastModifiedDate, LastModifiedById FROM CustomField WHERE TableEnumOrId='${LEAD_REVENUE_FIELD.object}' ` +
      `AND DeveloperName='${LEAD_REVENUE_FIELD.developerName}'`
    const body = await salesforceGet<{ records?: Array<{ LastModifiedDate?: unknown; LastModifiedById?: unknown }> }>(
      env,
      supabase,
      `tooling/query?q=${encodeURIComponent(soql)}`,
      'the Tripoint pricing check',
    )
    const record = body.records?.[0]
    if (typeof record?.LastModifiedDate !== 'string') return null
    const userId = record.LastModifiedById
    let by: string | null = null
    if (typeof userId === 'string' && /^[A-Za-z0-9]{15,18}$/.test(userId)) {
      try {
        const user = await salesforceGet<{ records?: Array<{ Name?: unknown }> }>(
          env,
          supabase,
          `query?q=${encodeURIComponent(`SELECT Name FROM User WHERE Id='${userId}'`)}`,
          'the Tripoint pricing check',
        )
        const name = user.records?.[0]?.Name
        by = typeof name === 'string' && name.trim() ? name : null
      } catch (err) {
        console.error('[tripoint-pricing] could not read the name of whoever changed the formula:', formatErr(err))
      }
    }
    return { at: record.LastModifiedDate, by }
  }
}
