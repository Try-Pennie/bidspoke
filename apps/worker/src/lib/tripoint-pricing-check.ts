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
 *
 * IT ALSO COMPARES THE THREE SALESFORCE FORMULAS WITH EACH OTHER (#1419). The
 * Lead, Submission and Prospect formulas each carry their own copy of every
 * partner's rates, and on 2026-09-30 the Lead copy priced Tripoint at 0.0012
 * from $12,500 while the other two used 0.0013. All three are read through the
 * one Tooling reader below, the Lead text is the one the Bidspoke comparison
 * uses, and any partner whose bands or rates differ between them is its own
 * finding beside the Bidspoke one (`revenue-formula.ts`). A formula that cannot
 * be read is a finding too, named for its object, and reported once.
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
import { compareRevenueFormulas, type FormulaRead } from './revenue-formula'
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

/** The Salesforce formulas disagreeing with each other, and nothing else. */
export const REVENUE_FORMULAS_DISAGREE_REMEDY: TitledRemedy = {
  title: "Salesforce formulas don't agree on partner rates",
  fixHint: 'Decide which rate is right, then change the other formulas in Salesforce to match.',
}

/** Both kinds of disagreement at once, as on 2026-09-30: one title, both fixes. */
export const PARTNER_RATES_MISMATCH_REMEDY: TitledRemedy = {
  title: "Partner rates don't match",
  fixHint:
    'Decide which rate is right. Change Bidspoke under Partners > Tripoint, or the External Revenue formula on the Salesforce Lead, ' +
    'and change the other formulas in Salesforce to match.',
}

/** No fix line: the finding itself says what could not be read, and that is where to look. */
export const TRIPOINT_PRICING_UNREADABLE_REMEDY: TitledRemedy = {
  title: "Tripoint rate check couldn't run",
}

/**
 * The differences that are a disagreement between Bidspoke and the Lead
 * formula, both read. With FORMULA_MISMATCH_CODES, everything else is a refusal.
 */
const MISMATCH_CODES = new Set([
  'boundary-disagrees',
  'low-multiplier-disagrees',
  'high-multiplier-disagrees',
  'floor-disagrees',
])

/** A disagreement between Salesforce formulas that were all read. */
const FORMULA_MISMATCH_CODES = new Set(['formulas-disagree'])

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
  // Only the Lead formula's change is read (formulaChangeReader), so it is named (#835).
  return change.by
    ? `The Salesforce ${LEAD_REVENUE_FIELD.label} formula was last changed ${day} by ${change.by}.`
    : `The Salesforce ${LEAD_REVENUE_FIELD.label} formula was last changed ${day}.`
}

/** A Salesforce formula field: the label people call it by, its object's API name, and its developer name. */
export interface RevenueFormulaField {
  label: 'Lead' | 'Submission' | 'Prospect'
  object: string
  developerName: string
}

/**
 * The three formulas that book partner revenue, each with its own copy of every
 * partner's rates (#1419). The Lead is first because it is the one that books
 * Main Flow Tripoint revenue, and so the one compared with Bidspoke.
 */
export const REVENUE_FORMULA_FIELDS: readonly RevenueFormulaField[] = [
  { label: 'Lead', object: 'Lead', developerName: 'ExternalRevenue' },
  { label: 'Submission', object: 'Submission__c', developerName: 'ExternalRevenue' },
  { label: 'Prospect', object: 'Prospect__c', developerName: 'ExternalExchangeRevenue' },
]

/** The Salesforce field whose formula books Main Flow Tripoint revenue. */
export const LEAD_REVENUE_FIELD = REVENUE_FORMULA_FIELDS[0]

/**
 * The Tooling filter for one field. By the entity's API name, because a custom
 * object's TableEnumOrId is its id: `TableEnumOrId='Submission__c'` answered no
 * records on 2026-10-02, which would read as a missing field.
 */
function fieldFilter(field: RevenueFormulaField): string {
  return `EntityDefinition.QualifiedApiName='${field.object}' AND DeveloperName='${field.developerName}'`
}

