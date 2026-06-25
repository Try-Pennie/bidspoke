'use client'

import { AlertTriangle } from 'lucide-react'

export interface PartnerFormulaImpact {
  partner_id: string
  partner_name: string
  partner_slug: string
  references: number
  formula_preview: string
  shared_with_workflows: Array<{ id: string; name: string }>
  can_rewrite: boolean
}

interface Props {
  oldNs: string
  newNs: string
  canvasReferenceCount: number
  partnerFormulas: PartnerFormulaImpact[]
  onConfirm: () => void
  onCancel: () => void
}

export default function RenameConfirmDialog({
  oldNs,
  newNs,
  canvasReferenceCount,
  partnerFormulas,
  onConfirm,
  onCancel,
}: Props) {
  const safeFormulas = partnerFormulas.filter((p) => p.can_rewrite)
  const skippedFormulas = partnerFormulas.filter((p) => !p.can_rewrite)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-[480px] max-w-full rounded-lg bg-white shadow-xl">
        <div className="border-b border-gray-100 px-5 py-4">
          <h2 className="text-base font-semibold text-graphite">
            Rename <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-sm">{oldNs}</code> →{' '}
            <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-sm">{newNs}</code>
          </h2>
        </div>

        <div className="space-y-4 px-5 py-4 text-sm text-gray-700">
          {canvasReferenceCount > 0 && (
            <p>
              <span className="font-medium">
                {canvasReferenceCount} reference{canvasReferenceCount === 1 ? '' : 's'}
              </span>{' '}
              in this workflow will be updated.
            </p>
          )}

          {safeFormulas.length > 0 && (
            <div>
              <p className="mb-1.5 font-medium">
                {safeFormulas.length} partner formula{safeFormulas.length === 1 ? '' : 's'} will be rewritten:
              </p>
              <ul className="space-y-1.5 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs">
                {safeFormulas.map((p) => (
                  <li key={p.partner_id}>
                    <span className="font-medium text-graphite">{p.partner_name}</span>{' '}
                    <span className="text-gray-500">({p.references} ref{p.references === 1 ? '' : 's'})</span>
                    {p.formula_preview && (
                      <div className="mt-0.5 truncate font-mono text-gray-500">{p.formula_preview}</div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {skippedFormulas.length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-amber-700">
                <AlertTriangle className="h-3.5 w-3.5" />
                {skippedFormulas.length} formula{skippedFormulas.length === 1 ? '' : 's'} won&apos;t be rewritten
              </div>
              <p className="mb-2 text-xs text-amber-700">
                These partners are used by other workflows that may still reference{' '}
                <code className="rounded bg-amber-100 px-1 font-mono">steps.{oldNs}</code>. Rewriting would silently break them.
              </p>
              <ul className="space-y-1.5 text-xs text-amber-900">
                {skippedFormulas.map((p) => (
                  <li key={p.partner_id}>
                    <span className="font-medium">{p.partner_name}</span>{' '}
                    <span className="text-amber-700">
                      also used by {p.shared_with_workflows.map((w) => w.name).join(', ')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {canvasReferenceCount === 0 && partnerFormulas.length === 0 && (
            <p className="text-gray-500">No downstream references found.</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded bg-graphite px-3 py-1.5 text-sm font-medium text-white hover:bg-black"
          >
            Rename
          </button>
        </div>
      </div>
    </div>
  )
}
