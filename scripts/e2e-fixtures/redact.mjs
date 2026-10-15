/**
 * The one redaction of captured partners page responses (#2134), used by
 * capture-partners.mjs and checked by apps/web/e2e/partner-fixtures.test.ts.
 *
 * The fixtures are committed, so anything that identifies a person or works as
 * a credential is replaced before it is written (L155, L222), deterministically,
 * so a recapture of unchanged data writes the same bytes:
 *
 * - who last edited a partner (updated_by, updated_by_email, updated_by_name)
 *   becomes Editor A, Editor B and so on, in order of first appearance;
 * - a click route's address is a live webhook, which anyone holding it can call,
 *   so it becomes https://hooks.example.com/redacted/<route name>.
 *
 * What stays is configuration the page shows and a person needs to recognise:
 * partner names and slugs, proxy endpoints on Pennie's own domain, the NAME of a
 * Worker secret (cf_secret_key holds the name, never the value), rules, caps and
 * sample responses.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** A redactor whose editor aliases are stable across every row it is given. */
export function createRedactor() {
  const editors = new Map()
  const aliasOf = (key) => {
    if (!editors.has(key)) editors.set(key, editors.size)
    return editors.get(key)
  }
  return {
    partner(row) {
      const out = { ...row }
      const key = row.updated_by ?? row.updated_by_email ?? row.updated_by_name
      if (key !== null && key !== undefined) {
        const n = aliasOf(key)
        if ('updated_by' in out) out.updated_by = `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`
        if ('updated_by_email' in out) out.updated_by_email = `editor-${LETTERS[n % 26].toLowerCase()}@example.com`
        if ('updated_by_name' in out) out.updated_by_name = `Editor ${LETTERS[n % 26]}`
      }
      return out
    },
    profile(doc) {
      if (!doc || !doc.click_delivery) return doc
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
