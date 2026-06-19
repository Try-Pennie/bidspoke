'use client'

import { useState } from 'react'

// Renders an error message in full — error bodies (upstream API JSON like an
// Equifax 500) are stored uncapped, so the data is never truncated here. Long
// ones are collapsed to a few lines behind a "Show more" toggle so a huge body
// doesn't blow out the page; the complete text always stays in the DOM (so it's
// selectable/copyable), with the collapse done purely in CSS.
const EXPAND_THRESHOLD = 200

export function ExpandableError({ text, className }: { text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false)
  const expandable = text.length > EXPAND_THRESHOLD

  return (
    <div>
      <p
        className={`whitespace-pre-wrap break-words ${className ?? ''} ${
          expandable && !expanded ? 'line-clamp-6' : ''
        }`}
      >
        {text}
      </p>
      {expandable && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="mt-1 text-xs font-medium text-red-600 underline underline-offset-2 hover:text-red-700"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
