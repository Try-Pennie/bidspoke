'use client'

import { useEffect, useRef, useState } from 'react'

interface Props {
  value: string
  onChange: (val: string) => void
  suggestions: string[]   // e.g. ["steps.credit", "steps.enrich", "trigger.payload", "env.KEY"]
  placeholder?: string
  className?: string
}

export default function FieldAutocomplete({ value, onChange, suggestions, placeholder, className }: Props) {
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Filter suggestions by current value prefix
  const filtered = value.length === 0
    ? suggestions
    : suggestions.filter((s) => s.toLowerCase().startsWith(value.toLowerCase()))

  function select(s: string) {
    onChange(s)
    setOpen(false)
    inputRef.current?.focus()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || filtered.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (filtered[activeIdx]) {
        e.preventDefault()
        select(filtered[activeIdx])
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  // Reset active index when filtered list changes
  useEffect(() => { setActiveIdx(0) }, [filtered.length])

  // Close on outside click
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  const shouldShow = open && filtered.length > 0

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        className={className}
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={handleKeyDown}
        autoComplete="off"
      />
      {shouldShow && (
        <ul className="absolute z-50 mt-0.5 max-h-40 w-full overflow-auto rounded-md border border-gray-200 bg-white text-xs shadow-lg">
          {filtered.map((s, i) => (
            <li
              key={s}
              onMouseDown={(e) => { e.preventDefault(); select(s) }}
              className={`cursor-pointer px-2 py-1 font-mono ${
                i === activeIdx ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
