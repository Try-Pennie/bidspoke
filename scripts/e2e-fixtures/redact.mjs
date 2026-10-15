/**
 * The one redaction of captured partners page responses (#2134), used by
 * capture-partners.mjs and checked by apps/web/e2e/partner-fixtures.test.ts.
 *
 * The fixtures are committed, so anything that identifies a person or works as
 * a credential is replaced before it is written (L155, L222), deterministically,
 * so a recapture of unchanged data writes the same bytes:
 *
 * - who last edited a row (updated_by, updated_by_email, updated_by_name)
 *   becomes Editor A, Editor B and so on, in order of first appearance. One
 *   person is one alias whichever of the three a row carries: a value already
 *   seen in any of them names the alias;
 * - a click route's address is a live webhook, which anyone holding it can call,
 *   so it becomes https://hooks.example.com/redacted/<route name>;
 * - a pasted sample response (last_probe_response) can hold a real lead's
 *   answer, so every text value in it becomes "redacted"; its keys, numbers and
 *   true or false stay, because they are the shape the extraction rules read.
 *
 * What stays is configuration the page shows and a person needs to recognise:
 * partner names and slugs, proxy endpoints on Pennie's own domain, the NAME of a
 * Worker secret (cf_secret_key holds the name, never the value), rules, caps and
 * a blackout date's note.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Editor A to Z, then A2 to Z2 and on, so an alias never repeats. */
const letterOf = (n) => `${LETTERS[n % 26]}${n >= 26 ? Math.floor(n / 26) + 1 : ''}`

/** Every text value in a sample response replaced, its shape kept. */
function redactSample(value) {
  if (typeof value === 'string') return 'redacted'
  if (Array.isArray(value)) return value.map(redactSample)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactSample(v)]))
  return value
}

/** A redactor whose editor aliases are stable across every row it is given. */
export function createRedactor() {
  const aliases = new Map()
  let next = 0
  const aliasOf = (values) => {
    const known = values.find((v) => aliases.has(v))
    const n = known !== undefined ? aliases.get(known) : next++
    for (const v of values) aliases.set(v, n)
    return n
  }
  return {
    partner(row) {
      const out = { ...row }
      const values = ['updated_by', 'updated_by_email', 'updated_by_name'].map((k) => row[k]).filter((v) => v !== null && v !== undefined && v !== '')
      if (values.length > 0) {
        const n = aliasOf(values)
        if ('updated_by' in out) out.updated_by = `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`
        if ('updated_by_email' in out) out.updated_by_email = `editor-${letterOf(n).toLowerCase()}@example.com`
        if ('updated_by_name' in out) out.updated_by_name = `Editor ${letterOf(n)}`
      }
      if ('last_probe_response' in out && out.last_probe_response !== null) out.last_probe_response = redactSample(out.last_probe_response)
      return out
    },
    profile(doc) {
      if (!doc || !doc.click_delivery || !Array.isArray(doc.click_delivery.routes)) return doc
      return {
        ...doc,
        click_delivery: {
          ...doc.click_delivery,
          routes: doc.click_delivery.routes.map((r) => ({ ...r, url: `https://hooks.example.com/redacted/${encodeURIComponent(r.name)}` })),
        },
      }
    },
  }
}

/** Every string in a value, so a test can assert nothing personal survived. */
export function stringsIn(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [k, ...stringsIn(v)])
  return []
}