export interface TripointPricingCheckResult {
  /** The Salesforce Main Flow rule as read, or null when it could not be read or recognised. */
  salesforce: TripointRule | null
  /**
   * Tripoint's Engine tiers as the buyer_select node reads them: null when no
   * enabled profile holds them or they could not be read (the notes and
   * differences say which), never compared with `salesforce`.
   */
  engine_tiers: PricingTier[] | null
  /** The Salesforce formulas that were read, by label. One missing here has its own finding. */
  formulas_read: string[]
  /** Disagreements and refusals, each under its own code and population. Alerted. */
  differences: PricingDifference[]
  /** Standing facts about the rules, each under its population. Logged, never alerted. */
  notes: PricingDifference[]
  alerted: boolean
}

export interface TripointPricingDeps {
  /** Returns one field's formula text. Injected so the check is testable without Salesforce (L196). */
  readFormula?: (field: RevenueFormulaField) => Promise<string>
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
      deps.readFormula ?? ((field) => salesforceFormulaReader(env, supabase, field)()),
      deps.readEngineTiers ?? engineTiersReader(env, supabase),
      deps.readFormulaChange ?? formulaChangeReader(env, supabase),
    )
  } catch (err) {
    const detail = `The check itself failed: ${formatErr(err)}`
    console.error(`[tripoint-pricing] ${detail}`)
    await alertQuietly(supabase, env, [detail], TRIPOINT_PRICING_UNREADABLE_REMEDY)
    return {
      salesforce: null,
      engine_tiers: null,
      formulas_read: [],
      differences: [{ code: 'failed', message: detail }],
      notes: [],
      alerted: true,
    }
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
    `[tripoint-pricing] ${rule} ${engine} formulas=${result.formulas_read.join('+') || 'none'} differences=${result.differences.length} notes=${result.notes.map((n) => n.code).join(',')}`,
  )
  return { ...result, alerted: result.differences.length > 0 }
}

/**
 * The mismatch title when any difference is one, with who changed the formula,
 * and saying so when another part could not be read; the could not run title
 * only when nothing was compared. A failed lookup of who changed it drops only
 * that line, never the alert.
 */
async function remedyFor(
  differences: PricingDifference[],
  readFormulaChange: () => Promise<FormulaChange | null>,
): Promise<TitledRemedy> {
  const isMismatch = (d: PricingDifference) => MISMATCH_CODES.has(d.code)
  const isFormulaMismatch = (d: PricingDifference) => FORMULA_MISMATCH_CODES.has(d.code)
  if (differences.length === 0 || !differences.some((d) => isMismatch(d) || isFormulaMismatch(d))) {
    return TRIPOINT_PRICING_UNREADABLE_REMEDY
  }
  // A mismatch the check did measure is the title even when another part could
  // not be read (#835): "couldn't run" over a real disagreement hid it. The
  // title then says both, so it claims nothing the lines do not.
  const partRefused = differences.some((d) => !isMismatch(d) && !isFormulaMismatch(d))
  const withRefusal = (r: TitledRemedy): TitledRemedy => (partRefused ? { ...r, title: `${r.title}, and part of the check couldn't run` } : r)
  if (!differences.some(isMismatch)) return withRefusal(REVENUE_FORMULAS_DISAGREE_REMEDY)
  const base = withRefusal(differences.some(isFormulaMismatch) ? PARTNER_RATES_MISMATCH_REMEDY : TRIPOINT_PRICING_MISMATCH_REMEDY)
  let change: FormulaChange | null = null
  try {
    change = await readFormulaChange()
  } catch (err) {
    console.error('[tripoint-pricing] could not read who last changed the formula:', formatErr(err))
  }
  const context = changedLine(change)
  return context ? { ...base, context } : base
}

/**
 * The Main Flow half: the legacy config against the Lead formula. Its notes are
 * labelled Main Flow, because the Engine notes sit beside them. Its differences
 * are not: only this rule is ever compared with Bidspoke, and they are the
 * alert's lines. A Lead formula the cross formula comparison has already
 * reported as unreadable is not reported a second time here (L605).
 */
