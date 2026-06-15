// Issue #99: the endpoint create form mirrored subdomain into source_name on
// every subdomain change with no manual-edit flag, so fixing a subdomain typo
// silently wiped a hand-entered source name (e.g. "rml-lendswift" back to "rml"),
// stamping the wrong trigger.source and splitting downstream source filters.
//
// Mirror the subdomain into source_name only until the user edits source_name
// themselves — the same rule PartnerForm uses for slug (slugManuallyEdited).
export function deriveSourceName(subdomain: string, currentSourceName: string, manuallyEdited: boolean): string {
  return manuallyEdited ? currentSourceName : subdomain
}
