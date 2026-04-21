'use client'

import { useEffect, useRef, useState } from 'react'

interface Props {
  value: string
  onChange: (val: string) => void
  placeholder?: string
  className?: string
  refs: string[]   // available data refs: "steps.credit", "trigger.payload", "env.KEY"
}

export default function TemplateTextarea({ value, onChange, placeholder, className, refs }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [activeIdx, setActiveIdx] = useState(0)

  // Derive filtered suggestions from the partial expression after the most recent {{
  function computeSuggestions(val: string, cursor: number): string[] {
    const beforeCursor = val.slice(0, cursor)
    const openAt = beforeCursor.lastIndexOf('{{')
    if (openAt < 0) return []
    // Make sure there's no closing }} between openAt and cursor
    if (beforeCursor.slice(openAt).includes('}}')) return []
    const partial = beforeCursor.slice(openAt + 2).toLowerCase()
    return refs.filter((r) => r.toLowerCase().startsWith(partial))
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value
    const cursor = e.target.selectionStart ?? val.length
    onChange(val)
    const sugs = computeSuggestions(val, cursor)
    setSuggestions(sugs)
    setActiveIdx(0)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      insertRef(suggestions[activeIdx])
    } else if (e.key === 'Escape') {
      setSuggestions([])
    }
  }

  function insertRef(ref: string) {
    const ta = textareaRef.current
    if (!ta) return
    const cursor = ta.selectionStart ?? value.length
    const beforeCursor = value.slice(0, cursor)
    const openAt = beforeCursor.lastIndexOf('{{')
    const newVal =
      openAt >= 0
        ? value.slice(0, openAt) + '{{' + ref + '}}' + value.slice(cursor)
        : value.slice(0, cursor) + '{{' + ref + '}}' + value.slice(cursor)
    onChange(newVal)
    setSuggestions([])
    // Restore focus and position cursor after the inserted ref
    requestAnimationFrame(() => {
      ta.focus()
      const pos = (openAt >= 0 ? openAt : cursor) + ref.length + 4 // 4 = {{ + }}
      ta.setSelectionRange(pos, pos)
    })
  }

  // Close suggestions on outside click
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setSuggestions([])
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  return (
    <div ref={containerRef} className="relative">
      <textarea
        ref={textareaRef}
        className={className}
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          // Small delay so click on suggestion registers first
          setTimeout(() => setSuggestions([]), 150)
        }}
      />
      {suggestions.length > 0 && (
        <ul className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border border-gray-200 bg-white text-xs shadow-lg">
          {suggestions.map((s, i) => (
            <li
              key={s}
              onMouseDown={(e) => { e.preventDefault(); insertRef(s) }}
              className={`cursor-pointer px-3 py-1.5 font-mono ${
                i === activeIdx ? 'bg-p-blue-light text-p-blue-dark' : 'text-gray-700 hover:bg-beige'
              }`}
            >
              {`{{${s}}}`}
            </li>
          ))}
        </ul>
      )}
      {refs.length > 0 && suggestions.length === 0 && (
        <p className="mt-1 text-xs text-gray-400">
          Type <code className="rounded bg-gray-100 px-0.5">{'{{'}</code> to insert a reference
        </p>
      )}
    </div>
  )
}
