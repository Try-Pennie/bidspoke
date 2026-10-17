/**
 * The partners page live channel (#2135, PR4 of #2114): one shape for the
 * notice the database sends, read by the Worker's delivery monitor and by the
 * page, and the two Worker answers the page's versions probe uses.
 *
 * The notice is sent by notify_partner_page (supabase/migrations/
 * 20261016170000_partner_page_notice_2135.sql) as a private Realtime broadcast,
 * event `partner_changed`, on `partners:<organization id>`. It carries ids,
 * versions, column names and whether the change had no actor, never a field
 * value: a page refetches through the Worker to see what changed.
 */

export const PARTNER_PAGE_NOTICE_EVENT = 'partner_changed'

/** The private topic of one organization's partners page notices. */
export function partnerPageTopic(organizationId: string): string {
  return `partners:${organizationId}`
}

/**
 * What a notice is about:
 *  - partner: a partner_configs UPDATE that moved its version;
 *  - profile: the buyer profile or one of its child tables;
 *  - uuids: a sub-account ID mapping (partner_uuid_map has no version, so the
 *    notice carries the current pair);
 *  - created, deleted: the partner itself came or went;
 *  - page: one page save, sent once at its end with its save_id and client_id;
 *  - monitor: the delivery monitor's ping to its synthetic organization.
 */
export const NOTICE_KINDS = ['partner', 'profile', 'uuids', 'created', 'deleted', 'page', 'monitor'] as const
export type NoticeKind = (typeof NOTICE_KINDS)[number]

