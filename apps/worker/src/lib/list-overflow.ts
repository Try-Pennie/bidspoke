/**
 * The most lines one grouped Slack notice lists before naming the rest as a
 * count, and the character budget that overrides it.
 *
 * Slack hard rejects any section block over 3,000 characters, and a grouped
 * notice is exactly the message that gets long on the worst day. Uncapped, a
 * mass failure would be refused, no cooldown would be recorded, and every later
 * run would rebuild the same oversized message: silent during the one incident
 * it exists to report.
 *
 * The cap is in CHARACTERS, the unit the limit is expressed in (L81), with the
 * line count as a readability ceiling on top. A line cap alone was sized for
 * the page's 120 character lines and measured 7,269 characters for twenty
 * all-clear lines, which Slack would have refused.
 */
export const MAX_LISTED_LINES = 20
export const SECTION_CHAR_BUDGET = 2800

/**
 * Renders as many lines as fit the line and character caps, plus a tail naming
 * what it left out. `total` is the size of the whole list the lines came from,
 * so a caller that already trimmed can still report the true remainder.
 *
 * `reserveChars` is text the caller will append to this list inside the same
 * Slack section (the one shared timing sentence a grouped all-clear adds below
 * the subjects, #1270), so the list is held to the budget LESS that reserve and
 * the whole section still clears the 3,000 character limit, not just the list.
 */
export function listWithOverflow(
  lines: string[],
  total: number,
  max: number = MAX_LISTED_LINES,
  reserveChars: number = 0,
): string {
  const budget = SECTION_CHAR_BUDGET - reserveChars
  const tailFor = (shown: number) => `\n_and ${total - shown} more_`
  const kept: string[] = []
  let length = 0
  for (const line of lines.slice(0, max)) {
    const next = length + line.length + (kept.length ? 1 : 0)
    // Reserve room for the tail whenever this line is not the last one shown.
    if (next + tailFor(kept.length + 1).length > budget) break
    kept.push(line)
    length = next
  }
  if (kept.length >= total) return kept.join('\n')
  return `${kept.join('\n')}${tailFor(kept.length)}`
}
