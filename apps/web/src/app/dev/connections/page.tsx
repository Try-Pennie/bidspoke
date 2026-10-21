import { notFound } from 'next/navigation'
import { ConnectionsPreview } from './ConnectionsPreview'

// It reads its query, so it is rendered per request, which Cloudflare Pages serves only from the edge runtime.
export const runtime = 'edge'

/**
 * The Connections page from the settled design's fixture (#2338, build PR 9),
 * for the design score and the screenshots (L606): ?frame=<id> names the
 * frame, as docs/design/connections-page/settled.json lists them, and
 * ?frame=loading shows the load still waiting. No data, no network. Not
 * served in a production build: the page answers 404 there.
 */
export default async function ConnectionsPreviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound()
  const params = await searchParams
  const frame = typeof params.frame === 'string' ? params.frame : undefined
  const more = typeof params.google === 'string' ? Math.max(0, Math.min(200, Number.parseInt(params.google, 10) || 0)) : 0
  return <ConnectionsPreview frame={frame} moreGoogle={more} />
}
