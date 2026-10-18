import type { ServiceSchema } from './types'

/**
 * The Google Workspace domain wide delegation scopes (#2335, phase 5 of #1689;
 * finding F129).
 *
 * The GRANT is Dan's decision 11 (2026-10-17): broad scopes, granted once by a
 * Workspace admin to the ops service account, so a later port needs no new
 * admin action. Delegation lets that account act as any mailbox for these
 * scopes, which is why the mailboxes and drives a connection may name are an
 * organization's own allowlist on the ops database (google_delegation_subjects).
 *
 * What the ops minter ASKS FOR is narrower: the union of the scopes the
 * catalogue's Google actions declare (`ActionSchema.googleScopes`), derived
 * here and never written by hand, so a token never carries a scope no shipped
 * action uses. Each declared scope must be one of the grant (the catalogue
 * check google_scope_not_granted).
 */
export const GOOGLE_DELEGATION_GRANTED_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
] as const
export type GoogleDelegationScope = (typeof GOOGLE_DELEGATION_GRANTED_SCOPES)[number]

/** Every scope the catalogue's actions declare, once each, sorted. Empty while no Google action ships. */
export function googleDelegationScopes(catalogue: readonly ServiceSchema[]): string[] {
  const scopes = new Set<string>()
  for (const service of catalogue) {
    for (const action of service.actions) for (const scope of action.googleScopes ?? []) scopes.add(scope)
  }
  return [...scopes].sort()
}
