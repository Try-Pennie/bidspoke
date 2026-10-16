/**
 * The partners page live channel's fixture answers (#2135), apart from the
 * router in partner-fixtures.ts so the Worker's contract test can import them:
 * pure, no file or Playwright access.
 */
import type { PartnerPageVersions } from '@bidspoke/partner-page-live'

/** The id the live miss route answers with; the route records the miss under it. */
export const LIVE_MISS_ID = '00000000-0000-4000-8000-00000000a135'

/**
 * GET /api/partners/:id/versions for a captured partner: its version and last
 * press as captured, its profile's version (0 with none, as the route counts
 * it), and no audit row, so no change made outside the page is noted.
 */
export function versionsFor(
  row: { id: string; version?: unknown; last_save_id?: unknown },
  buyerProfiles: Readonly<Record<string, { profile: unknown }>>,
): PartnerPageVersions {
  const profile = buyerProfiles[row.id]?.profile as { version?: number } | null | undefined
  return {
    partnerId: row.id,
    partnerVersion: typeof row.version === 'number' ? row.version : 0,
    profileVersion: profile?.version ?? 0,
    lastSaveId: typeof row.last_save_id === 'string' ? row.last_save_id : null,
    profileLastSaveId: null,
    latestChange: null,
    newest: { partner: null, profile: null },
  }
}

/**
 * The replies a Supabase Realtime server gives to one text frame of the page's
 * socket (Phoenix serializer 2.0.0: [join_ref, ref, topic, event, payload]),
 * so the live channel joins without reaching production: a join, a heartbeat,
 * a token refresh or a leave is answered ok. A join to any topic but the
 * partners page's is answered with nothing, and named for the caller to record.
 */
export function realtimeReplies(frame: string): { replies: string[]; unexpected: string | null } {
  let msg: unknown
  try { msg = JSON.parse(frame) } catch { return { replies: [], unexpected: null } }
  if (!Array.isArray(msg) || msg.length !== 5) return { replies: [], unexpected: null }
  const [joinRef, ref, topic, event] = msg as [string | null, string | null, string, string, unknown]
  const reply = (response: Record<string, unknown>) => JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response }])
  if (event === 'phx_join') {
    if (!/^realtime:partners:[0-9a-f-]{36}$/.test(topic)) return { replies: [], unexpected: `JOIN ${topic}` }
    return { replies: [reply({ postgres_changes: [] })], unexpected: null }
  }
  if (event === 'heartbeat' || event === 'access_token' || event === 'phx_leave') return { replies: [reply({})], unexpected: null }
  return { replies: [], unexpected: null }
}
