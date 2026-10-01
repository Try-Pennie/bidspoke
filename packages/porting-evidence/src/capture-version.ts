/**
 * The capture step version (#1705). Bumped whenever the shape of what a capture
 * sends changes. The receiver accepts only the versions its registry lists and
 * quarantines the rest, because Pipedream keeps no history to recover from.
 *
 * Its own module so the receiver can import it without the instrumenter's
 * parser dependencies.
 */
export const CAPTURE_VERSION = 1
