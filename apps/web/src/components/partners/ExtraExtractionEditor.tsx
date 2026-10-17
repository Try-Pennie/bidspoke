'use client'

import { useId, useMemo, useState, useEffect } from 'react'
import { Plus } from 'lucide-react'
import type { ExtraExtractionConfig, ExtraExtractionSpec } from '@/lib/api'
import { Button, TextInput } from '@/components/ui/form'
import { Select } from '@/components/ui/Select'
import { SuggestInput } from '@/components/ui/SuggestInput'
import { RemoveButton } from '@/components/partners/RemoveButton'

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

  const base = useId()
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

  function addRow(kind: Row['kind'] = 'path') {
    update([...rows, { key: '', kind, path: '', classifier: CLASSIFIERS[0]?.value ?? '' }])
  }

  function updateRow(i: number, patch: Partial<Row>) {
    update(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  function removeRow(i: number) {
    update(rows.filter((_, idx) => idx !== i))
  }

  // What a later step reads, in its own spelling (PM-23, the design's one line under Extract).
  const named = rows.filter((r) => r.key).map((r) => `extra.${r.key}`)
  const readAs = named.length === 0 ? null
    : named.length === 1 ? `Later steps read it as ${named[0]}.`
    : `Later steps read them as ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}.`

  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="text-[13px] text-hint">Nothing extracted.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-gray-600">
              <th scope="col" className="w-36 pb-1 pr-2 font-medium">Name</th>
              <th scope="col" className="pb-1 pr-2 font-medium">Where it is in the response</th>
              <th scope="col" className="w-8 pb-1"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="align-middle">
                <td className="py-0.5 pr-2">
                  <TextInput id={`${base}-${i}-key`} aria-label={`Name, extraction ${i + 1}`} value={row.key} onChange={(v) => updateRow(i, { key: v })} placeholder="leadId" mono />
                </td>
                <td className="py-0.5 pr-2">
                  {row.kind === 'classifier' ? (
                    // A result worked out from the whole answer by a classifier the
                    // Worker registers, rather than read at one path (Tripoint's result).
                    <Select id={`${base}-${i}-classifier`} aria-label={`Classifier, extraction ${i + 1}`} value={row.classifier} options={CLASSIFIERS} onChange={(v) => updateRow(i, { classifier: v })} />
                  ) : (
                    <SuggestInput
                      id={`${base}-${i}-path`}
                      aria-label={`Where it is in the response, extraction ${i + 1}`}
                      value={row.path}
                      onChange={(v) => updateRow(i, { path: v })}
                      placeholder="data.createLead.id"
                      mono
                      suggestions={pathSuggestions}
                    />
                  )}
                </td>
                <td className="py-0.5">
                  <RemoveButton label={`Remove extraction ${i + 1}`} onClick={() => removeRow(i)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="flex flex-wrap gap-x-4">
        <Button variant="quiet" onClick={() => addRow('path')}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add extraction
        </Button>
        <Button variant="quiet" onClick={() => addRow('classifier')}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add classifier
        </Button>
      </div>

      {readAs && <p className="text-xs text-hint">{readAs}</p>}
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