async function compareMainFlow(
  supabase: SupabaseClient,
  lead: FormulaRead,
  leadAlreadyReported: boolean,
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

  // An unread Lead formula is already a finding of the cross formula comparison.
  if ('error' in lead) return { salesforce: null, notes: [], differences: [] }

  const rule = parseTripointRevenueFormula(lead.formula)
  if (rule === null) {
    if (leadAlreadyReported) return { salesforce: null, notes: [], differences: [] }
    return {
      salesforce: null,
      notes: [],
      differences: [
        {
          code: 'formula-unrecognised',
          object: lead.object,
          partner: 'Tripoint',
          message: `The Salesforce Lead formula prices Tripoint in a form the check can't compare with Bidspoke. It now says: ${lead.formula.replace(/\s+/g, ' ').slice(0, 300)}`,
        },
      ],
    }
  }

  const compared = tripointPricingDifferences(rule, cfg as Record<string, unknown>)
  return { salesforce: rule, differences: compared.differences, notes: compared.notes.map(mf) }
}

/**
 * Each formula's text, or why it could not be read. One read per field, and
 * a failure stays with its own field, so one 403 cannot hide the other two.
 */
async function readAllFormulas(readFormula: (field: RevenueFormulaField) => Promise<string>): Promise<FormulaRead[]> {
  return Promise.all(
    REVENUE_FORMULA_FIELDS.map(async (field): Promise<FormulaRead> => {
      try {
        return { object: field.label, formula: await readFormula(field) }
      } catch (err) {
        return { object: field.label, error: formatErr(err) }
      }
    }),
  )
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
  readFormula: (field: RevenueFormulaField) => Promise<string>,
  readEngineTiers: () => Promise<PricingTier[] | null>,
  readFormulaChange: () => Promise<FormulaChange | null>,
): Promise<TripointPricingCheckResult> {
  const reads = await readAllFormulas(readFormula)
  const formulas = compareRevenueFormulas(reads)
  const lead = reads[0]
  const leadAlreadyReported = formulas.differences.some(
    (d) =>
      d.object === lead.object &&
      (d.code === 'formula-unreadable' ||
        d.code === 'formula-unrecognised' ||
        (d.code === 'branch-unrecognised' && d.partner === 'Tripoint')),
  )
  const mainFlow = await compareMainFlow(supabase, lead, leadAlreadyReported)
  const engine = await reportEngine(readEngineTiers)
  return finish(supabase, env, {
    salesforce: mainFlow.salesforce,
    engine_tiers: engine.engine_tiers,
    formulas_read: reads.filter((r) => 'formula' in r).map((r) => r.object),
    differences: [...mainFlow.differences, ...formulas.differences, ...engine.differences],
    notes: [...mainFlow.notes, ...formulas.notes, ...engine.notes],
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
 * The real reader: the Tooling API's `CustomField.Metadata.formula` for one
 * field, through the one credential resolver (#1174) and the cached
 * per-organization token. All three revenue formulas are read through this.
 *
 * Tooling, not the data API, because the data API can return the field's VALUE
 * on a record but never the rule that produced it. A non-2xx answer THROWS with
 * the status and body, so a connected app without Tooling access shows up as
 * `formula-unreadable` naming the 403, rather than as agreement.
 */
export function salesforceFormulaReader(
  env: Env,
  supabase: SupabaseClient,
  field: RevenueFormulaField = LEAD_REVENUE_FIELD,
): () => Promise<string> {
  return async () => {
    const soql = `SELECT Metadata FROM CustomField WHERE ${fieldFilter(field)}`
    const body = await salesforceGet<{ records?: Array<{ Metadata?: { formula?: unknown } }> }>(
      env,
      supabase,
      `tooling/query?q=${encodeURIComponent(soql)}`,
      'the Tripoint pricing check',
    )
    const formula = body.records?.[0]?.Metadata?.formula
    if (typeof formula !== 'string' || !formula.trim()) {
      throw new Error(
        `Tooling returned ${body.records?.length ?? 0} record(s) for ${field.object}.${field.developerName} and no formula text`,
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
    const soql = `SELECT LastModifiedDate, LastModifiedById FROM CustomField WHERE ${fieldFilter(LEAD_REVENUE_FIELD)}`
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
