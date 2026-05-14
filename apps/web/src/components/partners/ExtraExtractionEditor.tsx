'use client'

import { useMemo, useState, useEffect } from 'react'
import { ArrowRight, Plus, Trash2 } from 'lucide-react'
import type { ExtraExtractionConfig, ExtraExtractionSpec } from '@/lib/api'

// Classifiers registered in apps/worker/src/engine/bid-resolver.ts CLASSIFIERS.
// Keep this list in sync when new classifiers ship.
const CLASSIFIERS: { value: string; label: string }[] = [
  { value: 'tripoint_result', label: 'tripoint_result (Success / Duplicate / Fail)' },
]

interface Row {
  key: string
  kind: 'path' | 'classifier'
  path: string
  classifier: string
}

interface Props {
  value: ExtraExtractionConfig | null
  onChange: (next: ExtraExtractionConfig | null) => void
  sampleResponse: unknown
}

export function ExtraExtractionEditor({ value, onChange, sampleResponse }: Props) {
  // Local row state. The serialized ExtraExtractionConfig drops empty-key rows
  // (they can't be expressed as map entries), so rendering off `value` alone
  // would make a freshly-added blank row disappear before the user could type
  // into it. Initialize from value on first render; sync down when value
  // changes externally (e.g. restoreSnapshot / undo).
  const [rows, setRows] = useState<Row[]>(() => readRows(value))
  const valueKey = JSON.stringify(value)
  useEffect(() => {
    setRows(readRows(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey])

  const pathSuggestions = useMemo(() => collectPaths(sampleResponse), [sampleResponse])

  function update(next: Row[]) {
    setRows(next)
    const out: ExtraExtractionConfig = {}
    for (const r of next) {
      if (!r.key) continue
      out[r.key] =
        r.kind === 'classifier'
          ? { classifier: r.classifier }
          : r.path
    }
    onChange(Object.keys(out).length > 0 ? out : null)
  }

  function addRow() {
    update([...rows, { key: '', kind: 'path', path: '', classifier: CLASSIFIERS[0]?.value ?? '' }])
  }

  function updateRow(i: number, patch: Partial<Row>) {
    update(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  function removeRow(i: number) {
    update(rows.filter((_, idx) => idx !== i))
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400">
        Pull partner-specific values out of the API response into <code className="rounded bg-gray-100 px-1 font-mono">output.extra</code>. Use a dot-path (e.g. <code className="rounded bg-gray-100 px-1 font-mono">data.createLead.id</code>) or a registered classifier function. Downstream Transform nodes read these via <code className="rounded bg-gray-100 px-1 font-mono">steps.&lt;node&gt;.output.extra.&lt;key&gt;</code>.
      </p>

      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                value={row.key}
                onChange={(e) => updateRow(i, { key: e.target.value })}
                placeholder="leadId"
                className="w-32 flex-shrink-0 rounded-md border border-gray-200 px-2 py-1.5 font-mono text-xs focus:border-gray-400 focus:outline-none"
              />
              <ArrowRight className="h-3 w-3 flex-shrink-0 text-gray-300" />
              <select
                value={row.kind}
                onChange={(e) => updateRow(i, { kind: e.target.value as 'path' | 'classifier' })}
                className="flex-shrink-0 rounded-md border border-gray-200 bg-white px-1.5 py-1.5 text-xs text-gray-700 focus:border-gray-400 focus:outline-none"
              >
                <option value="path">path</option>
                <option value="classifier">classifier</option>
              </select>
              {row.kind === 'classifier' ? (
                <select
                  value={row.classifier}
                  onChange={(e) => updateRow(i, { classifier: e.target.value })}
                  className="min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-800 focus:border-gray-400 focus:outline-none"
                >
                  {CLASSIFIERS.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    list={`extra-paths-${i}`}
                    value={row.path}
                    onChange={(e) => updateRow(i, { path: e.target.value })}
                    placeholder="data.createLead.id"
                    className="min-w-0 flex-1 rounded-md border border-gray-200 px-2 py-1.5 font-mono text-xs focus:border-gray-400 focus:outline-none"
                  />
                  <datalist id={`extra-paths-${i}`}>
                    {pathSuggestions.map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
                </>
              )}
              <button
                type="button"
                onClick={() => removeRow(i)}
                className="flex-shrink-0 text-gray-300 hover:text-red-400"
                title="Remove"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={addRow}
        className="flex items-center gap-1 text-xs text-p-blue-dark hover:text-navy"
      >
        <Plus className="h-3.5 w-3.5" />
        Add extraction
      </button>

      {pathSuggestions.length === 0 && (
        <p className="text-xs text-gray-400">
          Paste a sample API response above to enable path autocomplete.
        </p>
      )}
    </div>
  )
}

function readRows(value: ExtraExtractionConfig | null): Row[] {
  if (!value) return []
  const rows: Row[] = []
  for (const [key, spec] of Object.entries(value)) {
    rows.push(readRow(key, spec))
  }
  return rows
}

function readRow(key: string, spec: ExtraExtractionSpec): Row {
  if (typeof spec === 'string') {
    return { key, kind: 'path', path: spec, classifier: CLASSIFIERS[0]?.value ?? '' }
  }
  if (spec && typeof spec === 'object') {
    if (typeof spec.classifier === 'string') {
      return { key, kind: 'classifier', path: '', classifier: spec.classifier }
    }
    if (typeof spec.path === 'string') {
      return { key, kind: 'path', path: spec.path, classifier: CLASSIFIERS[0]?.value ?? '' }
    }
  }
  return { key, kind: 'path', path: '', classifier: CLASSIFIERS[0]?.value ?? '' }
}

function collectPaths(obj: unknown, prefix = '', out: string[] = []): string[] {
  if (obj === null || obj === undefined) return out
  if (typeof obj !== 'object') return out
  if (Array.isArray(obj)) {
    // Surface array-of-objects keys with a [0] index hint.
    if (obj.length > 0 && obj[0] !== null && typeof obj[0] === 'object') {
      collectPaths(obj[0], `${prefix}[0]`, out)
    }
    return out
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${k}` : k
    out.push(next)
    if (v !== null && typeof v === 'object') {
      collectPaths(v, next, out)
    }
  }
  return out
}
