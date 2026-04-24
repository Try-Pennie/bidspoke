'use client'

import { useState } from 'react'
import { ChevronRight, Copy, Link2 } from 'lucide-react'

function JsonNode({ label, value, path, depth }: {
  label: string
  value: unknown
  path: string
  depth: number
}) {
  const [expanded, setExpanded] = useState(depth < 2)
  const [copiedKey, setCopiedKey] = useState<'path' | 'value' | null>(null)

  function copyTo(text: string, key: 'path' | 'value') {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1400)
  }

  const isObj = value !== null && value !== undefined && typeof value === 'object'
  const childEntries: [string, unknown, string][] = isObj
    ? Array.isArray(value)
      ? (value as unknown[]).map((v, i) => [`[${i}]`, v, `${path}[${i}]`])
      : Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, v, `${path}.${k}`])
    : []

  const copyableValue = isObj
    ? JSON.stringify(value)
    : value === null || value === undefined
    ? String(value)
    : typeof value === 'string'
    ? value
    : String(value)

  const displayValue = isObj ? null
    : value === null || value === undefined
    ? <span className="text-gray-400 italic">null</span>
    : typeof value === 'boolean'
    ? <span className="text-amber-600">{String(value)}</span>
    : typeof value === 'number'
    ? <span className="text-blue-600">{value}</span>
    : <span className="text-green-700 break-all">{'"'}{String(value)}{'"'}</span>

  return (
    <div>
      <div
        className="group flex min-h-[22px] items-start gap-1 rounded-sm px-1 py-0.5 hover:bg-blue-50 cursor-default"
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        {isObj ? (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="mt-[2px] flex h-3.5 w-3.5 shrink-0 items-center justify-center text-gray-400 hover:text-gray-600"
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          </button>
        ) : (
          <span className="h-3.5 w-3.5 shrink-0" />
        )}

        <span className="shrink-0 font-mono text-xs text-gray-700 leading-[18px]">{label}</span>
        <span className="shrink-0 font-mono text-xs text-gray-400 leading-[18px]">:</span>

        {isObj && (
          <span className="font-mono text-xs text-gray-400 ml-0.5 leading-[18px]">
            {Array.isArray(value) ? `[${childEntries.length}]` : `{${childEntries.length}}`}
          </span>
        )}
        {!isObj && <span className="font-mono text-xs ml-0.5 min-w-0 leading-[18px]">{displayValue}</span>}

        <div className="ml-auto mt-[1px] hidden shrink-0 items-center gap-0.5 group-hover:flex">
          {copiedKey === 'path' ? (
            <span className="px-1 text-[10px] text-green-600">copied</span>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); copyTo(path, 'path') }}
              className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
              title={`Copy path: ${path}`}
            >
              <Link2 className="h-3 w-3" />
            </button>
          )}
          {copiedKey === 'value' ? (
            <span className="px-1 text-[10px] text-green-600">copied</span>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); copyTo(copyableValue, 'value') }}
              className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
              title="Copy value"
            >
              <Copy className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {isObj && expanded && childEntries.map(([lbl, val, childPath]) => (
        <JsonNode key={lbl} label={lbl} value={val} path={childPath} depth={depth + 1} />
      ))}
    </div>
  )
}

export default function JsonTreeView({
  data,
  basePath,
  maxHeightClassName = 'max-h-64',
}: {
  data: unknown
  basePath: string
  maxHeightClassName?: string
}) {
  return (
    <div className={`${maxHeightClassName} overflow-auto rounded border border-gray-200 bg-gray-50 p-1`}>
      <JsonNode label={basePath} value={data} path={basePath} depth={0} />
    </div>
  )
}
