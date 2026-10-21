import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { LeadValidationPreview } from './LeadValidationPreview'

/**
 * The lead validation step's card and settings panel (#2590) with the settled
 * designs' data, for the checks files and screenshots in development (L606).
 * No data, no network. Not served in a production build: the page answers 404.
 */
export default function LeadValidationPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return (
    <Suspense>
      <LeadValidationPreview />
    </Suspense>
  )
}
