// Dead-letter label vocabulary, declared once so the three sites that must agree
// on it cannot silently diverge (#1942): the engine that SETS the label on an
// unfinished continuation (engine/index.ts), the threshold that decides when that
// label pages (engine/durability.ts), and the alert copy that routes on it
// (lib/slack.ts). A literal in one place and a rename in another would quietly
// send continuation_unfinished back to the first-loss threshold and the generic
// "record lost" copy. A leaf module (no imports) so every consumer, including
// lib/slack.ts, can import it without a cycle.

// A run's post-response walk was still running at its cut-off (#1860): unknown,
// not a confirmed loss. Raised to its own dead-letter threshold in durability.ts.
export const CONTINUATION_UNFINISHED_LABEL = 'continuation_unfinished'
