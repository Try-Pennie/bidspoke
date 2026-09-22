'use client'

/**
 * The 409 side by side (#1412, L717, L608): the save was refused because the
 * profile changed underneath the person. Each field that differs is named with
 * both values, every edit they typed stays in the form, and the two actions are
 * the only two: re-submit over theirs, or take theirs. Nothing here discards
 * the edits by instruction.
 */
import { useId } from 'react'
import { diffProfileDocuments, type BuyerProfileDocument } from '@bidspoke/buyer-profile'
import { Button } from '@/components/ui/form'
import { formatProfileValue, profileFieldLabel } from './labels'

export function ProfileConflictView({ mine, theirs, changedBy, onSaveOverTheirs, onTakeTheirs }: {
  mine: BuyerProfileDocument
  theirs: BuyerProfileDocument
  changedBy: string | null
  onSaveOverTheirs: (theirVersion: number) => void
  onTakeTheirs: (theirs: BuyerProfileDocument) => void
}) {
  const titleId = useId()
  const diffs = diffProfileDocuments(mine, theirs)
  return (
    <div role="alertdialog" aria-modal="false" aria-labelledby={titleId} className="rounded-lg border border-amber-300 bg-amber-50 p-4">
      <h4 id={titleId} className="text-sm font-semibold text-amber-900">
        This profile was saved by someone else{changedBy ? ` (${changedBy})` : ''} while you were editing it
      </h4>
      <p className="mt-1 text-xs text-amber-900">
        Their save is version {theirs.version ?? '?'}. Your edits are still in the form. The fields below differ between what you have and what is saved now.
      </p>
      <table className="mt-3 w-full text-xs">
        <thead>
          <tr className="text-left text-gray-600">
            <th scope="col" className="py-1 pr-3 font-medium">Field</th>
            <th scope="col" className="py-1 pr-3 font-medium">Yours</th>
            <th scope="col" className="py-1 font-medium">Saved now</th>
          </tr>
        </thead>
        <tbody>
          {diffs.map((d) => (
            <tr key={d.path} className="border-t border-amber-200 text-graphite">
              <td className="py-1 pr-3">{profileFieldLabel(d.path)}</td>
              <td className="py-1 pr-3 font-mono">{formatProfileValue(d.path, d.mine)}</td>
              <td className="py-1 font-mono">{formatProfileValue(d.path, d.theirs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={() => onSaveOverTheirs(theirs.version ?? 0)}>Save over theirs</Button>
        <Button variant="secondary" onClick={() => onTakeTheirs(theirs)}>Take theirs</Button>
      </div>
    </div>
  )
}