export interface PartnerPageNotice {
  partnerId: string
  /** Null once the partner is gone. */
  partnerVersion: number | null
  /** Null when the partner has no buyer profile. */
  profileVersion: number | null
  /** The save press that made the change, when one did. */
  saveId: string | null
  /** The browser tab that pressed save, for a page save that named one. */
  clientId: string | null
  kind: NoticeKind
  /** The partner columns (or, for a profile, the table) the change touched; null for a create, delete or ping. */
  changedColumns: string[] | null
  /** True when no actor made the change: a hand run SQL write. */
  direct: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const isVersion = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isKind = (v: unknown): v is NoticeKind => typeof v === 'string' && (NOTICE_KINDS as readonly string[]).includes(v)

/** A notice payload as the database sent it, or null for anything else (never a guess). */
export function parsePartnerPageNotice(payload: unknown): PartnerPageNotice | null {
  if (!isRecord(payload)) return null
  const p = payload
  if (!isUuid(p.partner_id) || !isKind(p.kind) || typeof p.direct !== 'boolean') return null
  if (p.partner_version !== null && !isVersion(p.partner_version)) return null
  if (p.profile_version !== null && !isVersion(p.profile_version)) return null
  if (p.save_id !== null && !isUuid(p.save_id)) return null
  if (p.client_id !== null && !isUuid(p.client_id)) return null
  let changedColumns: string[] | null = null
  if (p.changed_columns !== null) {
    if (!Array.isArray(p.changed_columns) || !p.changed_columns.every((c): c is string => typeof c === 'string')) return null
    changedColumns = p.changed_columns
  }
  return {
    partnerId: p.partner_id,
    partnerVersion: p.partner_version,
    profileVersion: p.profile_version,
    saveId: p.save_id,
    clientId: p.client_id,
    kind: p.kind,
    changedColumns,
    direct: p.direct,
  }
}

// ── The versions probe ───────────────────────────────────────────────────────

/** The newest audit row of one half of the page, as GET /api/partners/:id/versions reports it. */
export interface PartnerPageChange {
  /** ISO time the change was recorded (audit_log.changed_at). Format it through dates.ts on the page. */
  changedAt: string
  /** True when it had no actor: a hand run SQL write (audit_log `_source: direct_sql`). */
  direct: boolean
  /**
   * What it touched: partner_configs column names for the partner half; for the
   * profile half, the profile paths an editor's save changed, or the table a
   * hand write touched.
   */
  fields: string[]
}

/**
 * GET /api/partners/:id/versions: what the page polls every 60 seconds while a
 * draft is dirty, and reads on open and every refetch for the "Changed directly
 * in the database" notice.
 */
export interface PartnerPageVersions {
  partnerId: string
  partnerVersion: number
  /** 0 when the partner has no buyer profile, as save_partner_page counts it. */
  profileVersion: number
  lastSaveId: string | null
  profileLastSaveId: string | null
  /** The newest change to either half, or null when neither has an audit row. */
  latestChange: (PartnerPageChange & { section: 'partner' | 'profile' }) | null
  /** The newest audit row of each half. A direct one younger than BIDDING_PICKUP is the notice the page shows. */
  newest: { partner: PartnerPageChange | null; profile: PartnerPageChange | null }
}

// ── A live miss ──────────────────────────────────────────────────────────────

/**
 * Why a page missed live notices. For a change its probe found: `direct_sql`
 * when the change had no actor, `delivery` otherwise. The database sender does notify a
 * hand run SQL write, so under it both are misses of the channel.
 * `missing_partition` (#2288): the page's join was refused because the day's
 * realtime.messages partition did not exist yet, so it could hear nothing at
 * all; reported once per outage, with nothing observed.
 */
export const LIVE_MISS_CAUSES = ['delivery', 'direct_sql', 'missing_partition'] as const
export type LiveMissCause = (typeof LIVE_MISS_CAUSES)[number]

export interface VersionPair {
  partnerVersion: number | null
  profileVersion: number | null
}

/** The body of POST /api/partners/live-miss as a page sends it (snake case on the wire). */
export interface LiveMissReportBody {
  partner_id: string
  cause: LiveMissCause
  noticed: { partner_version: number | null; profile_version: number | null }
  observed: { partner_version: number | null; profile_version: number | null }
  since_last_notice_ms: number | null
}

/** A live miss report as the Worker reads it. */
export interface LiveMissReport {
  partnerId: string
  cause: LiveMissCause
  /** The last versions the page heard of while its header said Live, or held when its join was refused. */
  noticed: VersionPair
  /** The versions the probe found; both null for a refused join, when no probe ran. */
  observed: VersionPair
  /** How long the page had heard no notice; null when it never heard one. */
  sinceLastNoticeMs: number | null
}

/** The longest gap a report may carry: a day. A larger one is a clock fault, not a measurement. */
export const MAX_REPORTED_GAP_MS = 86_400_000

function versionPair(v: unknown): VersionPair | null {
  if (!isRecord(v)) return null
  const partner = v.partner_version ?? null
  const profile = v.profile_version ?? null
  if (partner !== null && !isVersion(partner)) return null
  if (profile !== null && !isVersion(profile)) return null
  return { partnerVersion: partner, profileVersion: profile }
}

/** The body of a live miss report (snake case on the wire), or the first field it refuses. */
export function parseLiveMissReport(body: unknown): { ok: true; report: LiveMissReport } | { ok: false; field: string } {
  if (!isRecord(body)) return { ok: false, field: 'body' }
  if (!isUuid(body.partner_id)) return { ok: false, field: 'partner_id' }
  const cause = body.cause
  if (typeof cause !== 'string' || !(LIVE_MISS_CAUSES as readonly string[]).includes(cause)) return { ok: false, field: 'cause' }
  const noticed = versionPair(body.noticed)
  if (!noticed) return { ok: false, field: 'noticed' }
  const observed = versionPair(body.observed)
  if (!observed) return { ok: false, field: 'observed' }
  const gap = body.since_last_notice_ms ?? null
  if (gap !== null && !(typeof gap === 'number' && Number.isInteger(gap) && gap >= 0 && gap <= MAX_REPORTED_GAP_MS)) {
    return { ok: false, field: 'since_last_notice_ms' }
  }
  return { ok: true, report: { partnerId: body.partner_id, cause: cause as LiveMissCause, noticed, observed, sinceLastNoticeMs: gap } }
}
