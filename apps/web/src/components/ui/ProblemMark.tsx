/**
 * The one red mark of a problem (#2137, PM-12): a small red dot beside the
 * thing that has one, a partner's row in the list or the tab holding the field.
 * Red is kept for something genuinely wrong (.impeccable.md), and this is the
 * one red marker PR13's colour scan allows, so every problem mark on the page is
 * drawn here. The dot is decoration to a screen reader; `label` is read in its
 * place, so the mark is never colour alone.
 */
export function ProblemMark({ label, className }: { label: string; className?: string }) {
  return (
    <span className={`problem-mark ${className ?? ''}`.trim()} data-problem-mark="">
      <span aria-hidden="true" className="problem-mark-dot" />
      <span className="sr-only">{label}</span>
    </span>
  )
}
