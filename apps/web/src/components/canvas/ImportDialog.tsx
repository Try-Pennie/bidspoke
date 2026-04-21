'use client'

import { useState } from 'react'
import { X, AlertTriangle, CheckCircle2, Upload } from 'lucide-react'
import { parsePipedreamExport } from '@/lib/pipedream-import'
import type { ImportResult } from '@/lib/pipedream-import'

interface Props {
  onImport: (result: ImportResult) => void
  onClose: () => void
}

export default function ImportDialog({ onImport, onClose }: Props) {
  const [json, setJson] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  function handleParse() {
    setError(null)
    setResult(null)
    try {
      const parsed = parsePipedreamExport(json.trim())
      setResult(parsed)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Parse failed')
    }
  }

  function handleConfirm() {
    if (result) onImport(result)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="flex w-[640px] max-h-[90vh] flex-col rounded-xl bg-white shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <div>
            <p className="font-semibold text-graphite">Import from Pipedream</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Paste the raw JSON export from a Pipedream workflow
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1.5 text-gray-400 hover:bg-gray-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {!result ? (
            <>
              <textarea
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs focus:border-blue-400 focus:outline-none focus:bg-white"
                rows={14}
                placeholder={'{\n  "id": "p_...",\n  "name": "Lead Routing",\n  "steps": [...]\n}'}
                value={json}
                onChange={(e) => { setJson(e.target.value); setError(null); setResult(null) }}
                spellCheck={false}
              />

              {error && (
                <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  {error}
                </div>
              )}
            </>
          ) : (
            <>
              {/* Preview */}
              <div className="rounded-lg border border-gray-200 p-3 space-y-1">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <span className="text-sm font-medium text-graphite">{result.name}</span>
                </div>
                <p className="text-xs text-gray-500 pl-6">
                  {result.def.nodes.length} node{result.def.nodes.length !== 1 ? 's' : ''},{' '}
                  {result.def.edges.length} edge{result.def.edges.length !== 1 ? 's' : ''}
                </p>
                <div className="pl-6 pt-1 space-y-0.5">
                  {result.def.nodes.map((n) => (
                    <div key={n.id} className="flex items-center gap-1.5 text-xs text-gray-600">
                      <span className={`rounded px-1 py-0.5 text-[10px] font-medium ${typeColor(n.type)}`}>
                        {n.type}
                      </span>
                      <span className="font-mono">{n.namespace}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Warnings */}
              {result.warnings.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1.5">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-amber-800">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {result.warnings.length} item{result.warnings.length !== 1 ? 's' : ''} need attention
                  </p>
                  <ul className="space-y-1 pl-5">
                    {result.warnings.map((w, i) => (
                      <li key={i} className="text-xs text-amber-700 list-disc">{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          {!result ? (
            <button
              onClick={handleParse}
              disabled={!json.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-p-blue-dark px-3 py-1.5 text-xs font-medium text-white hover:bg-[#3A8FD0] disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" />
              Parse
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setResult(null); setError(null) }}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
              >
                Back
              </button>
              <button
                onClick={handleConfirm}
                className="flex items-center gap-1.5 rounded-lg bg-p-blue-dark px-3 py-1.5 text-xs font-medium text-white hover:bg-[#3A8FD0]"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Import to canvas
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function typeColor(type: string): string {
  const map: Record<string, string> = {
    filter: 'bg-blue-100 text-blue-700',
    branch: 'bg-purple-100 text-purple-700',
    code: 'bg-amber-100 text-amber-700',
    response: 'bg-green-100 text-green-700',
    exit: 'bg-red-100 text-red-700',
  }
  return map[type] ?? 'bg-gray-100 text-gray-600'
}
