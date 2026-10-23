import { notFound } from 'next/navigation'
import { AppActionPreview } from './AppActionPreview'
import { previewFrameOf } from './app-action-preview-source'

// It reads its query, so it is rendered per request, which Cloudflare Pages serves only from the edge runtime.
export const runtime = 'edge'

/**
 * The App Action step's card (#2339) from the settled design's fixture, for the
 * design score and the screenshots (L606): ?frame=<id> names the frame, as
 * docs/design/app-action-node-card/settled.json lists them. No data, no
 * network. Not served in a production build: the page answers 404 there.
 */
export default async function AppActionPreviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound()
  const params = await searchParams
  const frame = previewFrameOf(typeof params.frame === 'string' ? params.frame : undefined)
  return <AppActionPreview key={frame} />
}
