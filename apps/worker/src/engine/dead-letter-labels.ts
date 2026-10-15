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

// A failed post-answer Salesforce write whose request could not be kept for a
// replay (#1993): never retried, and not a billing record, so the alert copy
// routes on it to its own wording (#835). Set in engine/writeback-deadletter.ts.
export const WRITEBACK_UNCAPTURABLE_LABEL = 'outcome_writeback_deadletters.uncapturable'

/** The durable path's label for the writeback replay store's insert (#2084: moved here so the alert copy can route on it). */
export const WRITEBACK_STORE_LABEL = 'outcome_writeback_deadletters.insert'

// A post-answer Salesforce update that timed out or was cut off, whose request
// the at-risk watch holds in KV, on any object, until the read-back (#2023)
// takes over the objects it covers (#2163):
// unknown, not lost and not unreplayable, so the alert copy routes on it to its
// own wording. Set in engine/writeback-deadletter.ts.
export const WRITEBACK_HELD_LABEL = 'sf_writeback.held'
