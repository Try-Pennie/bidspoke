/**
 * The partner delete that knows up front (#2140, PM-13), mounted under
 * /partners beside the partner routes:
 *
 *   GET    /partners/:id/delete-check   what a delete would remove, what refuses
 *                                       it, and the workflows it would leave
 *                                       without the partner (lib/partner-delete.ts)
 *   DELETE /partners/:id                the delete, as reviewed: the body carries
 *                                       the check's fingerprint, and
 *                                       delete_partner_config refuses when the
 *                                       consequence moved since (BP024)
 *
 * Who may call them: any signed in, allowlisted member of the organization (the
 * jwtAuth middleware on /api), as every partner route. Whose data: the caller's
 * organization only. The Worker is service_role, so every read scopes itself:
 * both RPCs take p_org and refuse another organization's partner (P0002, a 404
 * here), the sub-account ids are read by org_id and slug, the workflows through
 * readOrgWorkflows (organization, not soft deleted), and the buyer ledger is the
 * object of a partner id the RPC has just found in this organization.
 *
 * A failed part of the check is a failed check (503, "Could not check whether
 * this partner can be deleted. Try again."), never an empty list (L530). A
 * committed delete is never an error: its stored copies are cleared inside
 * copyCleared (stored_copy_warning), and the state kept outside Postgres under
 * the slug (today's cap object, the circuit breaker) is reset after it, with
 * its own warning when that fails (state_reset_warning, L11).
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { dbError, dbErrorUnlessNotFound } from '../../lib/api-error'
import { fetchAllPaged } from '../../lib/paginate'
import { isUuid } from '../../lib/query-validators'
import { readOrgWorkflows } from '../../lib/org-workflows'
import { loadBuyerProfiles } from '../../lib/buyer-profile-loader'
import { pricedPartnersByPopulation } from '../../lib/priced-partners'
import { BuyerLedgerClient } from '../../lib/buyer-object-clients'
import { CircuitBreakerClient } from '../../lib/circuit-breaker-client'
import { dailyCapObjectName } from '../../lib/daily-cap-name'
import { invalidatePartnerConstantsCache } from '../../lib/partner-constants-loader'
import { retirePartnerLastGood } from '../../lib/partner-last-good'
import { copyCleared, copyWarning } from '../../lib/stored-copy'
import { parseFingerprint, PartnerNotFoundError, runDeleteCheck, type PartnerDeleteCheck, type PartnerDeleted, type PartnerDeleteRefused } from '../../lib/partner-delete'
import { rebuildBuyerProfiles } from './partners'

type AppContext = Context<{ Bindings: Env; Variables: AuthVariables }>

const partnerDelete = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

export const DELETE_CHECK_FAILED_MESSAGE = 'Could not check whether this partner can be deleted. Try again.'
export const CONSEQUENCE_CHANGED_MESSAGE = 'What this delete would remove changed since it was shown. Nothing was deleted. Review it again below.'
/** The page words the blockers itself, from the check the refusal carries; this is for a refusal whose check could not be read again. */
export const BLOCKED_MESSAGE = 'Nothing was deleted: sales or held clicks now refer to this partner.'

/**
 * The check for one partner of the caller's organization. Throws on any failed
 * part; answers null when the partner is not in this organization.
 */
async function deleteCheck(c: AppContext, id: string): Promise<PartnerDeleteCheck | null> {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  try {
    return await runDeleteCheck({
      check: async () => {
        const { data, error } = await supabase.rpc('partner_delete_check', { p_org: orgId, p_id: id })
        if (error?.code === 'P0002') throw new PartnerNotFoundError(id) // db-guard-ok: P0002 is the function's own named refusal for no such partner in this org, never a transport or query error
        if (error) throw new Error(`partner_delete_check: ${error.message}`)
        return data
      },
      subAccountIds: async (slug) =>
        (
          await fetchAllPaged<{ uuid: string }>(
            (from, to) => supabase.from('partner_uuid_map').select('uuid').eq('org_id', orgId).eq('partner_slug', slug).order('id', { ascending: true }).range(from, to),
            `sub-account ids of partner ${slug}`,
            { maxPages: 20 }
          )
        ).map((r) => r.uuid),
      workflows: () => readOrgWorkflows(supabase, orgId),
      pricedPartners: (workflows) => pricedPartnersByPopulation(workflows, () => loadBuyerProfiles(orgId, c.env.WORKFLOW_CACHE, supabase)),
      ledger: () => ledgerCounts(c.env, id),
    })
  } catch (err) {
    if (err instanceof PartnerNotFoundError) return null
    throw err
  }
}

