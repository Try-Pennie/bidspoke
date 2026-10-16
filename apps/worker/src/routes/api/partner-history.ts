/**
 * GET /partners/:id/history (#2141, PR10 of #2114): the partners page History.
 *
 * Who may call: any allowlisted member of the organization (jwtAuth, mounted
 * under /api). Whose rows: one partner of the caller's organization. The Worker
 * is service_role, so RLS does not apply and every read scopes itself: the
 * partner and its matrix configs by organization_id, audit_log by
 * organization_id, bid_config_history by the config ids read under it.
 * partner_configs, partner_bid_configs and bid_config_history have no
 * deleted_at (a deleted config's history is deleted with it, ON DELETE
 * CASCADE). The one read not scoped to the organization is the editor names:
 * users by the ids this organization's rows carry, so a person later moved to
 * another organization still resolves (#2141).
 *
 * All or nothing (L530, L215, L11): the partner, the matrix configs, audit_log,
 * bid_config_history and users are read, and any one failing answers 500
 * naming that read. Never a partial merge, and never an editor with no name.
 * Each history read is bounded (readNewest in @bidspoke/partner-history), and a
 * source past its bound makes the answer say so (complete false), never
 * silently shorter.
 */
import { Hono, type Context } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { isNotFoundError } from '../../lib/api-error'
import { formatErr } from '../../lib/format-error'
import {
  HISTORY_AUDIT_ENTITY_TYPES,
  UnresolvedEditorError,
  auditEditor,
  editorLabel,
  matrixEditor,
  mergeHistory,
  readNewest,
  type HistoryEntityType,
  type HistoryEntry,
  type PartnerHistory,
  type UserName,
} from '@bidspoke/partner-history'

type Ctx = Context<{ Bindings: Env; Variables: AuthVariables }>

const partnerHistory = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

/** The reads, by the name an error carries. */
type HistoryRead = 'partner_configs' | 'partner_bid_configs' | 'audit_log' | 'bid_config_history' | 'users'

