import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WORKER_SRC, listFiles, sanitizeSource, workspacePackages } from '../../__tests__/_scan-utils'

/**
 * Every Salesforce REST URL is built by the shared module (#2394, L613):
 * packages/salesforce-api/src/index.ts, which apps/worker/src/lib/salesforce-api.ts
 * re-exports. It holds the one API version (SALESFORCE_API_VERSION) and the
 * URL rules (salesforceDataUrl, salesforceQueryUrl, salesforceSobjectUrl,
 * salesforceRecordUrl, salesforceUpsertUrl, salesforceApexUrl,
 * salesforceNextPageUrl). Before #2394, nine Worker files wrote the URL out by
 * hand, and one of them (schema-sync) had drifted to an older API version than
 * the money path, which nothing noticed.
 *
 * This fails, in the src of every workspace package (enumerated from
 * pnpm-workspace.yaml, L96), on:
 *
 * - a string or template naming `/services/data/`: a data API URL or path
 *   written out by hand, which also pins its own version;
 * - a string or template naming `/services/apexrest/` with anything before it,
 *   which is an instance joined to an Apex path by hand rather than through
 *   salesforceApexUrl. A literal that BEGINS with it is allowed: that is an
 *   Apex endpoint's path (InquiryParserRest's `/services/apexrest/credit-inquiries`,
 *   kept in engine/inquiry-post.ts and in the Main Flow port's transform), a
 *   name the step config stores and salesforceApexUrl joins, not a URL;
 * - a query's next page followed by hand: `nextRecordsUrl` interpolated into a
 *   template or joined with `+`, rather than through salesforceNextPageUrl,
 *   which also takes the absolute URL a hand join would mangle;
 * - a declaration of its own SALESFORCE_API_VERSION, which is how two versions
 *   came to exist.
 *
 * Comments are stripped, so a comment naming a path is not a URL. Tests are not
 * scanned: they write the expected URL out by hand on purpose, as the byte
 * equality proof of each conversion.
 *
 * Seen red on 2026-10-28 against lib/salesforce-read.ts (its own version and
 * data URL), lib/salesforce-write.ts (a record URL), ops/sf-limits.ts (the
 * limits URL), and the hand joined next page in lib/click-path-checks.ts and
 * lib/sf-matrix-audit.ts, before each was moved onto the shared module, and
 * against the planted forms in the last test.
 */

const HOMES = new Set(['packages/salesforce-api/src/index.ts', 'apps/worker/src/lib/salesforce-api.ts'])