/**
 * The buyer ledger's counts for a partner (L38): sales it holds that are not yet
 * written to buyer_sales, and sales waiting on a person. Asked of every partner,
 * buyer or not, because a partner switched to a source keeps whatever its ledger
 * still holds. An unreadable ledger throws: it is a failed check, never a zero.
 */
async function ledgerCounts(env: Env, partnerId: string): Promise<{ unmirrored: number; unresolved: number }> {
  const ledger = new BuyerLedgerClient(env.BUYER_LEDGER, partnerId)
  const [unmirrored, unresolved] = await Promise.all([ledger.unmirrored(), ledger.unresolved()])
  if (!Array.isArray(unmirrored?.entries) || !Array.isArray(unresolved)) throw new Error(`the buyer ledger of partner ${partnerId} answered in an unexpected shape`)
  return { unmirrored: unmirrored.entries.length, unresolved: unresolved.length }
}

function logCheckFailure(id: string, err: unknown): void {
  console.error(`[partner-delete] the delete check of partner ${id} failed: ${err instanceof Error ? err.message : 'unknown error'}`)
}

partnerDelete.get('/:id/delete-check', async (c) => {
  const id = c.req.param('id')
  // An id that is no uuid names no partner (Postgres would refuse it as invalid
  // uuid text, which would read as a failed check).
  if (!isUuid(id)) return c.json({ error: 'Partner not found' }, 404)
  let check: PartnerDeleteCheck | null
  try {
    check = await deleteCheck(c, id)
  } catch (err) {
    logCheckFailure(id, err)
    return c.json({ error: DELETE_CHECK_FAILED_MESSAGE }, 503)
  }
  if (!check) return c.json({ error: 'Partner not found' }, 404)
  return c.json(check)
})

/** The check again, for a refusal to carry; null when it cannot be read, which the page shows as a failed check. */
async function checkAgain(c: AppContext, id: string): Promise<PartnerDeleteCheck | null> {
  try {
    return await deleteCheck(c, id)
  } catch (err) {
    logCheckFailure(id, err)
    return null
  }
}