class ReadFailed extends Error {
  constructor(public readonly read: HistoryRead, cause: unknown) {
    super(formatErr(cause))
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Editor ids per request of the users read; ids go in the URL. */
const USERS_CHUNK = 100

interface AuditRow {
  id: string
  changed_at: string
  changed_by: string | null
  entity_type: string
  entity_id: string
  action: string
  changes: unknown
}

interface MatrixRow {
  id: string
  changed_at: string
  changed_by: string | null
  config_id: string
  source: string
  diff: unknown
}

function failed(c: Ctx, read: HistoryRead, err: unknown): Response {
  console.error(`[partner-history] ${read} read failed`, { error: formatErr(err) })
  return c.json({ error: 'history_unavailable', read, message: `History could not be loaded: the ${read} read failed.` }, 500)
}

async function attempt<T>(read: HistoryRead, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    throw err instanceof ReadFailed ? err : new ReadFailed(read, err)
  }
}

/**
 * The audit rows that belong to this partner. A row is tied to it by its own
 * key (partner settings, the buyer profile), by one of its matrix configs, or
 * by the partner_id its writer carried in changes: a config's create and delete
 * (#2141), a sub-account ID (the partner_uuid_map_audit trigger, and the
 * partner it was moved off), and a held click (subject.partner_id, or the
 * deleted claim's held_click.old.partner_id).
 */
function auditFilter(partnerId: string, configIds: string[]): string {
  return [
    `and(entity_type.in.(partner_config,buyer_profile),entity_id.eq.${partnerId})`,
    configIds.length > 0 ? `and(entity_type.eq.partner_bid_config,entity_id.in.(${configIds.join(',')}))` : null,
    `and(entity_type.eq.partner_bid_config,changes->>partner_id.eq.${partnerId})`,
    `and(entity_type.eq.partner_uuid,changes->>partner_id.eq.${partnerId})`,
    `and(entity_type.eq.partner_uuid,changes->>old_partner_id.eq.${partnerId})`,
    `and(entity_type.eq.held_click,changes->subject->>partner_id.eq.${partnerId})`,
    `and(entity_type.eq.held_click,changes->held_click->old->>partner_id.eq.${partnerId})`,
  ].filter((part): part is string => part !== null).join(',')
}

partnerHistory.get('/:id/history', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  // The id is spliced into a PostgREST filter below, so anything but a uuid is
  // refused before it can reach one.
  if (!UUID.test(id)) return c.json({ error: 'Partner not found' }, 404)
  const supabase = createSupabaseClient(c.env)

  const { data: partner, error: partnerError } = await supabase
    .from('partner_configs')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  if (partnerError && !isNotFoundError(partnerError)) return failed(c, 'partner_configs', partnerError)
  if (!partner) return c.json({ error: 'Partner not found' }, 404)

  try {
    const configs = await attempt('partner_bid_configs', async () => {
      const { data, error } = await supabase
        .from('partner_bid_configs')
        .select('id, name')
        .eq('partner_id', id)
        .eq('organization_id', orgId)
        .order('id', { ascending: true })
        .range(0, 999)
      if (error) throw new ReadFailed('partner_bid_configs', error.message)
      const rows = (data ?? []) as Array<{ id: string; name: string }>
      // A partner has a handful; a full page would mean the list was cut.
      if (rows.length >= 1000) throw new ReadFailed('partner_bid_configs', 'more than 999 matrix configs')
      return rows
    })
    const configIds = configs.map((r) => r.id)
    const configNames = new Map(configs.map((r) => [r.id, r.name]))

    const [audit, matrix] = await Promise.all([
      attempt('audit_log', () => readNewest<AuditRow>((from, to) => supabase
        .from('audit_log')
        .select('id, changed_at, changed_by, entity_type, entity_id, action, changes')
        .eq('organization_id', orgId)
        .in('entity_type', [...HISTORY_AUDIT_ENTITY_TYPES])
        .or(auditFilter(id, configIds))
        .order('changed_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to))),
      configIds.length === 0
        ? Promise.resolve({ rows: [] as MatrixRow[], truncated: false })
        : attempt('bid_config_history', () => readNewest<MatrixRow>((from, to) => supabase
          .from('bid_config_history')
          .select('id, changed_at, changed_by, config_id, source, diff')
          .in('config_id', configIds)
          .order('changed_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to))),
    ])

    const editorIds = [...new Set([...audit.rows, ...matrix.rows].map((r) => r.changed_by).filter((v): v is string => !!v))]
    const users = await attempt('users', async () => {
      const found = new Map<string, UserName>()
      for (let i = 0; i < editorIds.length; i += USERS_CHUNK) {
        const chunk = editorIds.slice(i, i + USERS_CHUNK)
        const { data, error } = await supabase.from('users').select('id, display_name, email').in('id', chunk)
        if (error) throw new ReadFailed('users', error.message)
        for (const u of (data ?? []) as UserName[]) found.set(u.id, u)
      }
      return found
    })

    let auditEntries: HistoryEntry[]
    let matrixEntries: HistoryEntry[]
    try {
      auditEntries = audit.rows.map((r) => {
        const editor = auditEditor(r, users)
        const configId = r.entity_type === 'partner_bid_config' ? r.entity_id : null
        return {
          key: `audit:${r.id}`,
          source: 'audit_log',
          at: r.changed_at,
          entityType: r.entity_type as HistoryEntityType,
          entityId: r.entity_id,
          action: r.action,
          editor,
          editorLabel: editorLabel(editor),
          changes: r.changes,
          matrix: configId ? { configId, configName: configNames.get(configId) ?? null, source: null } : null,
        }
      })
      matrixEntries = matrix.rows.map((r) => {
        const editor = matrixEditor(r, users)
        return {
          key: `matrix:${r.id}`,
          source: 'bid_config_history',
          at: r.changed_at,
          entityType: 'bid_matrix',
          entityId: r.config_id,
          action: 'synced',
          editor,
          editorLabel: editorLabel(editor),
          changes: r.diff,
          matrix: { configId: r.config_id, configName: configNames.get(r.config_id) ?? null, source: r.source },
        }
      })
    } catch (err) {
      if (err instanceof UnresolvedEditorError) throw new ReadFailed('users', err)
      throw err
    }

    const merged = mergeHistory([
      { entries: auditEntries, truncated: audit.truncated },
      { entries: matrixEntries, truncated: matrix.truncated },
    ])
    const body: PartnerHistory = { partnerId: id, ...merged }
    return c.json(body)
  } catch (err) {
    if (err instanceof ReadFailed) return failed(c, err.read, err.message)
    throw err
  }
})

export default partnerHistory
