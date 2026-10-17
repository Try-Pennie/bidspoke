'use client'

import { useId } from 'react'

/**
 * One section of a partners page tab, as the settled design draws it (#2317,
 * PM-17, docs/design/partners-page.html): the section's name in a column on the
 * left, its settings beside it starting on the name's first line, and a thin
 * rule between sections. Every tab section is one of these, which
 * partner-page-density-guard.test.ts holds.
 *
 * `region={false}` keeps it a plain section rather than a named region, for a
 * section whose control already carries the heading's name (Workflow values).
 */
export function PartnerSection({ title, region = true, children }: { title: string; region?: boolean; children: React.ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={region ? id : undefined} className="partner-section">
      <h3 id={id} className="partner-section-title">{title}</h3>
      <div className="partner-section-body">{children}</div>
    </section>
  )
}

/** A named part inside a section (the design's sub heading): the matrix, a sample response. */
export function PartnerSubsection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="partner-subsection">
      <h4 className="partner-subsection-title">{title}</h4>
      {children}
    </div>
  )
}
