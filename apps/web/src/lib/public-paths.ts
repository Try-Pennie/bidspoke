// Paths reachable WITHOUT authentication. Centralized as a pure function so this
// security-sensitive allowlist is unit-testable — middleware.ts itself can't run
// in the vitest node env (it imports Next/Supabase server modules). Keep this in
// sync with the matcher in middleware.ts.
export function isPublicPath(pathname: string): boolean {
  return (
    pathname.startsWith('/login') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/access-denied') ||
    pathname.startsWith('/mockup') ||
    // Node-state preview gallery (#227) — static node cards, no data; reachable
    // without auth so visual changes can be verified in a browser / Playwright.
    pathname.startsWith('/dev') ||
    // Public documentation site and the AI crawl index. Reachable without auth so
    // external readers and AI crawlers (raw .md files and /llms.txt) aren't
    // redirected to /login.
    pathname.startsWith('/docs') ||
    pathname === '/llms.txt'
  )
}
