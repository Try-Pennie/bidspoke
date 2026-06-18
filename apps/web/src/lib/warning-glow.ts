// When more than this many nodes warn at once, the canvas drops the warning
// glow's pulse animation (keeping a static glow) so a busy workflow isn't a wall
// of competing motion — a single pulsing node draws the eye; a dozen is noise (#228).
export const CALM_WARNINGS_THRESHOLD = 4

export function shouldCalmWarnings(warningCount: number): boolean {
  return warningCount > CALM_WARNINGS_THRESHOLD
}