partnerDelete.delete('/:id', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'Partner not found' }, 404)
  const supabase = createSupabaseClient(c.env)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    body = null
  }
  const fingerprint = parseFingerprint((body as { fingerprint?: unknown } | null)?.fingerprint)
  if (!fingerprint) {
    // A page opened before #2140 sends no fingerprint. It cannot have reviewed
    // the consequence, so it is refused rather than deleting unreviewed.
    return c.json({ error: 'This page was opened before an update to how partners are deleted, so nothing was deleted. Reload the page and review the delete again.' }, 400)
  }

  const { data: partner, error: readError } = await supabase.from('partner_configs').select('id, name, slug').eq('id', id).eq('organization_id', orgId).single()
  const blocked = dbErrorUnlessNotFound(c, readError)
  if (blocked) return blocked
  if (!partner) return c.json({ error: 'Partner not found' }, 404)
  const { name, slug } = partner

  // The ledger again, right before the delete: a sale the ledger took after the
  // check is not in buyer_sales yet, so the database would not refuse it.
  let ledger
  try {
    ledger = await ledgerCounts(c.env, id)
  } catch (err) {
    logCheckFailure(id, err)
    return c.json({ error: DELETE_CHECK_FAILED_MESSAGE }, 503)
  }
  if (ledger.unmirrored > 0 || ledger.unresolved > 0) {
    const check = await checkAgain(c, id)
    const refused: PartnerDeleteRefused = { error: 'blocked', message: BLOCKED_MESSAGE, check }
    return c.json(refused, 409)
  }

  const { error } = await supabase.rpc('delete_partner_config', {
    p_org: orgId,
    p_id: id,
    p_actor: userId,
    p_actor_email: email,
    p_expected: fingerprint,
  })
  if (error) {
    if (error.code === 'P0002') return c.json({ error: 'Partner not found' }, 404) // db-guard-ok: P0002 is the function's own named refusal for no such partner in this org, raised after its locked read, never a transport or query error
    if (error.code === 'BP023' || error.code === 'BP024') {
      // A sale that landed after the check (BP023), or a consequence that moved
      // (BP024): nothing was deleted, and the box shows the check as it is now.
      const check = await checkAgain(c, id)
      const refused: PartnerDeleteRefused =
        error.code === 'BP023'
          ? { error: 'blocked', message: BLOCKED_MESSAGE, check }
          : { error: 'consequence_changed', message: CONSEQUENCE_CHANGED_MESSAGE, check }
      return c.json(refused, 409)
    }
    if (error.code === 'BP422') return c.json({ error: 'This page sent a delete the database could not read, so nothing was deleted. Reload the page and try again.' }, 400) // db-guard-ok: BP422 is the function's own named refusal of a malformed fingerprint
    return dbError(c, error)
  }

  // Committed. Nothing below may turn it into an error (L33).
  // A deleted partner must never bid from its stored copy in an outage (#1846):
  // first, and never throws. Then the constants and profile copies, each inside
  // copyCleared, all run whatever the others did.
  const retired = await copyCleared(() => retirePartnerLastGood(c.env.WORKFLOW_CACHE, id), `partner copy ${id}`)
  const constantsCleared = await copyCleared(() => invalidatePartnerConstantsCache(orgId, c.env.WORKFLOW_CACHE), `partner constants of org ${orgId}`)
  const profilesRebuilt = await copyCleared(() => rebuildBuyerProfiles(orgId, c.env.WORKFLOW_CACHE, supabase), `buyer profiles of org ${orgId}`)

  // State kept outside Postgres under the slug (L38): a partner created again
  // with this slug today would otherwise inherit today's lead count and the
  // breaker's state. The Worker secret is left: another partner may name it.
  const notReset: string[] = []
  try {
    const stub = c.env.DAILY_CAP.get(c.env.DAILY_CAP.idFromName(dailyCapObjectName(slug, Date.now()).name))
    const res = await stub.fetch('http://do/reset', { method: 'POST' })
    if (!res.ok) throw new Error(`the cap object answered ${res.status}`)
  } catch (err) {
    console.error(`[partner-delete] today's lead count of ${slug} was not reset after its delete: ${err instanceof Error ? err.message : 'unknown error'}`)
    notReset.push("today's lead count")
  }
  try {
    await new CircuitBreakerClient(c.env, slug).reset()
  } catch (err) {
    console.error(`[partner-delete] the error breaker of ${slug} was not reset after its delete: ${err instanceof Error ? err.message : 'unknown error'}`)
    notReset.push('the error breaker')
  }

  const answer: PartnerDeleted = {
    ok: true,
    ...copyWarning(retired && constantsCleared && profilesRebuilt),
    ...(notReset.length > 0 ? { state_reset_warning: stateResetWarning(name, slug, notReset) } : {}),
  }
  return c.json(answer)
})

/** The warning for state kept under the slug that a delete could not reset: what was not reset, and who inherits it. */
export function stateResetWarning(name: string, slug: string, notReset: readonly string[]): string {
  const what = notReset.length === 1 ? notReset[0] : `${notReset.slice(0, -1).join(', ')} and ${notReset[notReset.length - 1]}`
  return `${name} was deleted, but ${what} kept under the slug ${slug} could not be reset. A partner created again with the slug ${slug} today would start with ${notReset.length === 1 ? 'it' : 'them'}.`
}

export default partnerDelete
