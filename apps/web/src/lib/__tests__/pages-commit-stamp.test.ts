import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * The site has to say which commit it is serving before anything can notice it
 * is stale (#804).
 *
 * The worker got this via DEPLOYED_SHA at GET /, and #327 is the record of what
 * it cost to have both halves fail quietly: the runtime test passed by handing
 * the value straight to the handler, so it was structurally unable to notice the
 * deploy never supplied one, and the live worker answered "unknown" for months
 * while the hourly check it fed skipped with exit 0.
 *
 * So this covers the two halves the worker's version got wrong, for the site:
 * the stamp is rendered on EVERY page (not one endpoint, because a Pages deploy
 * propagates per route), and the deploy actually supplies it to the build.
 *
 * NEXT_PUBLIC_* values are inlined at compile time, so the stamp has to be
 * present in the environment of the build step itself. Setting it anywhere later
 * would produce a site that renders the placeholder forever, which is exactly the
 * silent half of #327 repeated.
 */
const readRepoFile = (relative: string): string => {
  const file = path.join(REPO_ROOT, relative)
  const text = readFileSync(file, 'utf8')
  // Fail loudly rather than let every assertion below pass against an empty
  // string if a file is ever moved or renamed (L100).
  expect(text.length, `${file} is empty`).toBeGreaterThan(0)
  return text
}

describe('the site renders the commit it was built from (#804)', () => {
  it('puts the stamp in the root layout, so every route carries it', () => {
    // Deliberately the ROOT layout and not a single endpoint. A Pages deploy
    // propagates per route, so a stamp on one route cannot answer for the site,
    // and a prod scan has genuinely served the old bundle on some routes and the
    // new one on others.
    const layout = readRepoFile('apps/web/src/app/layout.tsx')
    expect(
      layout,
      'the root layout no longer renders the bidspoke-commit stamp, so no route reports its build',
    ).toMatch(/'bidspoke-commit':/)
  })

  it('sources the stamp from NEXT_PUBLIC_COMMIT_SHA', () => {
    const layout = readRepoFile('apps/web/src/app/layout.tsx')
    expect(layout).toMatch(/NEXT_PUBLIC_COMMIT_SHA/)
  })
})

describe('the deploy actually supplies the stamp (#804)', () => {
  it('passes NEXT_PUBLIC_COMMIT_SHA to the Pages build step', () => {
    const yml = readRepoFile('.github/workflows/deploy.yml')
    expect(
      yml,
      'deploy.yml no longer sets NEXT_PUBLIC_COMMIT_SHA, so the built site renders the placeholder and the drift check can never work',
    ).toMatch(/NEXT_PUBLIC_COMMIT_SHA:/)
  })

  it('sets it in the env of the build, not of the upload', () => {
    // The value is inlined at compile time. Setting it on the `wrangler pages
    // deploy` step instead would be green, would look wired, and would ship an
    // unstamped site.
    const lines = readRepoFile('.github/workflows/deploy.yml').split('\n')
    const stamp = lines.findIndex((line) => line.includes('NEXT_PUBLIC_COMMIT_SHA:'))
    expect(stamp, 'no NEXT_PUBLIC_COMMIT_SHA line at all').toBeGreaterThan(-1)
    // Walk back to the `run:` this env block belongs to and check it is the build.
    const owningRun = lines
      .slice(0, stamp)
      .reverse()
      .find((line) => /^\s*run:/.test(line))
    expect(
      owningRun,
      'NEXT_PUBLIC_COMMIT_SHA is set on a step that is not the Pages build, so the compile-time inline never happens',
    ).toMatch(/pages:build/)
  })
})

/**
 * The reader half. A route is judged by pulling the stamp out of the HTML it
 * served, and that extraction is where the check can go quietly wrong: a matcher
 * that misses makes every route read as unstamped forever, and one that is too
 * loose can be satisfied by any mention of the name (L135, L156).
 */
const EXTRACT = path.join(REPO_ROOT, '.github/scripts/pages-commit-from-html.sh')

const extract = (html: string): string =>
  execFileSync('bash', [EXTRACT], { encoding: 'utf8', input: html }).trim()

const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'

describe('reading the stamp back out of a served page (#804)', () => {
  it('finds the commit in the tag the layout renders', () => {
    expect(extract(`<head><meta name="bidspoke-commit" content="${SHA}"/></head>`)).toBe(SHA)
  })

  it('finds it when the renderer emits the attributes in the other order', () => {
    // React has reordered these before. An extractor that only handles one order
    // would report every route unstamped after a framework upgrade.
    expect(extract(`<meta content="${SHA}" name="bidspoke-commit"/>`)).toBe(SHA)
  })

  it('finds it among the rest of a real head', () => {
    const html = `<!DOCTYPE html><html><head><meta charSet="utf-8"/><title>Bidspoke</title><meta name="description" content="Visual workflow builder"/><meta name="bidspoke-commit" content="${SHA}"/></head><body>hi</body></html>`
    expect(extract(html)).toBe(SHA)
  })

  it('reports unstamped when the page carries no stamp at all', () => {
    expect(extract('<html><head><title>Bidspoke</title></head></html>')).toBe('unstamped')
  })

  it('reports unstamped when the build left the placeholder in', () => {
    // An unset NEXT_PUBLIC_COMMIT_SHA renders `unknown`. That is a build with no
    // stamp, not a commit, and must never be compared against history as if it
    // were one.
    expect(extract('<meta name="bidspoke-commit" content="unknown"/>')).toBe('unstamped')
  })

  it('reports unstamped on an empty value rather than returning an empty string', () => {
    expect(extract('<meta name="bidspoke-commit" content=""/>')).toBe('unstamped')
  })

  it('reports unstamped for a value that is not a commit sha', () => {
    expect(extract('<meta name="bidspoke-commit" content="v1.4.2"/>')).toBe('unstamped')
  })

  it('is not satisfied by the name appearing in ordinary page text', () => {
    // The failure L135 and L156 describe: a match anywhere in a large document
    // answering for the thing that is actually missing. A docs page describing
    // this very mechanism must not read as a stamp.
    const html = '<html><body><p>The site stamps bidspoke-commit into every page.</p></body></html>'
    expect(extract(html)).toBe('unstamped')
  })

  it('reports unstamped on an empty response body', () => {
    expect(extract('')).toBe('unstamped')
  })
})
