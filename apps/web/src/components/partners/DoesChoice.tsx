'use client'

import { Checkbox } from '@/components/ui/form'

export interface Does {
  sends: boolean
  buys: boolean
}

/**
 * What a partner does, as two boxes (the settled design's Does row, #2321 and
 * #2323): Sends us leads, Buys leads, either or both. The new partner page and
 * the Partner tab both draw it. `keepOne` is for a saved partner: the last box
 * ticked cannot be unticked, since a stored partner always does something and
 * the boxes must say what is stored.
 */
export function DoesChoice({ idPrefix, does, onChange, keepOne = false }: { idPrefix: string; does: Does; onChange: (next: Does) => void; keepOne?: boolean }) {
  const only = keepOne && does.sends !== does.buys
  const noteId = `${idPrefix}-keep-one`
  return (
    <div className="flex flex-col gap-1.5">
      <Checkbox id={`${idPrefix}-sends`} label="Sends us leads" checked={does.sends} disabled={only && does.sends} describedBy={only && does.sends ? noteId : undefined} onChange={(v) => onChange({ ...does, sends: v })} />
      <Checkbox id={`${idPrefix}-buys`} label="Buys leads" checked={does.buys} disabled={only && does.buys} describedBy={only && does.buys ? noteId : undefined} onChange={(v) => onChange({ ...does, buys: v })} />
      {only && <span id={noteId} className="sr-only">A partner sends us leads, buys them, or both, so one stays ticked.</span>}
    </div>
  )
}
