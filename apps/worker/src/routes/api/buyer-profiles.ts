/**
 * Buyer profile routes (#1412, Phase 5), mounted under /partners beside the
 * partner routes:
 *
 *   GET  /partners/:id/buyer-profile          the document, the partner's accept rules, other sellers
 *   PUT  /partners/:id/buyer-profile          validate, save_buyer_profile, invalidate the cache
 *   GET  /partners/:id/buyer-profile/history  the audit rows for this profile
 *   GET  /partners/:id/buyer-usage            the ledger's counts for the current Eastern hour and day
 *
 * Every query filters organization_id explicitly: the Worker is service_role and
 * bypasses RLS. Any allowlisted member of the org may call these, the same as the
 * partner routes (the escalated decision on #1407).
 *
 * The save is versioned: a stale expected_version is a 409 carrying the CURRENT
 * document (L717), so the form can show both sides and never discards the
 * person's edits by instruction. Every other named refusal from the function
 * keeps its own status and name (L11).
 */
import { Hono, type Context } from 'hono'
import {
  documentToProfile,
  parseProfileDocument,
  validateProfile,
  WIRED_POPULATIONS,
  easternDayStartUtc,
  type Signal,
} from '@bidspoke/buyer-profile'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { dbError, dbErrorUnlessNotFound } from '../../lib/api-error'
import { refreshBuyerProfilesCache } from '../../lib/buyer-profile-loader'
import { BuyerLedgerClient } from '../../lib/buyer-object-clients'
import { workflowsUsingPartner } from '../../lib/partner-workflow-finder'
import type { Json } from '../../types/database'

const buyerProfiles = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

interface PartnerForProfile {
  id: string
  slug: string
  is_active: boolean
  accept_signals: unknown
  /** Read for the enabling refusals (#1416): a buyer sells nowhere without them. */
  click_url: string | null
  external_routing_code: number | null
}

/** The partner in this org, or the response that ends the request. */
async function loadPartner(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  supabase: ReturnType<typeof createSupabaseClient>,
  id: string,
  orgId: string
): Promise<{ partner: PartnerForProfile } | { response: Response }> {
  const { data, error } = await supabase
    .from('partner_configs')
    .select('id, slug, is_active, accept_signals, click_url, external_routing_code')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  const blocked = dbErrorUnlessNotFound(c, error)
  if (blocked) return { response: blocked }
  if (!data) return { response: c.json({ error: 'Partner not found' }, 404) }
  return { partner: data as unknown as PartnerForProfile }
}

const acceptSignalsOf = (partner: PartnerForProfile): Signal[] => (Array.isArray(partner.accept_signals) ? (partner.accept_signals as Signal[]) : [])

// ── Read ──────────────────────────────────────────────────────────────────────

buyerProfiles.get('/:id/buyer-profile', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const loaded = await loadPartner(c, supabase, id, orgId)
  if ('response' in loaded) return loaded.response

  const { data: document, error: docError } = await supabase.rpc('buyer_profile_document', { p_partner: id })
  if (docError) return dbError(c, docError)

  // Other sellers: live workflows whose bid_group or partner_bid nodes name this
  // partner. Buyer selection itself is not an OTHER seller, so buyer_select nodes
  // are left out; the caps panel names these because their wins are not counted (L582).
  const { data: workflows, error: wfError } = await supabase
    .from('workflows')
    .select('id, name, is_active, definition')
    .eq('organization_id', orgId)
    .is('deleted_at', null)
  if (wfError) return dbError(c, wfError)
  const finder = workflowsUsingPartner(
    (workflows ?? []) as Array<{ id: string; name: string; is_active: boolean | null; definition: unknown }>,
    new Map(),
    { includeBuyerSelect: false, liveOnly: true }
  )

  return c.json({
    profile: document ?? null,
    accept_signals: acceptSignalsOf(loaded.partner),
    other_sellers: finder(id),
  })
})

// ── Save ──────────────────────────────────────────────────────────────────────

interface SaveBody {
  expected_version?: unknown
  profile?: unknown
}

