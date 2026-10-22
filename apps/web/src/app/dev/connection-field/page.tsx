import { notFound } from 'next/navigation'
import { ConnectionFieldPreview } from './ConnectionFieldPreview'
import { previewFrameOf } from './connection-field-preview-source'

// It reads its query, so it is rendered per request, which Cloudflare Pages serves only from the edge runtime.
export const runtime = 'edge'

/**
 * A step's Connection field from the settled design's fixture (#2338, build
 * PR 11), for the design score and the screenshots (L606): ?frame=<id> names
 * the frame, the settled ones as docs/design/connections-step-form/settled.json
 * lists them and the states the design never drew (UNDRAWN_FRAMES). No data,
 * no network. Not served in a production build: the page answers 404 there.
 */
export default async function ConnectionFieldPreviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound()
  const params = await searchParams
  const frame = previewFrameOf(typeof params.frame === 'string' ? params.frame : undefined)
  return <ConnectionFieldPreview key={frame} frame={frame} />
}
