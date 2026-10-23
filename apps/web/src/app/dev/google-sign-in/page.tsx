import { notFound } from 'next/navigation'
import { GoogleSignInPreview } from './GoogleSignInPreview'

// It reads its query, so it is rendered per request, which Cloudflare Pages serves only from the edge runtime.
export const runtime = 'edge'

/**
 * The page Google sends the browser back to (#2338, build PR 13), for the
 * screenshots (L606): ?frame=working (the finish still running), failed (a
 * refusal's sentence) or empty (an address with no sign in). No data, no
 * network. Not served in a production build: the page answers 404 there.
 */
export default async function GoogleSignInPreviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound()
  const params = await searchParams
  const frame = params.frame === 'failed' || params.frame === 'empty' ? params.frame : 'working'
  return <GoogleSignInPreview frame={frame} />
}
