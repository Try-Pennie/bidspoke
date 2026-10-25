import { notFound } from 'next/navigation'
import { CanvasSaveConflictPreview } from './CanvasSaveConflictPreview'
import { previewFrameOf } from './canvas-save-conflict-preview-source'

// It reads its query, so it is rendered per request, which Cloudflare Pages serves only from the edge runtime.
export const runtime = 'edge'

/**
 * The canvas save conflict from the settled design's fixture (#2599), for the
 * design score and the screenshots (L606): ?frame=<id> names the frame, as
 * docs/design/canvas-save-conflict/settled.json lists them. No data, no
 * network. Not served in a production build: the page answers 404 there.
 */
export default async function CanvasSaveConflictPreviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound()
  const params = await searchParams
  const frame = previewFrameOf(typeof params.frame === 'string' ? params.frame : undefined)
  return <CanvasSaveConflictPreview key={frame} frame={frame} />
}
