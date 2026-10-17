'use client'

import { Minus } from 'lucide-react'
import { Button } from '@/components/ui/form'

/**
 * The remove mark on the partners page (#2317, the settled design): a grey minus
 * that takes one row out of a list. `label` names what it removes, for a screen
 * reader and on hover. partner-page-density-guard.test.ts refuses any other
 * remove mark on the page.
 */
export function RemoveButton({ label, onClick, disabled, className }: { label: string; onClick: () => void; disabled?: boolean; className?: string }) {
  return (
    <Button variant="remove" onClick={onClick} disabled={disabled} aria-label={label} title={label} className={className}>
      <Minus className="h-3.5 w-3.5" aria-hidden="true" />
    </Button>
  )
}
