import { notFound } from 'next/navigation'
import { ComboboxPreview } from './ComboboxPreview'

/**
 * The Combobox in each of its states, and the two other hand drawn dropdowns
 * (#2338 PR 8 and rounds 27 and 28), for a screenshot in
 * development (L606). Made up orgs, no data, no network. Not served in a
 * production build: the page answers 404 there.
 */
export default function ComboboxPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <ComboboxPreview />
}
