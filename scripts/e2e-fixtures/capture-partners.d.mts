/** Types for capture-partners.mjs, so the TypeScript that checks the fixtures can import it. */
export const FIXTURE_DIR: string
export function writeFixtures(
  captured: {
    partners: Array<Record<string, unknown> & { id: string; slug: string }>
    profiles: Record<string, Record<string, unknown> & { profile: unknown }>
    uuids: Array<Record<string, unknown> & { partner_slug: string; id: string }>
    bidConfigs: Record<string, Array<Record<string, unknown>>>
    usage?: Record<string, unknown>
    /** GET /api/partners/:id/history by partner id (#2141). */
    history?: Record<string, { entries: Array<Record<string, unknown>> } & Record<string, unknown>>
  },
  outDir?: string,
): void