buyerProfiles.put('/:id/buyer-profile', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const loaded = await loadPartner(c, supabase, id, orgId)
  if ('response' in loaded) return loaded.response

  const body = await c.req.json<SaveBody>()
  if (typeof body.expected_version !== 'number' || !Number.isInteger(body.expected_version) || body.expected_version < 0) {
    return c.json({ error: 'expected_version_required', message: 'A save names the version it was edited from, so two people cannot overwrite each other unknowingly.' }, 400)
  }
  const parsed = parseProfileDocument(body.profile)
  if (!parsed.ok) return c.json({ error: 'profile_malformed', errors: parsed.errors }, 400)

  const profile = documentToProfile({ ...parsed.document, partner_id: id })
  const validation = validateProfile(profile, {
    acceptSignals: acceptSignalsOf(loaded.partner),
    clickUrl: loaded.partner.click_url ?? null,
    externalRoutingCode: typeof loaded.partner.external_routing_code === 'number' ? loaded.partner.external_routing_code : null,
  })
  if (!validation.ok) return c.json({ error: 'profile_invalid', errors: validation.errors }, 422)

  const { partner_id: _partner, version: _version, ...toSave } = parsed.document
  const { data, error } = await supabase.rpc('save_buyer_profile', {
    p_org: orgId,
    p_partner: id,
    p_expected_version: body.expected_version,
    p_profile: toSave as unknown as Json,
    p_actor: userId,
    p_actor_email: email,
  })
  if (error) {
    const detail = (error as { details?: string | null }).details ?? null
    if (error.code === 'BP409') {
      let current: unknown = null
      try {
        current = detail ? JSON.parse(detail) : null
      } catch {
        current = null
      }
      return c.json({ error: 'stale_version', current }, 409)
    }
    if (error.code === 'BP422') return c.json({ error: error.message, detail }, 422)
    if (error.code === 'P0002') return c.json({ error: 'Partner not found' }, 404) // db-guard-ok: P0002 is the function's own named refusal for no such partner in this org, raised after the lookup, never a transport or query error
    return dbError(c, error)
  }

  // Rebuild the snapshot now, so the next lead is served warm (#1492).
  await refreshBuyerProfilesCache(orgId, c.env.WORKFLOW_CACHE, supabase)
  return c.json({ profile: data })
})

// ── History ───────────────────────────────────────────────────────────────────

buyerProfiles.get('/:id/buyer-profile/history', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const loaded = await loadPartner(c, supabase, id, orgId)
  if ('response' in loaded) return loaded.response

  const { data, error } = await supabase
    .from('audit_log')
    .select('changed_at, changed_by, action, changes')
    .eq('organization_id', orgId)
    .eq('entity_type', 'buyer_profile')
    .eq('entity_id', id)
    .order('changed_at', { ascending: false })
    .limit(200)
  if (error) return dbError(c, error)
  return c.json({ entries: data ?? [] })
})

// ── Usage ─────────────────────────────────────────────────────────────────────

buyerProfiles.get('/:id/buyer-usage', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const loaded = await loadPartner(c, supabase, id, orgId)
  if ('response' in loaded) return loaded.response

  // The ledger is the authority the caps refuse from, so the panel reads the
  // same counted() the refusal uses (L16). A ledger that does not answer is a
  // 503, never a zero (L633).
  const ledger = new BuyerLedgerClient(c.env.BUYER_LEDGER, id)
  let summary
  let counts
  try {
    ;[summary, counts] = await Promise.all([ledger.summary('live'), ledger.peek('live')])
  } catch (err) {
    console.error(`[buyer-usage] ledger unavailable for partner ${id}: ${err instanceof Error ? err.message : 'non Error thrown'}`)
    return c.json({ error: 'usage_unavailable', message: 'The buyer ledger did not answer, so the counts cannot be shown.' }, 503)
  }

  // Wins recorded for this buyer today by anything other than buyer selection:
  // Main Flow's Bid Group, for one. Those are not counted against these caps,
  // and the panel says so with the number (L582, L287). Bounded on the partition
  // key (attempted_at_utc) to the Eastern day.
  const unmeasured: string[] = []
  let outsideWins: number | null = null
  const dayStart = easternDayStartUtc(summary.et_day)
  const nextDayStart = easternDayStartUtc(nextIsoDate(summary.et_day))
  const { count, error: countError } = await supabase
    .from('lead_sighting_bids')
    .select('id', { count: 'exact', head: true })
    .eq('partner_slug', loaded.partner.slug)
    .eq('is_winner', true)
    .neq('resolver_type', 'buyer_select')
    .gte('attempted_at_utc', new Date(dayStart).toISOString())
    .lt('attempted_at_utc', new Date(nextDayStart).toISOString())
  if (countError || typeof count !== 'number') {
    console.error(`[buyer-usage] outside wins count failed for ${loaded.partner.slug}: ${countError?.message ?? 'no count returned'}`)
    unmeasured.push('outside_wins_today')
  } else {
    outsideWins = count
  }

  return c.json({
    et_day: summary.et_day,
    hour_bucket: counts.hour_bucket,
    hour: { leads: counts.hour_leads, spend_cents: counts.hour_spend_cents },
    day: { leads: counts.day_leads, spend_cents: counts.day_spend_cents, by_status: summary.by_status },
    counted_populations: [...WIRED_POPULATIONS],
    outside_wins_today: outsideWins,
    unmeasured,
  })
})

function nextIsoDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

export default buyerProfiles
