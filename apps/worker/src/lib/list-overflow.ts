/**
 * The most lines one grouped Slack notice lists before naming the rest as a
 * count.
 *
 * Slack hard rejects any section block over 3,000 characters, and a grouped
 * notice is exactly the message that gets long on the worst day. Uncapped, a
 * mass failure would be refused, no cooldown would be recorded, and every later
 * run would rebuild the same oversized message: silent during the one incident
 * it exists to report. At roughly 120 characters a line, twenty lines leave
 * well over half the block spare.
 */
export const MAX_LISTED_LINES = 20

/**
 * Renders a capped list plus a tail naming what it left out.
 *
 * Its own module rather than a helper inside `slack.ts`, because the checks
 * that group per channel mock `slack` wholesale in their tests, and a pure
 * formatter must keep working under that mock rather than vanish with it.
 */
export function listWithOverflow(lines: string[], total: number, max: number = MAX_LISTED_LINES): string {
  if (total <= max) return lines.join('\n')
  return `${lines.slice(0, max).join('\n')}\n_and ${total - max} more_`
}