const DATA_PATH = /\/services\/data\//g
const APEX_PATH = /\/services\/apexrest\//g
/** `${...nextRecordsUrl}`, a property chain ending in it, interpolated as it is (a call around it, such as JSON.stringify, is not a join). */
const NEXT_PAGE_INTERPOLATED = /\$\{\s*[\w$.?!]*\bnextRecordsUrl\s*\}/g
/** `x + body.nextRecordsUrl` or `body.nextRecordsUrl + x`. */
const NEXT_PAGE_CONCATENATED = /\+\s*[\w$.?!]*\bnextRecordsUrl\b(?!\s*\()|\bnextRecordsUrl\s*\+/g
const OWN_VERSION = /\b(?:const|let|var)\s+SALESFORCE_API_VERSION\b/g

const lineOf = (src: string, index: number): number => src.slice(0, index).split('\n').length

/** Each hand built Salesforce URL in `source`, as `line N: what`. */
export function handBuiltSalesforceUrls(source: string): string[] {
  const src = sanitizeSource(source, { blankStrings: false })
  const found: string[] = []
  for (const m of src.matchAll(DATA_PATH)) found.push(`line ${lineOf(src, m.index ?? 0)}: names /services/data/ (use salesforceDataUrl and its siblings)`)
  for (const m of src.matchAll(APEX_PATH)) {
    const at = m.index ?? 0
    // A literal that starts with the path is an Apex endpoint's path, not a URL.
    if (/['"`]/.test(src[at - 1] ?? '')) continue
    found.push(`line ${lineOf(src, at)}: joins something to /services/apexrest/ (use salesforceApexUrl)`)
  }
  for (const re of [NEXT_PAGE_INTERPOLATED, NEXT_PAGE_CONCATENATED]) {
    for (const m of src.matchAll(re)) found.push(`line ${lineOf(src, m.index ?? 0)}: follows nextRecordsUrl by hand (use salesforceNextPageUrl)`)
  }
  for (const m of src.matchAll(OWN_VERSION)) found.push(`line ${lineOf(src, m.index ?? 0)}: declares its own SALESFORCE_API_VERSION`)
  return found
}

const rel = (full: string) => path.relative(REPO_ROOT, full).replace(/\\/g, '/')
const files = workspacePackages()
  .map((pkg) => path.join(pkg.dir, 'src'))
  .filter((src) => existsSync(src))
  .flatMap((src) => listFiles(src))
  .map((full) => ({ rel: rel(full), full }))
  // listFiles already skips __tests__ folders; the leading slash also catches a
  // path that starts with one, which `rel.includes('/__tests__/')` alone misses (#2951).
  .filter((f) => !`/${f.rel}`.includes('/__tests__/'))

describe('every Salesforce URL is built by the shared salesforce-api module (#2394)', () => {
  it('no workspace source builds one by hand', () => {
    const offenders = files
      .filter((f) => !HOMES.has(f.rel))
      .map((f) => ({ file: f.rel, found: handBuiltSalesforceUrls(readFileSync(f.full, 'utf8')) }))
      .filter((o) => o.found.length > 0)
    expect(offenders).toEqual([])
  })

  it('scans the shared module, the Worker and the service catalogue, so it cannot pass by reading nothing', () => {
    for (const home of HOMES) expect(files.some((f) => f.rel === home), home).toBe(true)
    expect(files.some((f) => f.rel === 'apps/worker/src/engine/nodes/salesforce.ts')).toBe(true)
    expect(files.some((f) => f.rel.startsWith('packages/service-catalogue/src/runtime/'))).toBe(true)
    expect(files.filter((f) => f.full.startsWith(WORKER_SRC + path.sep)).length).toBeGreaterThan(100)
    // The shared module itself names the data path, so the rule has something real to match.
    expect(handBuiltSalesforceUrls(readFileSync(path.join(REPO_ROOT, 'packages/salesforce-api/src/index.ts'), 'utf8')).length).toBeGreaterThan(0)
  })

  it('leaves out a test file directly under a src/__tests__ folder (#2951)', () => {
    const paths = ['apps/worker/src/__tests__/helpers/x.ts', 'apps/worker/src/lib/__tests__/y.ts', 'apps/worker/src/lib/z.ts']
    expect(paths.filter((p) => !`/${p}`.includes('/__tests__/'))).toEqual(['apps/worker/src/lib/z.ts'])
  })

  it('fails on each planted form, and not on a comment, an Apex path constant or a call through the module', () => {
    // Positive controls: the forms the Worker held before #2394.
    expect(handBuiltSalesforceUrls('const url = `${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`')).toHaveLength(1)
    expect(handBuiltSalesforceUrls("const url = instanceUrl + '/services/data/' + SALESFORCE_API_VERSION + '/limits'")).toHaveLength(1)
    expect(handBuiltSalesforceUrls('fetch(`${creds.instanceUrl}/services/data/${V}/sobjects/${object}/${id}`)')).toHaveLength(1)
    expect(handBuiltSalesforceUrls('const url = `${instanceUrl}/services/apexrest/credit-inquiries`')).toHaveLength(1)
    expect(handBuiltSalesforceUrls('next = body.done ? undefined : body.nextRecordsUrl ? `${instanceUrl}${body.nextRecordsUrl}` : undefined')).toHaveLength(1)
    expect(handBuiltSalesforceUrls('next = instanceUrl + body.nextRecordsUrl')).toHaveLength(1)
    expect(handBuiltSalesforceUrls('next = page?.nextRecordsUrl + suffix')).toHaveLength(1)
    expect(handBuiltSalesforceUrls("export const SALESFORCE_API_VERSION = 'v60.0'")).toHaveLength(1)
    // Negative controls: what the converted files and their comments hold.
    expect(handBuiltSalesforceUrls('// GET /services/data/vXX.X/limits through connectionFetch')).toEqual([])
    expect(handBuiltSalesforceUrls('/** `path` is below `/services/data/v60.0`. */\nconst x = 1')).toEqual([])
    expect(handBuiltSalesforceUrls("export const CREDIT_INQUIRY_APEX_PATH = '/services/apexrest/credit-inquiries'")).toEqual([])
    expect(handBuiltSalesforceUrls('const url = salesforceApexUrl(instanceUrl, salesforceApexPath(apexPath))')).toEqual([])
    expect(handBuiltSalesforceUrls('next = body.nextRecordsUrl ? salesforceNextPageUrl(instanceUrl, body.nextRecordsUrl) : undefined')).toEqual([])
    expect(handBuiltSalesforceUrls('throw new Error(`no next page: ${JSON.stringify(body.nextRecordsUrl)}`)')).toEqual([])
    expect(handBuiltSalesforceUrls("if (!body.nextRecordsUrl.startsWith(prefix)) path = body.nextRecordsUrl.slice(prefix.length)")).toEqual([])
    expect(handBuiltSalesforceUrls("import { SALESFORCE_API_VERSION } from './salesforce-api'")).toEqual([])
  })
})
